/* Lampa qBittorrent — MIT. Settings adapted from kostya4000/lampa-qbit.
 * https://github.com/kostya4000/lampa-qbit
 */
(function () {
    'use strict';

    var DEFAULTS = {
        url: '', user: '', pass: '', bypass: false, savepath: '', category: '',
        rename: true, confirm: true, auto_cat_path: true
    };
    var busy = false;

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
            network.native(settings.url + path, function (response) {
                finish(null, response);
            }, function (error) {
                var status = Number(error && error.status);
                // Some Android wrappers route every non-200 response to error.
                if (status >= 200 && status < 300) finish(null, error.responseText || '');
                else finish(error || { status: 0 });
            }, body, {
                dataType: 'text',
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
        if (status === 401 || status === 403) {
            notify('qBittorrent: доступ запрещён. Проверьте авторизацию Web UI.');
        } else if (status === 415) {
            notify('qBittorrent: ссылка не вернула корректный торрент-файл.');
        } else if (status >= 400) {
            notify('qBittorrent: ошибка HTTP ' + status + '. Проверьте раздачу и настройки сервера.');
        } else {
            notify('Нет ответа qBittorrent. Проверьте сервер и список загрузок перед повтором.');
        }
    }

    function addBody(settings, link, title) {
        var fields = { urls: link, paused: 'false', stopped: 'false', autoTMM: 'false' };
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

    function confirm(settings, link) {
        // Lampa's generic `hash` is sometimes a UI/cache key, not an infohash.
        var match = /[?&]xt=urn:btih:([a-f0-9]{40})(?:&|$)/i.exec(link);
        if (!settings.confirm || !match) {
            busy = false;
            notify('Запрос принят qBittorrent. Проверьте список загрузок.');
            return;
        }
        var attempts = 0;
        function poll() {
            request(settings, '/api/v2/torrents/info?hashes=' + match[1].toLowerCase(), null, null, function (error, response) {
                var torrents;
                try { torrents = typeof response === 'string' ? JSON.parse(response) : response; }
                catch (parseError) { torrents = null; }
                if (!error && Array.isArray(torrents) && torrents.some(function (torrent) {
                    return String(torrent.hash).toLowerCase() === match[1].toLowerCase();
                })) {
                    busy = false;
                    notify('Торрент есть в qBittorrent ✔');
                } else if (!error && ++attempts < 3) {
                    setTimeout(poll, 1000);
                } else {
                    busy = false;
                    notify('Запрос принят, но наличие торрента не подтверждено. Проверьте qBittorrent.');
                }
            });
        }
        poll();
    }

    function sendTorrent(data) {
        if (busy) return notify('Дождитесь ответа qBittorrent.');
        var link = torrentLink(data);
        if (!link) return notify('У раздачи нет magnet или HTTP(S)-ссылки на торрент.');
        var settings = config();
        if (!validSettings(settings)) return;
        busy = true;
        notify('Отправляю в qBittorrent…');
        function add() {
            var payload = addBody(settings, link, data.Title || data.title || '');
            request(settings, '/api/v2/torrents/add', payload.body, payload.contentType, function (error, response) {
                if (error) return reportError(error);
                var result = response;
                if (typeof result === 'string' && result.trim() === 'Ok.') return confirm(settings, link);
                try { if (typeof result === 'string') result = JSON.parse(result); }
                catch (parseError) { result = null; }
                busy = false;
                if (result && result.failure_count > 0) {
                    return notify('qBittorrent не смог добавить торрент. Проверьте ссылку и список загрузок.');
                }
                if (result && result.success_count > 0) {
                    return notify('Добавлено в qBittorrent ✔');
                }
                if (result && result.pending_count > 0) {
                    return notify('qBittorrent получает торрент по ссылке. Проверьте список загрузок.');
                }
                notify('qBittorrent не подтвердил приём ссылки. Проверьте сервер и раздачу.');
            });
        }
        connect(settings, add);
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

    function connect(settings, callback) {
        function verifySession() {
            request(settings, '/api/v2/app/version', null, null, function (error, version) {
                if (error) return reportError(error);
                if (!/^v?\d+\.\d+/.test(String(version).trim())) {
                    busy = false;
                    return notify('Адрес не вернул версию qBittorrent. Проверьте Web UI.');
                }
                callback(String(version).trim());
            });
        }
        if (settings.bypass) return callback();
        request(settings, '/api/v2/auth/login', 'username=' + encodeURIComponent(settings.user)
            + '&password=' + encodeURIComponent(settings.pass), 'application/x-www-form-urlencoded', function (error, response) {
            if (error) return reportError(error);
            // qBittorrent 5.2+ uses HTTP 204; check the session, not just the body.
            if (response != null && String(response).trim() !== '' && String(response).trim() !== 'Ok.') {
                busy = false;
                return notify('qBittorrent: не удалось войти. Проверьте логин и пароль.');
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

    function initialize() {
        if (!window.Lampa || !Lampa.Listener || !Lampa.SettingsApi || !Lampa.Reguest) return;
        if (window.tvPluginsQbit) return;
        window.tvPluginsQbit = true;
        registerSettings();
        Lampa.Listener.follow('torrent', function (event) {
            if (!event || event.type !== 'onlong' || !event.element || !Array.isArray(event.menu)) return;
            if (event.menu.some(function (item) { return item.tvPluginsQbit; })) return;
            var controller = Lampa.Controller.enabled().name;
            event.menu.push({
                title: 'В qBittorrent',
                tvPluginsQbit: true,
                onSelect: function () {
                    Lampa.Controller.toggle(controller);
                    sendTorrent(event.element);
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
