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
    const context = vm.createContext({ Lampa, window: { Lampa }, document: { addEventListener() {} },
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
    assert.match(app.notices.at(-1), /не удалось войти/);
});

test('successful login uses credentialed native transport then multipart add', () => {
    const app = setup({ qbit_bypass: false, qbit_user: 'user', qbit_pass: 'secret' }, ['Ok.', 'v4.6.7', 'Ok.']);
    app.send({ MagnetUri: magnet, Title: 'Title' });
    assert.equal(app.requests.length, 3);
    const request = app.requests[2];
    assert.equal(request.options.withCredentials, true);
    assert.match(request.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
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
    const app = setup({ qbit_confirm: true }, ['Ok.', '[]', JSON.stringify([{ hash: 'a'.repeat(40) }])]);
    app.send({ MagnetUri: magnet });
    app.tick();
    assert.equal(app.requests.length, 3);
    assert.match(app.notices.at(-1), /✔/);
    assert.equal(app.requests.filter(request => request.url.endsWith('/add')).length, 1);
});

test('HTTP links and base32 magnets do not use unrelated UI hash for confirmation', () => {
    for (const link of ['https://indexer.test/download', 'magnet:?xt=urn:btih:' + 'A'.repeat(32)]) {
        const app = setup({ qbit_confirm: true });
        app.send({ Link: link, hash: 'b'.repeat(40) });
        assert.equal(app.requests.length, 1);
        assert.match(app.notices.at(-1), /Проверьте список/);
    }
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
    assert.match(app.notices.at(-1), /Добавлено/);
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
    assert.match(app.notices.at(-1), /получает торрент/);
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
