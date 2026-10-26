/* Lampa qBittorrent — MIT. Settings adapted from kostya4000/lampa-qbit.
 * https://github.com/kostya4000/lampa-qbit
 */
(function () {
    'use strict';

    var DEFAULTS = {
        url: '', user: '', pass: '', bypass: false, savepath: '', movie_path: '', series_path: '', category: '',
        rename: true, confirm: true, auto_cat_path: true
    };
    var busy = false;
    var submissionActivity;
    var submissionCard;
    var submissionType;
    var nativeSession;

    function notify(message) {
        Lampa.Noty.show(message);
    }

    function config() {
        var result = {};
        Object.keys(DEFAULTS).forEach(function (key) {
            var value = Lampa.Storage.get('qbit_' + key, DEFAULTS[key]);
            result[key] = typeof DEFAULTS[key] === 'boolean'
                ? value === true || value === 'true' : String(value || '');
        });
        result.url = result.url.trim().replace(/\/+$/, '');
        return result;
    }

    function cardMediaType() {
        var activity = Lampa.Activity.active();
        var movie = activity && activity.movie;
        if (!movie) return '';
        if (movie.media_type === 'tv') return 'series';
        if (movie.media_type === 'movie') return 'movie';
        if (movie.first_air_date || movie.number_of_seasons || movie.original_name || movie.name) return 'series';
        if (movie.release_date) return 'movie';
        return '';
    }

    function torrentLink(data) {
        var values = [data.MagnetUri, data.magnetUri, data.Magnet, data.magnet,
            data.Link, data.link, data.downloadUrl, data.DownloadUrl];
        var links = values.filter(function (value) {
            return typeof value === 'string' && !/[\r\n]/.test(value);
        }).map(function (value) { return value.trim(); });
        // A ready magnet avoids requiring the qBittorrent host to reach the indexer.
        return links.filter(function (value) { return /^magnet:\?\S+$/i.test(value); })[0]
            || links.filter(function (value) { return /^https?:\/\/[^\s]+$/i.test(value); })[0]
            || '';
    }

    function request(settings, path, body, contentType, callback) {
        var network = new Lampa.Reguest();
        var finished = false;
        var timer = setTimeout(function () {
            finish({ status: 0, timeout: true });
        }, 25000);
        function finish(error, response) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            network.clear();
            callback(error, response);
        }
        network.timeout(20000);
        try {
            var headers = { Referer: settings.url + '/' };
            if (contentType) headers['Content-Type'] = contentType;
            // Android native requests may not retain the Web UI session cookie.
            if (!settings.bypass) headers.Authorization = 'Basic '
                + btoa(unescape(encodeURIComponent(settings.user + ':' + settings.pass)));
            var nativeHeaders = Lampa.Platform && Lampa.Platform.is('android');
            var session;
            if (nativeHeaders) {
                var key = settings.url + '\n' + (headers.Authorization || 'bypass');
                if (!nativeSession || nativeSession.key !== key) nativeSession = { key: key, cookie: '' };
                session = nativeSession;
                if (session.cookie) headers.Cookie = session.cookie;
            }
            network.native(settings.url + path, function (response) {
                if (nativeHeaders) {
                    try {
                        var envelope = typeof response === 'string' ? JSON.parse(response) : response;
                        if (!envelope || !envelope.headers || typeof envelope.body !== 'string') throw new Error('Invalid native response');
                        var cookies = envelope.headers['set-cookie'] || envelope.headers['Set-Cookie'] || [];
                        if (!Array.isArray(cookies)) cookies = [cookies];
                        var sessionCookies = cookies.filter(function (cookie) { return typeof cookie === 'string'; })
                            .map(function (cookie) { return cookie.split(';')[0]; })
                            .filter(function (cookie) { return /^(?:SID|QBT_SID_\d+)=[^\r\n;]*$/.test(cookie); });
                        if (sessionCookies.length) session.cookie = sessionCookies.join('; ');
                        response = envelope.body;
                    } catch (error) { return finish({ invalid: true }); }
                }
                finish(null, response);
            }, function (error) {
                var status = Number(error && error.status);
                if (session && (status === 401 || status === 403)) session.cookie = '';
                // Some Android wrappers route every non-200 response to error.
                if (status >= 200 && status < 300) finish(null, error.responseText || '');
                else finish(error || { status: 0 });
            }, body, {
                dataType: 'text',
                returnHeaders: !!nativeHeaders,
                withCredentials: true,
                contentType: contentType || 'application/x-www-form-urlencoded',
                headers: headers,
                type: body ? 'POST' : 'GET'
            });
        } catch (error) {
            finish({ status: 0 });
        }
    }

    function reportError(error) {
        busy = false;
        var status = Number(error.status);
        if (error.invalid) {
            notify('qBittorrent вернул некорректный ответ. Проверьте адрес Web UI.');
        } else if (status === 401 || status === 403) {
            notify('qBittorrent: доступ запрещён. Проверьте авторизацию Web UI.');
        } else if (status === 415) {
            notify('qBittorrent: ссылка не вернула корректный торрент-файл.');
        } else if (status >= 400) {
            notify('qBittorrent: ошибка HTTP ' + status + '. Проверьте раздачу и настройки сервера.');
        } else {
            notify('Нет ответа qBittorrent. Проверьте сервер и список загрузок перед повтором.');
        }
    }

    function addBody(settings, link, title, selection) {
        var fields = { urls: link, paused: 'false', stopped: 'false', autoTMM: 'false' };
        if (selection) fields.filePriorities = selection.priorities.join(',');
        var savepath = settings.savepath;
        if (settings.category) {
            fields.category = settings.category;
            if (settings.auto_cat_path) {
                if (savepath) savepath = savepath.replace(/\/+$/, '') + '/' + settings.category.replace(/^\/+/, '');
                else fields.autoTMM = 'true';
            }
        }
        if (savepath) fields.savepath = savepath;
        if (settings.rename && title) fields.rename = title;
        var boundary = 'LampaQbit' + Date.now() + Math.random().toString(16).slice(2);
        var body = Object.keys(fields).map(function (key) {
            return '--' + boundary + '\r\nContent-Disposition: form-data; name="' + key
                + '"\r\n\r\n' + fields[key] + '\r\n';
        }).join('') + '--' + boundary + '--\r\n';
        // OkHttp appends charset otherwise; qBittorrent requires boundary to be last.
        return { body: body, contentType: 'multipart/form-data; charset=utf-8; boundary=' + boundary };
    }

    function readTorrents(settings, callback) {
        request(settings, '/api/v2/torrents/info', null, null, function (error, response) {
            if (error) return callback(error);
            try {
                var torrents = typeof response === 'string' ? JSON.parse(response) : response;
                if (!Array.isArray(torrents) || torrents.some(function (torrent) {
                    return !torrent || typeof torrent.hash !== 'string' || typeof torrent.name !== 'string';
                })) throw new Error('Invalid torrent list');
            } catch (error) { return callback({ invalid: true }); }
            callback(null, torrents);
        });
    }

    function torrentStatus(torrent) {
        var states = {
            downloading: 'Скачивается', forcedDL: 'Скачивается', stalledDL: 'Ожидает пиров',
            metaDL: 'Получает список файлов', forcedMetaDL: 'Получает список файлов',
            queuedDL: 'В очереди', pausedDL: 'На паузе', stoppedDL: 'Остановлено',
            checkingDL: 'Проверяется', checkingUP: 'Проверяется', checkingResumeData: 'Проверяется',
            allocating: 'Выделяется место', moving: 'Перемещается',
            uploading: 'Раздаётся', forcedUP: 'Раздаётся', stalledUP: 'Скачано',
            queuedUP: 'Скачано · в очереди на раздачу', pausedUP: 'Скачано · на паузе',
            stoppedUP: 'Скачано · остановлено', error: 'Ошибка', missingFiles: 'Файлы не найдены'
        };
        return states[torrent.state] || 'Неизвестный статус';
    }

    function progress(torrent) {
        return Math.floor(Math.max(0, Math.min(1, Number(torrent.progress) || 0)) * 100);
    }

    function magnetHash(link) {
        var match = /[?&]xt=urn:btih:([a-f0-9]{40})(?:&|$)/i.exec(link);
        return match ? match[1].toLowerCase() : '';
    }

    function showConfirmed(torrent, existed) {
        busy = false;
        rememberTorrent(submissionCard, submissionType, torrent.hash);
        notify((existed ? 'Уже добавлено' : 'Добавлено') + ' · ' + torrentStatus(torrent)
            + ' · ' + progress(torrent) + '%');
        if (Lampa.Activity.active() !== submissionActivity || Lampa.Controller.enabled().name !== 'content') return;
        Lampa.Select.show({
            title: 'qBittorrent',
            items: [{ title: 'Открыть загрузки', open: true }, { title: 'Продолжить выбор раздач' }],
            onSelect: function (item) {
                Lampa.Controller.toggle('content');
                if (item.open) openDownloads();
            },
            onBack: function () { Lampa.Controller.toggle('content'); }
        });
    }

    function confirm(settings, link, title, before, result) {
        if (!settings.confirm) {
            busy = false;
            notify('Запрос принят qBittorrent. Проверьте список загрузок.');
            return;
        }
        var hash = magnetHash(link);
        var ids = result && Array.isArray(result.added_torrent_ids) ? result.added_torrent_ids : [];
        var attempts = 0;
        notify('Ожидаю появления раздачи в qBittorrent…');
        function poll() {
            readTorrents(settings, function (error, torrents) {
                if (error) {
                    busy = false;
                    return notify('Запрос отправлен, но проверить добавление не удалось. Откройте qBittorrent в меню.');
                }
                var matches = torrents.filter(function (torrent) {
                    if (hash) return torrent.hash.toLowerCase() === hash;
                    if (ids.length) return ids.indexOf(torrent.hash) !== -1;
                    // Pending URL adds have no ID: only match the exact name we assigned, never an arbitrary new torrent.
                    return settings.rename && title && torrent.name === title
                        && !before.some(function (old) { return old.hash === torrent.hash; });
                });
                if (matches.length === 1) {
                    return showConfirmed(matches[0], before.some(function (old) { return old.hash === matches[0].hash; }));
                }
                if (++attempts < 10) return setTimeout(poll, 2000);
                busy = false;
                notify('Добавление пока не подтверждено. Откройте qBittorrent в меню перед повторной отправкой.');
            });
        }
        poll();
    }

    function sendTorrent(data, selection) {
        if (busy) return notify('Дождитесь ответа qBittorrent.');
        if (selection && (!validHash(selection.hash) || !Array.isArray(selection.priorities)
            || !selection.priorities.length || selection.priorities.indexOf(1) === -1
            || selection.priorities.some(function (priority) { return priority !== 0 && priority !== 1; }))) {
            return notify('Некорректный выбор файлов. Загрузка не запущена.');
        }
        var link = torrentLink(data);
        if (!link) return notify('У раздачи нет magnet или HTTP(S)-ссылки на торрент.');
        var settings = config();
        if (!validSettings(settings)) return;
        var separatePath = data.qbitMediaType === 'series' ? settings.series_path
            : data.qbitMediaType === 'movie' ? settings.movie_path : '';
        if (separatePath.trim()) {
            separatePath = separatePath.trim();
            var absolutePath = /^(?:[\\/]|[a-z]:[\\/])/i.test(separatePath);
            var basePath = settings.savepath.trim();
            if (!absolutePath && !basePath) {
                return notify('Для относительной папки фильмов или сериалов укажите базовый путь сохранения.');
            }
            settings.savepath = absolutePath ? separatePath
                : basePath.replace(/[\\/]+$/, '') + '/' + separatePath;
            settings.auto_cat_path = false;
        }
        var title = String(data.Title || data.title || '').trim();
        submissionActivity = Lampa.Activity.active();
        submissionCard = data.qbitCard;
        submissionType = data.qbitMediaType;
        busy = true;
        notify('Отправляю в qBittorrent…');
        function add(before) {
            var existing = before.filter(function (torrent) { return torrent.hash.toLowerCase() === (selection ? selection.hash.toLowerCase() : magnetHash(link)); })[0];
            if (existing) return showConfirmed(existing, true);
            var payload = addBody(settings, link, title, selection);
            request(settings, '/api/v2/torrents/add', payload.body, payload.contentType, function (error, response) {
                if (error) return reportError(error);
                var result = response;
                if (typeof result === 'string' && result.trim() === 'Ok.') return confirm(settings, link, title, before);
                try { if (typeof result === 'string') result = JSON.parse(result); }
                catch (parseError) { result = null; }
                if (result && result.failure_count > 0) {
                    busy = false;
                    return notify('qBittorrent не смог добавить торрент. Проверьте ссылку и список загрузок.');
                }
                if (result && (result.success_count > 0 || result.pending_count > 0)) {
                    return confirm(settings, link, title, before, result);
                }
                busy = false;
                notify('qBittorrent не подтвердил приём ссылки. Проверьте сервер и раздачу.');
            });
        }
        connect(settings, function () {
            if (!settings.confirm && !selection) return add([]);
            readTorrents(settings, function (error, torrents) {
                if (error) return reportError(error);
                add(torrents);
            });
        });
    }

    function cardKey(card, type) {
        if (!card || !/^\d+$/.test(String(card.id || '')) || (card.source && card.source !== 'tmdb')) return '';
        if (type !== 'movie' && type !== 'series') return '';
        return type + ':' + card.id;
    }

    function jellyRequest(path, callback) {
        var url = String(Lampa.Storage.get('qbit_jelly_url', '') || '').trim().replace(/\/+$/, '');
        var token = String(Lampa.Storage.get('qbit_jelly_token', '') || '').trim();
        if (!/^https?:\/\/[^\s]+$/i.test(url) || !token) return callback({ missing: true });
        var network = new Lampa.Reguest();
        var finished = false;
        var timer = setTimeout(function () { finish({ timeout: true }); }, 10000);
        function finish(error, body) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            network.clear();
            if (error) return callback(error);
            var result;
            try {
                if (Lampa.Platform && Lampa.Platform.is('android')) {
                    var envelope = typeof body === 'string' ? JSON.parse(body) : body;
                    body = envelope.body;
                }
                result = typeof body === 'string' ? JSON.parse(body) : body;
                if (!result || !Array.isArray(result.Items)) throw new Error('Invalid Jellyfin response');
            } catch (error) { return callback({ invalid: true }); }
            callback(null, result);
        }
        network.timeout(8000);
        try {
            network.native(url + path, function (body) { finish(null, body); }, function (error) { finish(error || {}); }, null, {
                dataType: 'text', returnHeaders: !!(Lampa.Platform && Lampa.Platform.is('android')),
                headers: { 'X-Emby-Token': token }, type: 'GET'
            });
        } catch (error) { finish({ invalid: true }); }
    }

    function lookupJellyfin(card, type, callback) {
        var key = cardKey(card, type);
        if (!key) return callback({ invalid: true });
        var matches = [], start = 0;
        function page() {
            jellyRequest('/Items?Recursive=true&IncludeItemTypes=' + (type === 'series' ? 'Series' : 'Movie')
                + '&Fields=ProviderIds&Limit=200&StartIndex=' + start, function (error, result) {
                if (error) return callback(error);
                if (!Number.isInteger(result.TotalRecordCount) || result.TotalRecordCount < 0) return callback({ invalid: true });
                result.Items.forEach(function (item) {
                    if (item.ProviderIds && String(item.ProviderIds.Tmdb || '') === String(card.id)) matches.push(item);
                });
                start += result.Items.length;
                if (start < result.TotalRecordCount && result.Items.length) return page();
                if (start < result.TotalRecordCount || matches.length > 1) return callback({ invalid: true });
                if (!matches.length) return callback(null, { found: false, episodes: {} });
                if (type !== 'series') return callback(null, { found: true, episodes: {} });
                var id = matches[0].Id;
                if (!/^[a-f0-9-]{32,36}$/i.test(id || '')) return callback({ invalid: true });
                jellyRequest('/Shows/' + id + '/Episodes?IsMissing=false&EnableImages=false', function (episodeError, result) {
                    if (episodeError) return callback(episodeError);
                    if (Number.isInteger(result.TotalRecordCount) && result.TotalRecordCount > result.Items.length) return callback({ invalid: true });
                    var episodes = {};
                    result.Items.forEach(function (item) {
                        if (Number.isInteger(item.ParentIndexNumber) && Number.isInteger(item.IndexNumber)) {
                            episodes[item.ParentIndexNumber + ':' + item.IndexNumber] = true;
                        }
                    });
                    callback(null, { found: true, episodes: episodes });
                });
            });
        }
        page();
    }

    function rememberTorrent(card, type, hash) {
        var key = cardKey(card, type);
        if (!key || !validHash(hash)) return;
        var saved = Lampa.Storage.get('qbit_card_hashes', {});
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
        var hashes = Array.isArray(saved[key]) ? saved[key] : [];
        if (hashes.indexOf(hash) === -1) hashes.push(hash);
        saved[key] = hashes;
        Lampa.Storage.set('qbit_card_hashes', saved);
    }

    function showCardStatus(event) {
        var card = event.data && event.data.movie;
        var type = !card ? '' : card.media_type === 'movie' ? 'movie' : card.media_type === 'tv' ? 'series'
            : card.first_air_date || card.number_of_seasons || card.original_name ? 'series' : card.release_date ? 'movie' : '';
        var key = cardKey(card, type);
        if (!key || !event.body || !event.body.find) return;
        var target = event.body.find('.full-start-new__buttons');
        if (!target.length) return;
        target.find('.qbit-card-status').remove();
        target.append('<div class="qbit-card-status" style="font-size:0.85em;opacity:0.8;align-self:center;margin:0.5em"></div>');
        var status = target.find('.qbit-card-status');
        var qbitText = 'qBittorrent: нет подтверждённых загрузок';
        var jellyText = 'Jellyfin: проверка…';
        function render() { status.text(qbitText + ' · ' + jellyText); }
        render();
        var saved = Lampa.Storage.get('qbit_card_hashes', {});
        var hashes = saved && Array.isArray(saved[key]) ? saved[key] : [];
        if (hashes.length) {
            var settings = config();
            if (/^https?:\/\/[^\s]+$/i.test(settings.url) && (settings.bypass || settings.user)) {
                connect(settings, function () {
                    readTorrents(settings, function (error, torrents) {
                        if (error) qbitText = 'qBittorrent: не удалось проверить';
                        else {
                            var match = torrents.filter(function (torrent) { return hashes.indexOf(torrent.hash) !== -1; })[0];
                            qbitText = match ? torrentStatus(match) + ' · ' + progress(match) + '%' : 'qBittorrent: загрузка не найдена';
                        }
                        render();
                    });
                }, function () { qbitText = 'qBittorrent: не удалось подключиться'; render(); });
            } else qbitText = 'qBittorrent: проверьте настройки';
        }
        lookupJellyfin(card, type, function (error, result) {
            jellyText = error ? (error.missing ? 'Jellyfin: не настроен' : 'Jellyfin: не удалось проверить')
                : result.found ? 'Есть в Jellyfin' : 'Jellyfin: не найдено по TMDB';
            render();
        });
    }

    function safeText(value) {
        return String(value).replace(/[&<>"']/g, function (character) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
        });
    }

    function validHash(hash) {
        return typeof hash === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash);
    }

    function deleteTorrent(settings, torrent, deleteFiles, updated) {
        if (busy) return notify('Дождитесь ответа qBittorrent.');
        if (!validHash(torrent.hash)) return notify('Некорректный идентификатор торрента. Обновите список.');
        Lampa.Select.show({
            title: deleteFiles ? 'Удалить торрент и файлы с диска?' : 'Удалить торрент из списка?',
            items: [
                { title: 'Отмена', selected: true },
                { title: deleteFiles ? 'Удалить торрент и файлы' : 'Удалить только торрент',
                    subtitle: safeText(torrent.name) + (deleteFiles ? '<br>Файлы будут удалены с диска без возможности отмены.' : '<br>Файлы останутся на диске.'), remove: true }
            ],
            onSelect: function (item) {
                Lampa.Controller.toggle('content');
                if (!item.remove) return;
                if (busy) return notify('Дождитесь ответа qBittorrent.');
                busy = true;
                request(settings, '/api/v2/torrents/delete', 'hashes=' + encodeURIComponent(torrent.hash)
                    + '&deleteFiles=' + (deleteFiles ? 'true' : 'false'), 'application/x-www-form-urlencoded', function (error) {
                    if (error) return reportError(error);
                    readTorrents(settings, function (error, torrents) {
                        busy = false;
                        if (error || torrents.some(function (entry) { return entry.hash === torrent.hash; })) {
                            notify('Удаление пока не подтверждено. Обновите список перед повтором.');
                        } else notify(deleteFiles ? 'Торрент удалён; серверу передано удаление файлов.' : 'Торрент удалён. Файлы сохранены.');
                        updated();
                    });
                });
            },
            onBack: function () { Lampa.Controller.toggle('content'); }
        });
    }

    function torrentActions(settings, torrent, updated) {
        Lampa.Select.show({
            title: 'qBittorrent',
            items: [
                { title: 'Назад', subtitle: safeText(torrent.name), selected: true },
                { title: 'Удалить торрент и файлы', remove: true, files: true },
                { title: 'Удалить торрент', remove: true, files: false }
            ],
            onSelect: function (item) {
                if (item.remove) deleteTorrent(settings, torrent, item.files, updated);
                else Lampa.Controller.toggle('content');
            },
            onBack: function () { Lampa.Controller.toggle('content'); }
        });
    }

    function chooseDownload(data) {
        if (busy) return notify('Дождитесь ответа qBittorrent.');
        if (data.qbitMediaType === 'movie') return sendTorrent(data);
        Lampa.Select.show({
            title: 'Что скачать?',
            items: [
                { title: 'Выбрать серии / файлы', files: true, selected: true },
                { title: 'Скачать целиком', all: true },
                { title: 'Отмена' }
            ],
            onSelect: function (item) {
                Lampa.Controller.toggle('content');
                if (item.files) prepareFiles(data);
                else if (item.all) sendTorrent(data);
            },
            onBack: function () { Lampa.Controller.toggle('content'); }
        });
    }

    function prepareFiles(data) {
        if (busy) return notify('Дождитесь ответа qBittorrent.');
        var settings = config();
        var link = torrentLink(data);
        if (!link) return notify('У раздачи нет magnet или HTTP(S)-ссылки на торрент.');
        if (!validSettings(settings)) return;
        var cancelled = false, timer, deadline, attempts = 0;
        var activity = Lampa.Activity.active();
        busy = true;
        function cancel() {
            cancelled = true;
            clearTimeout(timer);
            clearTimeout(deadline);
            busy = false;
            Lampa.Controller.toggle('content');
        }
        function current() {
            if (cancelled) return false;
            if (Lampa.Activity.active() !== activity) {
                cancelled = true;
                clearTimeout(timer);
                clearTimeout(deadline);
                busy = false;
                return false;
            }
            return true;
        }
        function fail(message) {
            if (!current()) return;
            Lampa.Select.hide();
            cancel();
            notify(message);
        }
        Lampa.Select.show({
            title: 'Получаем список файлов…',
            items: [{ title: 'Отмена', subtitle: 'Загрузка серий ещё не запущена. Для magnet нужны доступные пиры.' }],
            onSelect: cancel,
            onBack: cancel
        });
        function poll() {
            if (!current()) return;
            // fetchMetadata decodes source once more after form decoding.
            request(settings, '/api/v2/torrents/fetchMetadata', 'source=' + encodeURIComponent(encodeURIComponent(link)),
                'application/x-www-form-urlencoded', function (error, response) {
                if (!current()) return;
                if (error) return fail(Number(error.status) === 404
                    ? 'Выбор файлов требует qBittorrent 5.3 или новее. Загрузка не запущена.'
                    : 'Не удалось получить список файлов. Загрузка не запущена.');
                var metadata;
                try { metadata = typeof response === 'string' ? JSON.parse(response) : response; }
                catch (error) { return fail('Некорректный список файлов. Загрузка не запущена.'); }
                if (!metadata || typeof metadata !== 'object') return fail('Некорректный ответ qBittorrent.');
                if (metadata.info) {
                    var files = metadata.info.files;
                    if (!validHash(metadata.hash) || !Array.isArray(files) || !files.length || files.some(function (file) {
                        return !file || typeof file.path !== 'string' || !isFinite(file.length) || file.length < 0;
                    })) return fail('Некорректный список файлов. Загрузка не запущена.');
                    function openPicker(jelly) {
                        if (!current()) return;
                        clearTimeout(deadline);
                        busy = false;
                        Lampa.Select.hide();
                        selectFiles(data, metadata, jelly);
                    }
                    if (data.qbitCard && data.qbitMediaType === 'series') {
                        return lookupJellyfin(data.qbitCard, 'series', function (error, jelly) {
                            openPicker(error ? null : jelly);
                        });
                    }
                    return openPicker(null);
                }
                if (++attempts >= 30) return fail('Список файлов пока недоступен. Загрузка не запущена; попробуйте позже.');
                timer = setTimeout(poll, 2000);
            });
        }
        deadline = setTimeout(function () { fail('Не удалось получить список файлов за 60 секунд. Загрузка не запущена.'); }, 60000);
        connect(settings, poll, function () { fail('Не удалось подключиться к qBittorrent. Загрузка не запущена.'); });
    }

    function episodeNumber(path) {
        if (!/\.(?:mkv|mp4|avi|m4v|mov|ts|m2ts|webm)$/i.test(path)) return null;
        var match = /(?:^|[^a-z0-9])s(\d{1,3})[ ._-]*e(\d{1,3})(?!\d|[ ._-]*e\d|[ ._-]*-\s*\d)/i.exec(path)
            || /(?:^|[^a-z0-9])(\d{1,3})x(\d{1,3})(?!\d)/i.exec(path);
        if (!match) return null;
        return { season: Number(match[1]), episode: Number(match[2]) };
    }

    function selectFiles(data, metadata, jelly) {
        var files = metadata.info.files.map(function (file, index) {
            var episode = episodeNumber(file.path);
            var title = episode ? 'S' + (episode.season < 10 ? '0' : '') + episode.season
                + 'E' + (episode.episode < 10 ? '0' : '') + episode.episode : file.path;
            var present = episode && jelly && jelly.episodes[episode.season + ':' + episode.episode];
            return { title: safeText(title) + (present ? ' · Есть в Jellyfin' : ''), subtitle: safeText(file.path) + ' · ' + (Number(file.length) / 1048576).toFixed(1) + ' МБ',
                checkbox: true, checked: false, index: index, episode: episode };
        });
        var latest = files.filter(function (file) { return file.episode; }).sort(function (a, b) {
            return b.episode.season - a.episode.season || b.episode.episode - a.episode.episode || a.index - b.index;
        })[0];
        // Sort only the display list: qBittorrent priorities follow metadata indices.
        var displayFiles = files.slice().sort(function (a, b) {
            return metadata.info.files[b.index].path.localeCompare(metadata.info.files[a.index].path, undefined, { numeric: true, sensitivity: 'base' })
                || a.index - b.index;
        });
        function show() {
            var actions = [{ title: 'Скачать выбранные', download: true }];
            if (latest) actions.push({ title: 'Выбрать последнюю серию · ' + latest.title, latest: true });
            actions.push({ title: 'Отмена' });
            Lampa.Select.show({
                title: 'Выберите серии / файлы',
                items: actions.concat(displayFiles),
                onSelect: function (item) {
                    Lampa.Controller.toggle('content');
                    if (item.latest) {
                        latest.checked = true;
                        return show();
                    }
                    if (!item.download) return;
                    if (!files.some(function (file) { return file.checked; })) {
                        notify('Выберите хотя бы один файл.');
                        return show();
                    }
                    sendTorrent(data, { hash: metadata.hash, priorities: files.map(function (file) { return file.checked ? 1 : 0; }) });
                },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }
        show();
    }

    function validSettings(settings) {
        if (!/^https?:\/\/[^\s]+$/i.test(settings.url)) {
            notify('Укажите адрес Web UI в Настройки → qBittorrent.');
            return false;
        }
        if (!settings.bypass && !settings.user) {
            notify('Укажите логин qBittorrent или настроенный обход авторизации.');
            return false;
        }
        return true;
    }

    function connect(settings, callback, onError) {
        onError = onError || reportError;
        function verifySession() {
            request(settings, '/api/v2/app/version', null, null, function (error, version) {
                if (error) return onError(error);
                if (!/^v?\d+\.\d+/.test(String(version).trim())) {
                    return onError({ invalid: true });
                }
                callback(String(version).trim());
            });
        }
        if (settings.bypass) return callback();
        request(settings, '/api/v2/auth/login', 'username=' + encodeURIComponent(settings.user)
            + '&password=' + encodeURIComponent(settings.pass), 'application/x-www-form-urlencoded', function (error, response) {
            if (error) return onError(error);
            // qBittorrent 5.2+ uses HTTP 204; check the session, not just the body.
            if (response != null && String(response).trim() !== '' && String(response).trim() !== 'Ok.') {
                return onError({ status: 401 });
            }
            verifySession();
        });
    }

    function testConnection() {
        if (busy) return notify('Дождитесь ответа qBittorrent.');
        var settings = config();
        if (!validSettings(settings)) return;
        busy = true;
        notify('Проверяю подключение…');
        function done(version) {
            busy = false;
            notify('Подключено к qBittorrent ' + version);
        }
        if (settings.bypass) {
            request(settings, '/api/v2/app/version', null, null, function (error, version) {
                if (error) return reportError(error);
                if (!/^v?\d+\.\d+/.test(String(version).trim())) {
                    busy = false;
                    return notify('Адрес не вернул версию qBittorrent. Проверьте Web UI.');
                }
                done(String(version).trim());
            });
        } else connect(settings, done);
    }

    function openDownloads() {
        Lampa.Activity.push({ component: 'qbit_downloads', title: 'qBittorrent' });
    }

    function speed(value) {
        value = Math.max(0, Number(value) || 0);
        return value >= 1048576 ? (value / 1048576).toFixed(1) + ' МБ/с'
            : Math.round(value / 1024) + ' КБ/с';
    }

    function remaining(torrent) {
        var seconds = Number(torrent.eta);
        if (progress(torrent) === 100) return 'Завершено';
        if (!isFinite(seconds) || seconds <= 0 || seconds >= 8640000) return 'Время неизвестно';
        var minutes = Math.ceil(seconds / 60);
        return minutes < 60 ? minutes + ' мин' : Math.floor(minutes / 60) + ' ч ' + minutes % 60 + ' мин';
    }

    function sortTorrents(torrents) {
        return torrents.slice().sort(function (a, b) {
            var complete = Number(a.progress >= 1) - Number(b.progress >= 1);
            return complete || (Number(b.added_on) || 0) - (Number(a.added_on) || 0)
                || a.hash.localeCompare(b.hash);
        });
    }

    function Downloads() {
        var self = this;
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var html = $('<div class="qbit-downloads"></div>');
        var body = $('<div style="padding:1em 1.5em"></div>');
        var refresh = $('<div class="selector qbit-refresh">Обновить</div>');
        var message = $('<div class="qbit-message"></div>');
        var rows = $('<div></div>');
        var last = refresh[0];
        var active = false, destroyed = false, loading = false, connected = false;
        var timer, generation = 0;
        var settings;

        function schedule() {
            clearTimeout(timer);
            if (active && !destroyed) timer = setTimeout(load, 5000);
        }
        function focus() {
            Lampa.Controller.collectionSet(scroll.render());
            Lampa.Controller.collectionFocus(last, scroll.render());
        }
        function moveRow(step) {
            var items = body.find('.selector').toArray();
            var index = items.indexOf(last) + step;
            if (index < 0) return Lampa.Controller.toggle('head');
            if (index < items.length) Lampa.Controller.collectionFocus(items[index], scroll.render());
        }
        function load() {
            if (!active || destroyed || loading) return;
            clearTimeout(timer);
            loading = true;
            var current = generation;
            message.text('Обновление…');
            function finish(error, torrents) {
                if (destroyed || current !== generation) return;
                loading = false;
                if (error) {
                    connected = false;
                    message.text('Не удалось обновить список. Показаны последние данные. Проверьте подключение в настройках qBittorrent.');
                    if (Number(error.status) !== 401 && Number(error.status) !== 403 && !error.invalid) schedule();
                    return;
                }
                var selectedHash = $(last).attr('data-hash');
                rows.empty();
                sortTorrents(torrents).forEach(function (torrent) {
                    var row = $('<div class="selector qbit-row"></div>').attr('data-hash', torrent.hash);
                    $('<div class="qbit-name"></div>').text(torrent.name).appendTo(row);
                    $('<div class="qbit-details"></div>').text(torrentStatus(torrent) + ' · ' + progress(torrent)
                        + '% · ↓ ' + speed(torrent.dlspeed) + ' · ' + remaining(torrent)).appendTo(row);
                    $('<div class="qbit-progress"><div></div></div>').find('div').css('width', progress(torrent) + '%').end().appendTo(row);
                    row.on('hover:focus', function () { last = row[0]; scroll.update(row, true); });
                    row.on('hover:enter hover:long', function () { torrentActions(settings, torrent, load); });
                    rows.append(row);
                    if (torrent.hash === selectedHash) last = row[0];
                });
                if (!selectedHash || !rows.find('.selector').toArray().some(function (row) { return row === last; })) last = refresh[0];
                message.text(torrents.length ? 'Загрузок: ' + torrents.length + ' · Обновлено ' + new Date().toLocaleTimeString()
                    : 'Загрузок пока нет. Отправьте раздачу через долгое ОК → В qBittorrent.');
                if (active && Lampa.Controller.enabled().name === 'content') focus();
                schedule();
            }
            function fetchList() {
                if (destroyed || current !== generation) return;
                connected = true;
                readTorrents(settings, finish);
            }
            if (connected) fetchList();
            else connect(settings, fetchList, finish);
        }
        this.create = function () {
            body.append(refresh, message, rows);
            scroll.append(body);
            html.append(scroll.render());
            refresh.on('hover:focus', function () { last = refresh[0]; scroll.update(refresh, true); });
            refresh.on('hover:enter', load);
            this.activity.loader(false);
            this.activity.toggle();
            return this.render();
        };
        this.start = function () {
            active = true;
            settings = config();
            Lampa.Controller.add('content', {
                link: self,
                toggle: focus,
                left: function () { Lampa.Controller.toggle('menu'); },
                right: function () {},
                up: function () { moveRow(-1); },
                down: function () { moveRow(1); },
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
            if (validSettings(settings)) load();
            else message.text('Укажите адрес и авторизацию в Настройки → qBittorrent.');
        };
        this.pause = this.stop = function () {
            active = false;
            generation++;
            loading = false;
            clearTimeout(timer);
        };
        this.render = function () { return html; };
        this.destroy = function () {
            self.stop();
            destroyed = true;
            scroll.destroy();
            html.remove();
        };
    }

    function registerDownloads() {
        if (!Lampa.Component || !Lampa.Menu) return;
        Lampa.Component.add('qbit_downloads', Downloads);
        $('<style>.qbit-refresh{display:inline-block;padding:.7em 1em;border-radius:.3em;background:#343434}'
            + '.qbit-refresh.focus,.qbit-row.focus{outline:.15em solid #fff}'
            + '.qbit-message{padding:1em 0;opacity:.75}.qbit-row{padding:1em;margin:.3em 0 .8em;border-radius:.4em;background:rgba(255,255,255,.08)}'
            + '.qbit-name{font-size:1.15em;line-height:1.35;overflow-wrap:anywhere}.qbit-details{margin:.5em 0;opacity:.85}'
            + '.qbit-progress{height:.3em;border-radius:.2em;background:#555}.qbit-progress>div{height:100%;background:#65dfb1;border-radius:.2em}</style>').appendTo('head');
        Lampa.Menu.addButton('<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11 3h2v10l4-4 1.4 1.4L12 17l-6.4-6.6L7 9l4 4V3zM4 19h16v2H4z"/></svg>', 'qBittorrent', openDownloads);
    }

    var watchCard;
    var watchFallback = false;
    var watchButtons = {
        onGroupButtons: function () {
            if (watchFallback || !Lampa.Storage.get('qbit_watch_torrents', false)) return;
            var card = this;
            var play = card.html.find('.button--play');
            play.off('hover:enter').on('hover:enter', function () {
                var torrent = card.html.find('.view--torrent').not('.hide');
                if (Lampa.Storage.get('qbit_watch_torrents', false) && torrent.length) {
                    torrent.first().trigger('hover:enter');
                } else {
                    // Let Lampa build its own source menu, including other plugins.
                    watchFallback = true;
                    try {
                        card.emit('groupButtons');
                        play.trigger('hover:enter');
                    } finally {
                        watchFallback = false;
                        card.emit('groupButtons');
                    }
                }
            });
        }
    };

    function initialize() {
        if (!window.Lampa || !Lampa.Listener || !Lampa.SettingsApi || !Lampa.Reguest) return;
        if (window.tvPluginsQbit) return;
        window.tvPluginsQbit = true;
        registerSettings();
        if (window.appready) registerDownloads();
        else Lampa.Listener.follow('app', function (event) {
            if (event.type === 'ready') registerDownloads();
        });
        Lampa.Listener.follow('full', function (event) {
            if (event && event.type === 'complite') showCardStatus(event);
            if (event && event.type === 'build' && event.name === 'start' && event.item && typeof event.item.use === 'function') {
                watchCard = event.item;
                watchCard.use(watchButtons);
            }
        });
        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'onlong' || !event.element || !Array.isArray(event.menu)) return;
            if (event.menu.some(function (item) { return item.tvPluginsQbit; })) return;
            var controller = Lampa.Controller.enabled().name;
            var activity = Lampa.Activity.active();
            var data = Object.assign({}, event.element, { qbitMediaType: cardMediaType(), qbitCard: activity && activity.movie });
            event.menu.unshift({
                title: 'В qBittorrent',
                tvPluginsQbit: true,
                onSelect: function () {
                    Lampa.Controller.toggle(controller);
                    chooseDownload(data);
                }
            });
        });
    }

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) {
                console.error('[qBittorrent] Lampa.SettingsApi недоступен');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_watch_torrents', type: 'trigger', default: false },
                field: { name: 'Смотреть → Торренты', description: 'Сразу открывать торренты вместо меню источников. Если торренты недоступны, откроется обычное меню.' },
                onChange: function () { if (watchCard) watchCard.emit('groupButtons'); }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_jelly_url', type: 'input', values: '', default: '' },
                field: { name: 'Адрес Jellyfin', description: 'Адрес сервера Jellyfin для проверки библиотеки' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_jelly_token', type: 'input', values: '', default: '' },
                field: { name: 'Токен доступа Jellyfin', description: 'Токен хранится в настройках Lampa на этом устройстве.' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_test', type: 'button' },
                field: { name: 'Проверить подключение', description: 'Проверить вход без добавления торрента' },
                onChange: testConnection
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_url', type: 'input', values: '', default: DEFAULTS.url },
                field: { name: 'Адрес сервера', description: 'Адрес Web UI qBittorrent (например: http://192.168.1.50:8080)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_user', type: 'input', values: '', default: DEFAULTS.user },
                field: { name: 'Логин', description: 'Логин (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_pass', type: 'input', values: '', default: DEFAULTS.pass },
                field: { name: 'Пароль', description: 'Пароль (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_bypass', type: 'trigger', default: DEFAULTS.bypass },
                field: { name: 'Обход аутентификации', description: 'Включён обход аутентификации для подсети' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_savepath', type: 'input', values: '', default: DEFAULTS.savepath },
                field: { name: 'Базовый путь сохранения', description: 'Базовый путь (например: /app/qBittorrent). Пусто = по умолчанию сервера' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_movie_path', type: 'input', values: '', default: DEFAULTS.movie_path },
                field: { name: 'Папка для фильмов', description: 'Например Movies — внутри базового пути, или полный путь на сервере qBittorrent. Пусто = базовый путь.' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_series_path', type: 'input', values: '', default: DEFAULTS.series_path },
                field: { name: 'Папка для сериалов', description: 'Например Shows — внутри базового пути, или полный путь на сервере qBittorrent. Применяется и к отдельным сериям.' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_category', type: 'input', values: '', default: DEFAULTS.category },
                field: { name: 'Категория', description: 'Категория для торрентов (например: video)' }
            });

            // Keep the previous plugin's storage keys for existing installations.
            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_auto_cat_path', type: 'trigger', default: DEFAULTS.auto_cat_path },
                field: {
                    name: 'Автоматически добавлять категорию к пути',
                    description: 'Сохранять торренты в подпапку категории (например, /app/qBittorrent/video). Если путь не задан — включает автоуправление в qBittorrent.'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_rename', type: 'trigger', default: DEFAULTS.rename },
                field: { name: 'Переименовывать', description: 'Переименовывать торрент в название раздачи' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_confirm', type: 'trigger', default: DEFAULTS.confirm },
                field: { name: 'Проверять добавление', description: 'Проверять, что торрент добавился' }
            });


        } catch (e) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', e);
        }
    }

    if (window.Lampa && Lampa.Listener) initialize();
    else document.addEventListener('appready', initialize);
})();
