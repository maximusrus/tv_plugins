const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../qbittorrent.js'), 'utf8');
const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);

function setup(storage = {}, replies = ['Ok.']) {
    const requests = [], notices = [], controllers = [], params = [], timers = new Map();
    let listener, timerId = 0;
    const Lampa = {
        Storage: { get: (key, fallback) => ({ qbit_url: 'http://qbit.test:8080', qbit_bypass: true, qbit_confirm: false, ...storage })[key] ?? fallback },
        Activity: { active: () => 'torrents', push() {} },
        Select: { show() {} },
        Noty: { show: message => notices.push(message) },
        SettingsApi: { addComponent() {}, addParam(param) { params.push(param); } },
        Listener: { follow: (name, callback) => { assert.equal(name, 'torrent'); listener = callback; } },
        Controller: { enabled: () => ({ name: 'content' }), toggle: name => controllers.push(name) },
        Reguest: function () {
            this.timeout = () => {};
            this.clear = () => {};
            this.native = (url, success, error, body, options) => {
                requests.push({ url, body, options, success, error });
                const reply = replies.shift();
                if (reply && reply.error) error(reply.error);
                else if (reply !== undefined) success(reply);
            };
        }
    };
    const context = vm.createContext({ Lampa, window: { Lampa, appready: true }, document: { addEventListener() {} },
        btoa: value => Buffer.from(value, 'binary').toString('base64'), unescape,
        console, setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id) });
    vm.runInContext(source, context);
    function menu(data) {
        const event = { type: 'onlong', element: data, menu: [{ title: 'Existing' }] };
        listener(event);
        return event;
    }
    return { requests, notices, controllers, params, timers, context, listener, menu,
        send: data => menu(data).menu[1].onSelect(),
        tick: () => { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); } };
}

test('adds one long-OK action, preserves existing menu and restores controller', () => {
    const app = setup();
    const event = app.menu({ MagnetUri: magnet });
    app.listener(event);
    assert.equal(event.menu.length, 2);
    assert.equal(event.menu[1].title, 'В qBittorrent');
    event.menu[1].onSelect();
    assert.deepEqual(app.controllers, ['content']);
    const render = { type: 'render', element: {}, menu: [] };
    app.listener(render);
    assert.equal(render.menu.length, 0);
});

test('accepts HTTP download URL without .torrent suffix and preserves query string', () => {
    const app = setup();
    app.send({ MagnetUri: '', Link: 'https://indexer.test/download?id=12&token=example' });
    assert.match(app.requests[0].body, /https:\/\/indexer.test\/download\?id=12&token=example/);
    assert.match(app.notices.at(-1), /Запрос принят/);
    assert.equal(app.requests.length, 1);
});

test('prefers magnet over HTTP, handles aliases and trims surrounding spaces', () => {
    for (const key of ['MagnetUri', 'magnetUri', 'Magnet', 'magnet', 'Link', 'link', 'downloadUrl', 'DownloadUrl']) {
        const app = setup();
        app.send({ Link: 'https://indexer.test/download', [key]: '  ' + magnet + '  ' });
        assert.ok(app.requests[0].body.includes(magnet));
    }
});

test('rejects missing, unsafe and multiline links; never turns UI hash into magnet', () => {
    for (const data of [{}, { hash: 'a'.repeat(40) }, { Link: 'javascript:alert(1)' }, { Link: 'file:///tmp/x' },
        { Link: 'https://indexer.test/a\nhttps://indexer.test/b' }]) {
        const app = setup();
        app.send(data);
        assert.equal(app.requests.length, 0);
        assert.match(app.notices.at(-1), /нет magnet/);
    }
});

test('failed login never submits torrent; password whitespace is preserved', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'user', qbit_pass: ' secret ' }, ['Fails.']);
    app.send({ MagnetUri: magnet });
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].body, 'username=user&password=%20secret%20');
    assert.match(app.notices.at(-1), /доступ запрещён/);
});

test('successful login uses credentialed native transport then multipart add', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'user', qbit_pass: 'secret' }, ['Ok.', 'v4.6.7', 'Ok.']);
    app.send({ MagnetUri: magnet, Title: 'Title' });
    assert.equal(app.requests.length, 3);
    const request = app.requests[2];
    assert.equal(request.options.withCredentials, true);
    assert.match(request.options.headers['Content-Type'], /^multipart\/form-data; charset=utf-8; boundary=/);
    const boundary = request.options.headers['Content-Type'].split('boundary=')[1];
    assert.ok(request.body.endsWith('--' + boundary + '--\r\n'));
    assert.match(request.body, /name="rename"\r\n\r\nTitle/);
});

test('preserves savepath/category settings and qBittorrent 4/5 start flags', () => {
    const app = setup({ qbit_category: 'video', qbit_savepath: '/downloads/' });
    app.send({ Link: 'https://indexer.test/download' });
    const body = app.requests[0].body;
    assert.match(body, /name="savepath"\r\n\r\n\/downloads\/video/);
    assert.match(body, /name="autoTMM"\r\n\r\nfalse/);
    assert.match(body, /name="paused"\r\n\r\nfalse/);
    assert.match(body, /name="stopped"\r\n\r\nfalse/);
    const auto = setup({ qbit_category: 'video' });
    auto.send({ MagnetUri: magnet });
    assert.match(auto.requests[0].body, /name="autoTMM"\r\n\r\ntrue/);
});

test('HTTP errors and unexpected responses never claim success or retry add', () => {
    for (const reply of [{ error: { status: 403 } }, { error: { status: 415 } }, 'Fails.', '<html>Login</html>']) {
        const app = setup({}, [reply]);
        app.send({ MagnetUri: magnet });
        assert.equal(app.requests.length, 1);
        assert.doesNotMatch(app.notices.at(-1), /Запрос принят|✔/);
    }
});

test('suppresses duplicate submissions and ignores late reply after timeout', () => {
    const app = setup({}, []);
    app.send({ MagnetUri: magnet });
    app.send({ MagnetUri: magnet });
    assert.equal(app.requests.length, 1);
    app.tick();
    assert.match(app.notices.at(-1), /перед повтором/);
    app.requests[0].success('Ok.');
    assert.match(app.notices.at(-1), /перед повтором/);
});

test('confirms exact infohash, polls without resubmitting torrent', () => {
    const app = setup({ qbit_confirm: true }, ['[]', 'Ok.', '[]', JSON.stringify([{ hash: 'a'.repeat(40), name: 'Test', state: 'downloading', progress: 0.2 }])]);
    app.send({ MagnetUri: magnet });
    app.tick();
    assert.equal(app.requests.length, 4);
    assert.match(app.notices.at(-1), /Добавлено.*Скачивается.*20%/);
    assert.equal(app.requests.filter(request => request.url.endsWith('/add')).length, 1);
});

test('unrelated UI hashes and torrents never confirm a submission', () => {
    const unrelated = [{ hash: 'b'.repeat(40), name: 'Other' }];
    const app = setup({ qbit_confirm: true }, [[], 'Ok.', ...Array(10).fill(unrelated)]);
    app.send({ Link: 'https://indexer.test/download', hash: 'b'.repeat(40), Title: 'Expected' });
    for (let i = 0; i < 9; i++) app.tick();
    assert.match(app.notices.at(-1), /пока не подтверждено/);
    assert.equal(app.requests.filter(r => r.url.endsWith('/add')).length, 1);
});

test('loading script twice does not register a second listener', () => {
    const app = setup();
    app.context.Lampa.Listener.follow = () => assert.fail('duplicate registration');
    vm.runInContext(source, app.context);
});


test('204 empty login verifies authenticated session before adding', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'admin' }, ['', 'v5.3.0', JSON.stringify({success_count: 1, pending_count: 0, failure_count: 0, added_torrent_ids: ['a'.repeat(40)]})]);
    app.send({ MagnetUri: magnet });
    assert.equal(app.requests.length, 3);
    assert.ok(app.requests[1].url.endsWith('/app/version'));
    assert.match(app.notices.at(-1), /Запрос принят/);
});

test('empty login without working session never adds', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'admin' }, ['', {error: {status: 403}}]);
    app.send({ MagnetUri: magnet });
    assert.equal(app.requests.length, 2);
    assert.equal(app.requests.some(r => r.url.endsWith('/add')), false);
    assert.match(app.notices.at(-1), /доступ запрещён/);
});

test('native non-200 success callbacks support 204 login and 202 queued add', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'admin' }, [{error:{status:204, responseText:''}}, 'v5.3.0', {error:{status:202, responseText:JSON.stringify({success_count:0,pending_count:1,failure_count:0,added_torrent_ids:[]})}}]);
    app.send({ Link: 'https://indexer.test/download' });
    assert.equal(app.requests.length, 3);
    assert.match(app.notices.at(-1), /Запрос принят/);
});

test('structured failure is not reported as success', () => {
    const app = setup({}, [JSON.stringify({success_count:0,pending_count:0,failure_count:1,added_torrent_ids:[]})]);
    app.send({ MagnetUri: magnet });
    assert.match(app.notices.at(-1), /не смог добавить/);
});

test('string HTTP status is reported accurately', () => {
    const app = setup({}, [{error: {status:'401'}}]);
    app.send({ MagnetUri: magnet });
    assert.match(app.notices.at(-1), /доступ запрещён/);
});

test('connection test logs in and reads version without submitting torrents', () => {
    const app = setup({qbit_bypass:false,qbit_user:'admin'}, ['', 'v5.3.0']);
    const action = app.params.find(p => p.param.name === 'qbit_test');
    assert.ok(action);
    action.onChange();
    assert.equal(app.requests.length, 2);
    assert.match(app.notices.at(-1), /Подключено.*v5.3.0/);
    assert.equal(app.requests.some(r => r.url.endsWith('/add')), false);
});


test('native requests carry UTF-8 Basic authorization and matching Referer without cookies', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'admin', qbit_pass: 'пароль!' }, ['', 'v5.3.0', { success_count: 1 }]);
    app.send({ MagnetUri: magnet });
    assert.equal(app.requests.length, 3);
    for (const request of app.requests) {
        assert.equal(request.options.headers.Authorization, 'Basic ' + Buffer.from('admin:пароль!').toString('base64'));
        assert.equal(request.options.headers.Referer, 'http://qbit.test:8080/');
    }
    const bypass = setup();
    bypass.send({ MagnetUri: magnet });
    assert.equal(bypass.requests[0].options.headers.Authorization, undefined);
});


test('Android OkHttp keeps multipart boundary last so qBittorrent can parse it', () => {
    const app = setup();
    app.send({ Link: 'http://indexer.test/download?id=12', Title: 'Тест & sample' });
    const request = app.requests[0];
    const contentType = request.options.headers['Content-Type'];
    // Mirrors RequestBody.create(MediaType, String) in the TV Android client.
    const wireContentType = /charset=/i.test(contentType) ? contentType : contentType + '; charset=utf-8';
    const delimiter = wireContentType.split('boundary=')[1];
    assert.equal(request.options.contentType, contentType);
    assert.ok(request.body.startsWith('--' + delimiter + '\r\n'));
    assert.ok(request.body.endsWith('--' + delimiter + '--\r\n'));
    assert.ok(request.body.includes('Тест & sample'));
});


test('pending HTTP addition waits for exact renamed torrent and ignores unrelated arrivals', () => {
    const other = {hash:'b'.repeat(40), name:'Other'};
    const expected = {hash:'c'.repeat(40), name:'Expected', state:'stalledDL', progress:0};
    const app = setup({qbit_confirm:true}, [[], {pending_count:1}, [other], [other,expected]]);
    app.send({Link:'http://indexer.test/download',Title:'Expected'});
    assert.match(app.notices.at(-1), /Ожидаю/);
    app.tick();
    assert.match(app.notices.at(-1), /Добавлено.*Ожидает пиров/);
});

test('duplicate magnet is reported with progress without submitting again', () => {
    const app = setup({qbit_confirm:true}, [[{hash:'a'.repeat(40),name:'Existing',state:'downloading',progress:0.24}]]);
    app.send({MagnetUri:magnet});
    assert.match(app.notices.at(-1), /Уже добавлено.*24%/);
    assert.equal(app.requests.some(r=>r.url.endsWith('/add')),false);
});

test('returned ID confirms HTTP addition even when rename is disabled', () => {
    const hash = 'c'.repeat(40);
    const app = setup({qbit_confirm:true,qbit_rename:false}, [[], {success_count:1,added_torrent_ids:[hash]}, [{hash,name:'Original',state:'stoppedDL',progress:0}]]);
    app.send({Link:'http://indexer.test/download'});
    assert.match(app.notices.at(-1), /Добавлено.*Остановлено/);
});

test('failed confirmation does not retry the add or claim success', () => {
    const app = setup({qbit_confirm:true}, [[], {pending_count:1}, {error:{status:500}}]);
    app.send({Link:'http://indexer.test/download'});
    assert.match(app.notices.at(-1), /проверить добавление не удалось/);
    assert.equal(app.requests.filter(r=>r.url.endsWith('/add')).length,1);
});


function viewHelpers() {
    const context = vm.createContext({window:{},document:{addEventListener(){}},console});
    vm.runInContext(source.replace('    function initialize() {',
        '    window.helpers = {torrentStatus, progress, speed, remaining, sortTorrents}; function initialize() {'),context);
    return context.window.helpers;
}

test('download view maps stalled, stopped, missing and completed states honestly', () => {
    const view = viewHelpers();
    assert.equal(view.torrentStatus({state:'stalledDL'}),'Ожидает пиров');
    assert.equal(view.torrentStatus({state:'stoppedDL'}),'Остановлено');
    assert.equal(view.torrentStatus({state:'missingFiles'}),'Файлы не найдены');
    assert.equal(view.torrentStatus({state:'stalledUP'}),'Скачано');
    assert.equal(view.torrentStatus({state:'futureState'}),'Неизвестный статус');
});

test('progress and ETA do not claim completion before 100 percent', () => {
    const view = viewHelpers();
    assert.equal(view.progress({progress:0.99999}),99);
    assert.equal(view.progress({progress:-1}),0);
    assert.equal(view.progress({progress:2}),100);
    assert.equal(view.remaining({progress:0.5,eta:8640000}),'Время неизвестно');
    assert.equal(view.remaining({progress:0.5,eta:3660}),'1 ч 1 мин');
    assert.equal(view.speed(3145728),'3.0 МБ/с');
});

test('unfinished downloads precede completed ones without mutating the API response', () => {
    const view = viewHelpers();
    const list = [{hash:'done',progress:1,added_on:30},{hash:'old',progress:0.1,added_on:10},{hash:'new',progress:0.2,added_on:20}];
    assert.equal(view.sortTorrents(list).map(t=>t.hash).join(','),'new,old,done');
    assert.equal(list[0].hash,'done');
});

test('confirmation does not open a dialog over a different activity', () => {
    const app = setup({qbit_confirm:true}, [[], {pending_count:1}, []]);
    app.context.Lampa.Select.show=()=>assert.fail('dialog opened over another activity');
    app.send({Link:'http://indexer.test/download',Title:'Expected'});
    app.context.Lampa.Activity.active=()=> 'other-screen';
    app.tick();
    app.requests.at(-1).success([{hash:'c'.repeat(40),name:'Expected',state:'downloading',progress:0}]);
    assert.match(app.notices.at(-1), /Добавлено/);
});


test('sidebar registration waits for app ready while torrent action registers immediately', () => {
    const app = setup();
    const listeners = {};
    app.context.window.tvPluginsQbit=false;
    app.context.window.appready=false;
    app.context.Lampa.Listener.follow=(name,callback)=>listeners[name]=callback;
    vm.runInContext(source.replace('    function registerDownloads() {',
        '    function registerDownloads() { window.registered = true; return;'),app.context);
    assert.equal(app.context.window.registered,undefined);
    assert.equal(typeof listeners.torrent,'function');
    listeners.app({type:'ready'});
    assert.equal(app.context.window.registered,true);
});
