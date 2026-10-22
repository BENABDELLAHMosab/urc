// Tests isolés : aucun réseau, secret réel, accès aux bases ou fichier généré.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash, webcrypto} = require('node:crypto');
const {inspect} = require('node:util');
const ts = require('typescript');
const {createElement} = require('react');
const {Provider} = require('react-redux');
const {MemoryRouter, createRoutesFromElements, matchRoutes} = require('react-router-dom');
const {renderToStaticMarkup} = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const fixture = {
    id: 1,
    username: 'fixture-user',
    password: 'fixture-password',
    email: 'fixture@example.invalid',
    externalId: 'fixture-external-id',
};
const unknownToken = '00000000-0000-4000-8000-000000000001';

function memoryStorage() {
    const values = new Map([
        ['token', 'stale-fixture-session'],
        ['externalId', 'stale-fixture-identity'],
        ['username', 'stale-fixture-user'],
        ['unrelated', 'preserved'],
    ]);
    return {
        values,
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
    };
}

function harness(options = {}) {
    let now = 0;
    const clockBase = Date.now();
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clockBase + now])); }
        static now() { return clockBase + now; }
    }
    const logs = [];
    const sessions = new Map();
    const messageSets = new Map();
    const calls = {get: 0, set: 0, hset: 0, list: 0, update: 0, beams: 0, insert: 0, release: 0, eval: 0, lookup: 0,
        roomList: 0, roomInsert: 0, roomLookup: 0, push: []};
    const rooms = new Map((options.roomRows ?? [{room_id: 1, name: 'General', created_by: 4},
        {room_id: 2, name: 'News', created_by: 4}, {room_id: 3, name: 'Random', created_by: 4}])
        .map(room => [room.room_id, {...room}]));
    const users = new Map([[fixture.username, {user_id: fixture.id, username: fixture.username,
        email: fixture.email, external_id: fixture.externalId,
        password: createHash('sha256').update(fixture.username + fixture.password).digest('base64')}]]);
    const storage = options.storage || memoryStorage();
    const sensitive = [fixture.password, fixture.email, 'fixture-beams-token'];
    const redis = {
        async get(key) {
            calls.get++;
            if (options.redisError) throw options.redisError;
            const entry = sessions.get(key);
            return entry && entry.expiresAt > now ? entry.user : null;
        },
        async set(key, user, {ex}) {
            calls.set++;
            sensitive.push(key);
            sessions.set(key, {user, expiresAt: now + ex * 1000, ttl: ex});
        },
        async hset() { calls.hset++; },
        async eval(script, keys, args) {
            calls.eval++;
            if (options.messageError) throw options.messageError;
            assert.equal(keys.length, 1);
            const key = keys[0];
            if (messageSets.get(key)?.expiresAt <= now) messageSets.delete(key);
            if (script.includes("'ZADD'")) {
                assert.match(script, /'EXPIRE'/);
                assert.match(script, /'ZREMRANGEBYRANK'/);
                const [json, score, ttl, cutoff, limit] = args;
                const entry = messageSets.get(key) ?? {values: new Map()};
                entry.values.set(json, score);
                entry.expiresAt = now + ttl * 1000;
                for (const [member, time] of entry.values) if (time <= cutoff) entry.values.delete(member);
                const sorted = [...entry.values].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
                for (const [member] of sorted.slice(0, Math.max(0, sorted.length - limit))) entry.values.delete(member);
                messageSets.set(key, entry);
                return 1;
            }
            if (options.evalRows !== undefined) return options.evalRows;
            const entry = messageSets.get(key);
            if (!entry) return [];
            const [cutoff, limit] = args;
            for (const [member, time] of entry.values) if (time <= cutoff) entry.values.delete(member);
            if (entry.values.size === 0) messageSets.delete(key);
            return [...entry.values].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
                .slice(-limit).map(([member]) => member);
        },
    };
    const sql = async (parts, ...values) => {
        if (options.sqlError) throw options.sqlError;
        const query = parts.join('?').trim().toLowerCase();
        if (query.startsWith('select room_id, name from rooms')) {
            calls.roomList++; const rows = [...rooms.values()]; return {rowCount: rows.length, rows};
        }
        if (query.startsWith('select room_id from rooms where room_id')) {
            calls.roomLookup++; const rows = rooms.has(values[0]) ? [rooms.get(values[0])] : [];
            return {rowCount: rows.length, rows};
        }
        if (query.startsWith('insert into rooms')) {
            calls.roomInsert++;
            if (options.roomInsertError) throw options.roomInsertError;
            if ([...rooms.values()].some(room => room.name === values[0])) throw Object.assign(new Error('Unique violation'), {code: '23505'});
            const room = {room_id: Math.max(0, ...rooms.keys()) + 1, name: values[0], created_by: values[1], created_on: new ClockDate().toISOString()};
            rooms.set(room.room_id, room); return {rowCount: 1, rows: [room]};
        }
        if ((query.startsWith('select user_id from users where user_id') || query.startsWith('select user_id, external_id from users where user_id'))) {
            calls.lookup++;
            const rows = (options.userRows ?? [...users.values()]).filter(user => user.user_id === values[0]);
            return {rowCount: rows.length, rows};
        }
        if (query.startsWith('select user_id from users where')) {
            const rows = [...users.values()].filter(row => row.username === values[0] || row.email === values[1]);
            return {rowCount: rows.length, rows};
        }
        if (query.startsWith('insert into users')) {
            calls.insert++;
            if (options.insertError) throw options.insertError;
            if ([...users.values()].some(row => row.username === values[0] || row.email === values[2])) {
                throw Object.assign(new Error('Unique violation'), {code: '23505'});
            }
            const row = {user_id: users.size + 1, username: values[0], password: values[1],
                email: values[2], created_on: new Date().toISOString(), external_id: values[3]};
            users.set(row.username, row);
            sensitive.push(row.password);
            return {rowCount: 1, rows: [{user_id: row.user_id, username: row.username}]};
        }
        calls.list++;
        const rows = options.userRows ?? [{user_id: fixture.id, username: fixture.username, last_login: null}];
        return {rowCount: rows.length, rows};
    };
    const db = {
        async connect() {
            if (options.dbError) throw options.dbError;
            return {
                release() { calls.release++; },
                async sql(parts, ...values) {
                    if (parts.join('?').startsWith('select')) {
                        const row = users.get(values[0]);
                        return {rowCount: row ? 1 : 0, rows: row ? [row] : []};
                    }
                    calls.update++;
                    return {rowCount: 1};
                },
            };
        },
    };
    class FakeBeams {
        async publishToUsers(users, payload) {
            calls.push.push({users, payload, writes: calls.eval});
            if (options.pushPending) await options.pushPending;
            if (options.pushError) throw options.pushError;
        }
        generateToken() {
            calls.beams++;
            return {token: 'fixture-beams-token'};
        }
    }
    const cache = new Map();
    const dependencies = {
        '@upstash/redis': {Redis: {fromEnv: () => redis}},
        '@vercel/postgres': {db, sql},
        '@pusher/push-notifications-server': {default: FakeBeams},
        '@reduxjs/toolkit': require('@reduxjs/toolkit'),
        'react-redux': options.reactRedux || require('react-redux'),
        'react-router-dom': {...require('react-router-dom'), ...options.reactRouter, useLocation: options.reactRouter ? () => ({state: null}) : require('react-router-dom').useLocation},
        '@node-rs/argon2': require('@node-rs/argon2'),
        'validator/lib/isEmail.js': require('validator/lib/isEmail.js'),
        'node:crypto': require('node:crypto'),
        react: {...require('react'), ...options.react},
        'react/jsx-runtime': require('react/jsx-runtime'),
    };
    function load(relativePath) {
        let filename = path.resolve(root, relativePath);
        if (!path.extname(filename)) {
            filename = ['.js', '.jsx', '.ts', '.tsx'].map(ext => filename + ext)
                .find(candidate => fs.existsSync(candidate));
        }
        if (!filename || !filename.startsWith(root + path.sep)) {
            throw new Error('Module outside test scope');
        }
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = {exports: {}};
        cache.set(filename, module);
        const code = ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', 'process.env'), {
            fileName: filename,
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX, allowJs: true},
        }).outputText;
        vm.runInNewContext(code, {
            module, exports: module.exports,
            require(name) {
                if (Object.hasOwn(dependencies, name)) return dependencies[name];
                if (name.endsWith('.css')) return {};
                if (name.startsWith('.')) {
                    return load(path.relative(root, path.resolve(path.dirname(filename), name)));
                }
                throw new Error('Unmocked dependency');
            },
            Headers, Request, Response, Error, AbortController, DOMException, Buffer, crypto: webcrypto, btoa, Date: ClockDate,
            setTimeout: options.browser?.setTimeout ?? setTimeout,
            clearTimeout: options.browser?.clearTimeout ?? clearTimeout,
            document: options.browser?.document,
            window: options.browser?.window,
            navigator: options.browser?.navigator,
            FormData: options.FormData || FormData,
            process: {loadEnvFile() {
                calls.localConfig = (calls.localConfig ?? 0) + 1;
                if (options.localEnv === undefined) throw new Error('NO_LOCAL_CONFIG');
                const values = require('node:util').parseEnv(options.localEnv);
                for (const [key, value] of Object.entries(values)) {
                    if (this.env[key] === undefined) this.env[key] = value;
                }
            }, env: {PUSHER_INSTANCE_ID: 'fixture-instance', PUSHER_SECRET_KEY: 'fixture-key', ...options.env}},
            console: Object.fromEntries(['log', 'error', 'warn'].map(method => [method,
                (...args) => logs.push(args)])),
            sessionStorage: storage,
            fetch: options.fetch || (async (url, init) => {
                const address = new URL(url, 'https://urc.invalid');
                const route = address.pathname;
                assert.equal(['/api/login', '/api/me', '/api/register', '/api/users', '/api/message', '/api/rooms', '/api/room-messages'].includes(route), true);
                const module = load(route.slice(1) + '.js');
                if (['/api/message', '/api/rooms', '/api/room-messages'].includes(route)) {
                    const response = nodeResponse();
                    await module.default({method: init?.method ?? 'GET', headers: init?.headers ?? {},
                        body: init?.body, query: Object.fromEntries(address.searchParams)}, response);
                    return new Response(JSON.stringify(response.payload), {status: response.statusCode, headers: response.headers});
                }
                return (route === '/api/me' || route === '/api/users' ? module.default : module.default.fetch)(new Request('https://urc.invalid' + url, init));
            }),
        }, {filename});
        return module.exports;
    }
    return {
        load, storage, sessions, calls, users, messageSets, rooms, logs,
        advance(milliseconds) { now += milliseconds; },
        assertSafeLogs(extra = []) {
            const output = inspect(logs);
            assert.equal([...sensitive, ...extra].some(value => output.includes(value)), false,
                'Sensitive data must not be logged');
        },
    };
}

function loginRequest(password = fixture.password) {
    return new Request('https://urc.invalid/api/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: fixture.username, password}),
    });
}

function protectedRequest(token) {
    return {headers: token ? {Authorization: `Bearer ${token}`} : {}};
}

function nodeResponse() {
    return {
        statusCode: 200, replies: 0, payload: undefined,
        headers: {},
        setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; this.replies++; return this; },
        send(payload) { this.payload = payload; this.replies++; return this; },
    };
}

function assertStorageCleared(storage) {
    for (const key of ['token', 'externalId', 'username']) {
        assert.equal(storage.values.has(key), false, 'Authentication storage must be cleared');
    }
    assert.equal(storage.values.get('unrelated'), 'preserved');
}

async function frontendLogin(h, password = fixture.password) {
    const successes = [];
    const errors = [];
    await h.load('src/user/loginApi.ts').loginUser(
        {user_id: -1, username: fixture.username, password},
        session => successes.push(session), error => errors.push(error));
    return {successes, errors};
}

test('valid login keeps the hash contract, Redis TTL and protected access', async () => {
    const h = harness();
    const response = await h.load('api/login.js').default.fetch(loginRequest());
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(typeof session.token, 'string');
    assert.equal(h.sessions.get(session.token).ttl, 3600);
    assert.equal(h.calls.update, 1);
    assert.equal(h.calls.hset, 1);
    const users = await h.load('api/users.js').default(protectedRequest(session.token));
    assert.equal(users.status, 200);
    assert.equal((await users.json())[0].username, fixture.username);
    h.assertSafeLogs();
});

test('invalid credentials return 401 without creating a session', async () => {
    const h = harness();
    const response = await h.load('api/login.js').default.fetch(loginRequest('wrong-fixture-password'));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'UNAUTHORIZED');
    assert.equal(h.calls.set, 0);
    assert.equal(h.calls.update, 0);
    h.assertSafeLogs();
});

test('expired session returns 401 rather than 500', async () => {
    const h = harness();
    const login = await h.load('api/login.js').default.fetch(loginRequest());
    const session = await login.json();
    h.advance(3600001);
    const response = await h.load('api/users.js').default(protectedRequest(session.token));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'UNAUTHORIZED');
    assert.equal(h.calls.list, 0);
    h.assertSafeLogs();
});

test('unknown session returns 401', async () => {
    const h = harness();
    const response = await h.load('api/users.js').default(protectedRequest(unknownToken));
    assert.equal(response.status, 401);
    h.assertSafeLogs([unknownToken]);
});

test('missing or malformed Bearer values are refused before reading Redis', async () => {
    const h = harness();
    for (const authorization of ['', 'Bearer', 'Bearer ', unknownToken,
        `Basic ${unknownToken}`, 'Bearer users', `Bearer ${unknownToken} extra`]) {
        const response = await h.load('api/users.js').default({headers: {Authorization: authorization}});
        assert.equal(response.status, 401);
    }
    assert.equal((await h.load('api/users.js').default({headers: {}})).status, 401);
    assert.equal(h.calls.get, 0);
    h.assertSafeLogs([unknownToken]);
});

test('malformed Redis session data is refused', async () => {
    const h = harness();
    for (const user of [null, false, 'invalid', [], {}, {username: fixture.username}]) {
        h.sessions.set(unknownToken, {user, expiresAt: 1000});
        const response = await h.load('api/users.js').default(protectedRequest(unknownToken));
        assert.equal(response.status, 401);
    }
});

test('message stops after its single JSON 401 without reading the body', async () => {
    const h = harness();
    const response = nodeResponse();
    await h.load('api/message.js').default({headers: {},
        get body() { throw new Error('Unauthenticated body must not be read'); }}, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.replies, 1);
    assert.equal(typeof response.payload, 'object');
    assert.equal(response.payload.code, 'UNAUTHORIZED');
    h.assertSafeLogs();
});

test('Beams still authenticates its user without logging either token or profile', async () => {
    const h = harness();
    const login = await h.load('api/login.js').default.fetch(loginRequest());
    const session = await login.json();
    const response = nodeResponse();
    await h.load('api/beams.js').default({...protectedRequest(session.token),
        query: {user_id: fixture.externalId}}, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.replies, 1);
    assert.equal(typeof response.payload.token, 'string');
    assert.equal(h.calls.beams, 1);
    h.assertSafeLogs([fixture.externalId, fixture.username]);

    h.advance(3600001);
    const expired = nodeResponse();
    await h.load('api/beams.js').default({...protectedRequest(session.token),
        query: {user_id: fixture.externalId}}, expired);
    assert.equal(expired.statusCode, 401);
    assert.equal(h.calls.beams, 1);
});

test('infrastructure errors stay server errors and do not log raw details', async () => {
    const detail = 'sensitive-fixture-provider-detail';
    const db = harness({dbError: new Error(detail)});
    assert.equal((await db.load('api/login.js').default.fetch(loginRequest())).status, 500);
    db.assertSafeLogs([detail]);
    const redis = harness({redisError: new Error(detail)});
    assert.equal((await redis.load('api/users.js').default(protectedRequest(unknownToken))).status, 500);
    const response = nodeResponse();
    await redis.load('api/message.js').default(protectedRequest(unknownToken), response);
    assert.equal(response.statusCode, 500);
    redis.assertSafeLogs([detail, unknownToken]);
});

test('frontend login works with the real handler and updates all three stored fields', async () => {
    const h = harness();
    const result = await frontendLogin(h);
    assert.equal(result.errors.length, 0);
    assert.equal(result.successes.length, 1);
    assert.equal(h.storage.values.get('token') === result.successes[0].token, true);
    assert.equal(h.storage.values.get('externalId'), fixture.externalId);
    assert.equal(h.storage.values.get('username'), fixture.username);
    assert.equal(h.storage.values.get('unrelated'), 'preserved');
    h.assertSafeLogs();
});

test('frontend invalid login clears stale authentication and reports HTTP 401', async () => {
    const h = harness();
    const result = await frontendLogin(h, 'wrong-fixture-password');
    assert.equal(result.successes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].httpStatus, 401);
    assert.equal(result.errors[0].code, 'UNAUTHORIZED');
    assertStorageCleared(h.storage);
    h.assertSafeLogs();
});

test('frontend handles network, invalid JSON and incomplete success responses', async () => {
    for (const fetch of [
        async () => { throw new Error('sensitive-fixture-network-detail'); },
        async () => new Response('invalid JSON', {status: 200}),
        async () => Response.json({token: 'incomplete-fixture-session'}),
    ]) {
        const h = harness({fetch});
        const result = await frontendLogin(h);
        assert.equal(result.successes.length, 0);
        assert.equal(result.errors.length, 1);
        assertStorageCleared(h.storage);
        h.assertSafeLogs(['sensitive-fixture-network-detail']);
        assert.equal(result.errors[0].message.includes('sensitive-fixture'), false);
    }
});

test('frontend handles non-JSON errors without exposing server details', async () => {
    for (const status of [401, 500]) {
        const h = harness({fetch: async () => new Response('sensitive-fixture-error', {status})});
        const result = await frontendLogin(h);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].httpStatus, status);
        assert.equal(result.errors[0].message.includes('sensitive-fixture'), false);
        assertStorageCleared(h.storage);
    }
});

test('a partial sessionStorage write is rolled back before reporting failure', async () => {
    const storage = memoryStorage();
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
        if (key === 'username') throw new Error('Storage unavailable');
        setItem(key, value);
    };
    const h = harness({storage});
    const result = await frontendLogin(h);
    assert.equal(result.successes.length, 0);
    assert.equal(result.errors.length, 1);
    assertStorageCleared(storage);
});

test('storage cleanup continues and reports failure even when one removal is denied', async () => {
    const storage = memoryStorage();
    const removeItem = storage.removeItem.bind(storage);
    storage.removeItem = key => {
        if (key === 'token') throw new Error('Storage unavailable');
        removeItem(key);
    };
    const h = harness({storage, fetch: async () => { throw new Error('Network unavailable'); }});
    const result = await frontendLogin(h);
    assert.equal(result.errors.length, 1);
    assert.equal(storage.values.has('externalId'), false);
    assert.equal(storage.values.has('username'), false);
});

test('successful Login markup hides the token and uses a password input', () => {
    const h = harness();
    const {store} = h.load('src/app/store.ts');
    const {setUser} = h.load('src/features/auth/authSlice.ts');
    store.dispatch(setUser({id: fixture.id, username: fixture.username, externalId: fixture.externalId}));
    h.storage.setItem('token', unknownToken);
    const markup = renderToStaticMarkup(createElement(Provider, {store},
        createElement(MemoryRouter, null, createElement(h.load('src/user/Login.tsx').Login))));
    assert.match(markup, /type="password"/);
    assert.match(markup, /Connecté/);
    assert.equal(markup.includes(fixture.username), true);
    assert.equal(markup.includes(unknownToken), false, 'Session token must not be rendered');
    h.assertSafeLogs([unknownToken]);
});

test('auth reducer starts checking and ignores unrelated actions', () => {
    const reducer = harness().load('src/features/auth/authSlice.ts').default;
    const state = reducer(undefined, {type: 'unrelated'});
    assert.equal(state.user, null);
    assert.equal(state.status, 'checking');
    assert.deepEqual(Object.keys(state).sort(), ['error', 'status', 'user']);
});

test('setUser synchronously records a public identity without changing the previous state', () => {
    const {default: reducer, setUser} = harness().load('src/features/auth/authSlice.ts');
    const previous = reducer(undefined, {type: 'init'});
    const user = {id: fixture.id, username: fixture.username, externalId: fixture.externalId};
    const action = setUser(user);
    const next = reducer(previous, action);
    assert.equal(action.type, 'auth/setUser');
    assert.equal(next.status, 'authenticated');
    assert.deepEqual(JSON.parse(JSON.stringify(next.user)), user);
    assert.equal(previous.user, null);
    assert.equal(previous.status, 'checking');
});

test('resetAuth removes the public identity without changing sessionStorage', () => {
    const h = harness();
    const {store} = h.load('src/app/store.ts');
    const {setUser, resetAuth} = h.load('src/features/auth/authSlice.ts');
    store.dispatch(setUser({id: fixture.id, username: fixture.username, externalId: fixture.externalId}));
    store.dispatch(resetAuth());
    assert.equal(store.getState().auth.user, null);
    assert.equal(store.getState().auth.status, 'anonymous');
    assert.equal(h.storage.values.has('token'), true);
});

function connectedForm() {
    let store;
    let error = {};
    let resets = 0;
    const actions = [];
    const navigations = [];
    const h = harness({
        react: {useState: () => [error, value => { error = value; }]},
        reactRedux: {
            useDispatch: () => action => { actions.push(action); return store.dispatch(action); },
            useSelector: selector => selector(store.getState()),
        },
        reactRouter: {
            useNavigate: () => (to, options) => {
                navigations.push({to, options, user: store.getState().auth.user});
            },
        },
        FormData: class {
            constructor(form) { this.fields = form.fields; }
            get(key) { return this.fields[key]; }
        },
    });
    store = h.load('src/app/store.ts').store;
    return {
        h, store, actions, navigations,
        get error() { return error; },
        get resets() { return resets; },
        async submit(password = fixture.password) {
            const element = h.load('src/user/Login.tsx').Login();
            const form = element.props.children[0];
            let prevented = false;
            await form.props.onSubmit({
                preventDefault() { prevented = true; },
                currentTarget: {
                    fields: {login: fixture.username, password},
                    reset() { resets++; },
                },
            });
            assert.equal(prevented, true);
        },
    };
}

test('Login success dispatches public fields only while loginApi retains the token', async () => {
    const form = connectedForm();
    await form.submit();
    assert.equal(form.store.getState().auth.status, 'authenticated');
    assert.equal(form.store.getState().auth.user.id, fixture.id);
    assert.equal(form.actions.length, 1);
    assert.deepEqual(Object.keys(form.actions[0].payload).sort(), ['externalId', 'id', 'username']);
    const token = form.h.storage.values.get('token');
    assert.equal(form.h.sessions.has(token), true);
    const reduxData = JSON.stringify({actions: form.actions, state: form.store.getState()});
    assert.equal(reduxData.includes(token), false, 'Token must stay outside Redux');
    assert.equal(reduxData.includes(fixture.password), false, 'Password must stay outside Redux');
    assert.equal(form.resets, 1);
    assert.equal(form.error.message, '');
    assert.equal(form.navigations.length, 1);
    assert.equal(form.navigations[0].to, '/messages');
    assert.equal(form.navigations[0].options.replace, true);
    assert.equal(form.navigations[0].user.id, fixture.id);
    form.h.assertSafeLogs();
});

test('failed Login clears Redux and stored authentication while preserving the error', async () => {
    const form = connectedForm();
    await form.submit();
    await form.submit('wrong-fixture-password');
    assert.equal(form.store.getState().auth.status, 'anonymous');
    assert.equal(form.store.getState().auth.user, null);
    assert.equal(form.actions.length, 2);
    assert.equal(form.actions[1].type, 'auth/resetAuth');
    assert.equal(form.error.httpStatus, 401);
    assert.equal(form.error.code, 'UNAUTHORIZED');
    assert.equal(form.resets, 1);
    assert.equal(form.navigations.length, 1, 'A refused login must not trigger another navigation');
    assertStorageCleared(form.h.storage);
    form.h.assertSafeLogs();
});

test('a fresh Redux store waits for verification instead of trusting sessionStorage', () => {
    const h = harness();
    const {store} = h.load('src/app/store.ts');
    const markup = renderToStaticMarkup(createElement(Provider, {store},
        createElement(MemoryRouter, null, createElement(h.load('src/user/Login.tsx').Login))));
    assert.equal(store.getState().auth.user, null);
    assert.equal(store.getState().auth.status, 'checking');
    assert.equal(h.storage.values.has('token'), true);
    assert.equal(markup.includes('Connecté'), false);
});

function renderRoute(h, pathname) {
    const {store} = h.load('src/app/store.ts');
    return renderToStaticMarkup(createElement(Provider, {store},
        createElement(MemoryRouter, {initialEntries: [pathname]},
            createElement(h.load('src/App.jsx').default))));
}

test('root route requests a replacement navigation to /login', () => {
    const app = harness().load('src/App.jsx').default();
    const routes = createRoutesFromElements(app.props.children);
    const rootMatch = matchRoutes(routes, '/').at(-1).route;
    assert.equal(rootMatch.element.type, require('react-router-dom').Navigate);
    assert.equal(rootMatch.element.props.to, '/login');
    assert.equal(rootMatch.element.props.replace, true);
});

test('/login renders the existing form', () => {
    const markup = renderRoute(harness(), '/login');
    assert.match(markup, /<form/);
    assert.match(markup, /name="login"/);
    assert.match(markup, /type="password"/);
});

test('/messages hides private content while checking, then redirects an anonymous user', () => {
    const h = harness();
    const markup = renderRoute(h, '/messages');
    assert.match(markup, /Vérification de la session/);
    assert.equal(markup.includes('UBO Relay Chat'), false);
    assert.equal(markup.includes('Connecté'), false);
    h.load('src/app/store.ts').store.dispatch(h.load('src/features/auth/authSlice.ts').resetAuth());
    assert.equal(renderRoute(h, '/messages').includes('UBO Relay Chat'), false);
});

test('/messages reads the public username from the existing Redux store', () => {
    const h = harness();
    const {store} = h.load('src/app/store.ts');
    store.dispatch(h.load('src/features/auth/authSlice.ts').setUser({
        id: fixture.id, username: fixture.username, externalId: fixture.externalId,
    }));
    h.storage.setItem('token', unknownToken);
    const markup = renderRoute(h, '/messages');
    assert.equal(markup.includes(fixture.username), true);
    assert.equal(markup.includes(unknownToken), false);
    h.assertSafeLogs([unknownToken]);
});

test('an unknown path renders 404 with a login link', () => {
    const markup = renderRoute(harness(), '/unknown/path');
    assert.match(markup, /404/);
    assert.match(markup, /href="\/login"/);
});

test('a refused login never navigates away from the form', async () => {
    const form = connectedForm();
    await form.submit('wrong-fixture-password');
    assert.equal(form.navigations.length, 0);
    assert.equal(form.error.httpStatus, 401);
    assert.equal(form.store.getState().auth.status, 'anonymous');
});

test('Vercel SPA fallback excludes API endpoints, Vite modules and static files', () => {
    const {pathToRegexp} = require('path-to-regexp');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    assert.equal(config.rewrites.length, 1);
    const rule = config.rewrites[0];
    assert.equal(rule.destination, '/index.html');
    const pattern = pathToRegexp(rule.source);
    for (const pathname of ['/', '/login', '/messages', '/unknown/path']) {
        assert.equal(pattern.test(pathname), true);
    }
    for (const pathname of ['/api', '/api/login', '/api/users', '/api/message', '/api/beams',
        '/src/index.jsx', '/src/App', '/@vite/client', '/@react-refresh', '/@id/module',
        '/@fs/tmp/module.js', '/node_modules/.vite/deps/react.js', '/assets/index.js',
        '/index.html', '/favicon.ico', '/service-worker.js', '/manifest.json']) {
        assert.equal(pattern.test(pathname), false);
    }
});

function meRequest(token, method = 'GET') {
    return new Request('https://urc.invalid/api/me', {
        method, headers: token ? {Authorization: `Bearer ${token}`} : {},
    });
}
const publicUser = {id: fixture.id, username: fixture.username, externalId: fixture.externalId};

test('/api/me returns only public data without extending the session', async () => {
    const h = harness();
    const login = await h.load('api/login.js').default.fetch(loginRequest());
    const {token} = await login.json();
    const expiresAt = h.sessions.get(token).expiresAt;
    const response = await h.load('api/me.js').default(meRequest(token));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), publicUser);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vary'), 'Authorization');
    assert.equal(h.sessions.get(token).expiresAt, expiresAt);
    assert.equal(h.calls.set, 1);
    h.assertSafeLogs();
});

test('/api/me returns uncached JSON 401 for missing, malformed, unknown and expired sessions', async () => {
    const h = harness();
    const login = await h.load('api/login.js').default.fetch(loginRequest());
    const {token} = await login.json();
    h.advance(3600001);
    for (const candidate of [undefined, 'malformed', unknownToken, token]) {
        const response = await h.load('api/me.js').default(meRequest(candidate));
        assert.equal(response.status, 401);
        assert.equal((await response.json()).code, 'UNAUTHORIZED');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    h.assertSafeLogs();
});

test('/api/me refuses unsupported methods and distinguishes Redis failure from 401', async () => {
    const h = harness({redisError: new Error('sensitive-provider-detail')});
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
        const response = await h.load('api/me.js').default(meRequest(unknownToken, method));
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(h.calls.get, 0);
    const response = await h.load('api/me.js').default(meRequest(unknownToken));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.text()).includes('sensitive-provider-detail'), false);
    h.assertSafeLogs(['sensitive-provider-detail']);
});

test('verification without a stored token avoids any HTTP request', async () => {
    const storage = memoryStorage();
    storage.removeItem('token');
    const h = harness({storage, fetch: async () => {throw new Error('Unexpected HTTP call');}});
    const result = await h.load('src/features/auth/sessionApi.ts').verifySession(new AbortController().signal);
    assert.equal(result, null);
});

test('verification restores a valid session through the real /api/me handler', async () => {
    const h = harness();
    await frontendLogin(h);
    const result = await h.load('src/features/auth/sessionApi.ts').verifySession(new AbortController().signal);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), publicUser);
    assert.equal(Object.keys(result).length, 3);
    h.assertSafeLogs();
});

test('verification of an expired session clears local authentication on 401', async () => {
    const h = harness();
    await frontendLogin(h);
    h.advance(3600001);
    assert.equal(await h.load('src/features/auth/sessionApi.ts').verifySession(new AbortController().signal), null);
    assertStorageCleared(h.storage);
});

test('network, 500, malformed JSON and malformed success preserve the potential session', async () => {
    for (const fetch of [
        async () => {throw new Error('sensitive-network-detail');},
        async () => new Response('private-provider-detail', {status: 500}),
        async () => new Response('not-json', {status: 200}),
        async () => Response.json({id: 1}),
    ]) {
        const h = harness({fetch});
        await assert.rejects(h.load('src/features/auth/sessionApi.ts').verifySession(new AbortController().signal),
            error => !error.message.includes('private-provider') && !error.message.includes('sensitive-network'));
        assert.equal(h.storage.values.has('token'), true);
        assert.equal(h.storage.values.has('username'), true);
        h.assertSafeLogs(['sensitive-network-detail']);
    }
});

function deferred() {
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    return {promise, resolve};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function startup(options = {}) {
    let store, effect;
    const h = harness({...options,
        react: {useEffect: setup => {effect = setup;}},
        reactRedux: {
            useDispatch: () => store.dispatch,
            useStore: () => store,
            useSelector: selector => selector(store.getState()),
        },
    });
    store = h.load('src/app/store.ts').store;
    return {h, store, run() {
        h.load('src/features/auth/AuthInitializer.tsx').AuthInitializer({children: null});
        return effect();
    }};
}

test('initializer without a token resolves checking to anonymous', async () => {
    const storage = memoryStorage();
    storage.removeItem('token');
    const app = startup({storage});
    const cleanup = app.run();
    await flush();
    assert.equal(app.store.getState().auth.status, 'anonymous');
    assert.equal(app.h.calls.get, 0);
    cleanup();
});

test('initializer keeps loading until verification completes, then authenticates', async () => {
    const request = deferred();
    const app = startup({fetch: () => request.promise});
    const cleanup = app.run();
    assert.match(renderRoute(app.h, '/messages'), /role="status"/);
    assert.equal(app.store.getState().auth.status, 'checking');
    request.resolve(Response.json(publicUser));
    await flush();
    assert.equal(app.store.getState().auth.status, 'authenticated');
    assert.equal(renderRoute(app.h, '/messages').includes(fixture.username), true);
    cleanup();
});

test('a server failure blocks private content and allows a successful retry', async () => {
    let attempt = 0;
    const app = startup({fetch: async () => ++attempt === 1
        ? new Response('private-detail', {status: 500}) : Response.json(publicUser)});
    const cleanup = app.run();
    await flush();
    assert.equal(app.store.getState().auth.status, 'unavailable');
    const markup = renderRoute(app.h, '/messages');
    assert.match(markup, /Réessayer/);
    assert.equal(markup.includes('UBO Relay Chat'), false);
    assert.equal(markup.includes('private-detail'), false);
    assert.equal(app.h.storage.values.has('token'), true);
    cleanup();
    app.store.dispatch(app.h.load('src/features/auth/authSlice.ts').startChecking());
    const retryCleanup = app.run();
    await flush();
    assert.equal(app.store.getState().auth.status, 'authenticated');
    retryCleanup();
});

test('StrictMode setup-cleanup-setup ignores the aborted 401 and completes the current request', async () => {
    const requests = [deferred(), deferred()];
    let calls = 0;
    const app = startup({fetch: () => requests[calls++].promise});
    const firstCleanup = app.run();
    firstCleanup();
    const secondCleanup = app.run();
    requests[0].resolve(new Response('', {status: 401}));
    requests[1].resolve(Response.json(publicUser));
    await flush();
    assert.equal(app.store.getState().auth.status, 'authenticated');
    assert.equal(app.h.storage.values.has('token'), true);
    assert.equal(calls, 2);
    secondCleanup();
});

test('an old verification cannot overwrite or clear a newer successful login', async () => {
    for (const status of [200, 401, 500]) {
        const oldRequest = deferred();
        let app;
        app = startup({fetch: (url, init) => url === '/api/me' ? oldRequest.promise
            : app.h.load('api/login.js').default.fetch(new Request('https://urc.invalid/api/login', init))});
        const cleanup = app.run();
        const result = await frontendLogin(app.h);
        const session = result.successes[0];
        app.store.dispatch(app.h.load('src/features/auth/authSlice.ts').setUser({
            id: session.id, username: session.username, externalId: session.externalId,
        }));
        const latest = app.store.getState().auth;
        oldRequest.resolve(status === 200 ? Response.json({...publicUser, username: 'stale-user'})
            : new Response('', {status}));
        await flush();
        assert.equal(app.store.getState().auth === latest, true);
        assert.equal(app.h.storage.values.get('token') === session.token, true);
        app.h.assertSafeLogs();
        cleanup();
    }
});

const registration = {username: 'new-fixture-user', email: 'new-fixture@example.invalid',
    password: 'new-synthetic-password'};
function registerRequest(data = registration) {
    return new Request('https://urc.invalid/api/register', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
    });
}

test('registration inserts an Argon2id account and returns only the public result', async () => {
    const h = harness();
    const response = await h.load('api/register.js').default.fetch(registerRequest());
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['id', 'username']);
    assert.equal(result.username, registration.username);
    const row = h.users.get(registration.username);
    const parameters = require('@node-rs/argon2').parseOptions(row.password);
    assert.equal(parameters.algorithm, require('@node-rs/argon2').Algorithm.Argon2id);
    assert.equal(parameters.memoryCost, 19456);
    assert.equal(parameters.timeCost, 2);
    assert.equal(parameters.parallelism, 1);
    assert.equal(parameters.saltLen, 16);
    assert.equal(row.password.length, 97);
    assert.equal(row.password !== registration.password, true);
    assert.equal(typeof row.created_on, 'string');
    assert.match(row.external_id, /^[0-9a-f-]{36}$/);
    assert.equal(h.calls.set, 0, 'Registration must not create a Redis session');
    assert.equal(h.calls.hset, 0);
    assert.equal(JSON.stringify(result).includes(row.password), false);
    assert.equal(JSON.stringify(result).includes(registration.password), false);
    h.assertSafeLogs([registration.password]);
});

test('registration refuses missing fields, malformed input and lengths outside the policy', async () => {
    const h = harness();
    const invalid = [null, [], {}, {...registration, password: undefined}, {...registration, email: ''},
        {...registration, email: 'invalid-email'}, {...registration, email: 'a'.repeat(250) + '@mail.invalid'},
        {...registration, username: 'a'.repeat(51)}, {...registration, username: 'ab'},
        {...registration, username: "invalid'username"}, {...registration, password: 'short'},
        {...registration, password: 'a'.repeat(129)}, {...registration, password: 123}];
    for (const data of invalid) {
        const response = await h.load('api/register.js').default.fetch(registerRequest(data));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'INVALID_INPUT');
    }
    assert.equal(h.calls.insert, 0);
});

test('registration refuses an existing username or an existing email', async () => {
    const h = harness();
    for (const data of [{...registration, username: fixture.username}, {...registration, email: fixture.email}]) {
        const response = await h.load('api/register.js').default.fetch(registerRequest(data));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'CONFLICT');
    }
    assert.equal(h.calls.insert, 0);
});

for (const length of [11, 12, 128, 129]) {
    test(`shared and backend password length policy: ${length} characters`, async () => {
        const data = {...registration, password: 'a'.repeat(length)};
        const valid = length >= 12 && length <= 128;
        const h = harness(valid ? {} : {sqlError: new Error('SQL must not be reached')});
        const validation = h.load('lib/registration.js').validateRegistration(data);
        assert.equal(Boolean(validation.data), valid);
        if (!valid) assert.match(validation.fieldErrors.password, /12 et 128/);
        const response = await h.load('api/register.js').default.fetch(registerRequest(data));
        assert.equal(response.status, valid ? 201 : 400);
        assert.equal(h.calls.insert, valid ? 1 : 0);
        if (length === 12) {
            const login = await h.load('api/login.js').default.fetch(new Request('https://urc.invalid/api/login', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({username: data.username, password: data.password}),
            }));
            assert.equal(login.status, 200, 'The twelve-character account must remain usable');
            h.assertSafeLogs([data.password]);
        }
    });
}

for (const [description, email, valid] of [
    ['missing local part', '@gmail.com', false],
    ['missing domain', 'toto@', false],
    ['missing separator', 'totogmail.com', false],
    ['two separators', 'toto@@gmail.com', false],
    ['empty domain label', 'toto@gmail..com', false],
    ['space in local part', 'to to@gmail.com', false],
    ['space in domain', 'toto@g mail.com', false],
    ['invalid domain label', 'toto@-gmail.com', false],
    ['display name', 'Toto <toto@gmail.com>', false],
    ['overlong address', 'a'.repeat(250) + '@mail.invalid', false],
    ['ordinary address', 'toto@gmail.com', true],
    ['university address', 'prenom.nom@univ-brest.fr', true],
    ['unverified TLD', 'toto@gogo.como', true],
]) {
    test(`shared and backend email syntax: ${description}`, async () => {
        const h = harness(valid ? {} : {sqlError: new Error('SQL must not be reached')});
        const data = {...registration, email};
        const validation = h.load('lib/registration.js').validateRegistration(data);
        assert.equal(Boolean(validation.data), valid);
        if (!valid) assert.equal(typeof validation.fieldErrors.email, 'string');
        const response = await h.load('api/register.js').default.fetch(registerRequest(data));
        assert.equal(response.status, valid ? 201 : 400);
        assert.equal(h.calls.insert, valid ? 1 : 0);
        assert.equal(h.users.size, valid ? 2 : 1);
    });
}

test('email trimming is identical for validation, duplicate lookup and storage', async () => {
    const h = harness();
    const email = 'Prenom.Nom@univ-brest.fr';
    const data = {...registration, email: `  ${email}  `};
    assert.equal(h.load('lib/registration.js').validateRegistration(data).data.email, email);
    assert.equal((await h.load('api/register.js').default.fetch(registerRequest(data))).status, 201);
    assert.equal(h.users.get(registration.username).email, email);
    const duplicate = {...data, username: 'another-fixture-user', email};
    assert.equal((await h.load('api/register.js').default.fetch(registerRequest(duplicate))).status, 409);
    assert.equal(h.calls.insert, 1);
});

test('registration maps PostgreSQL unique violations during insertion to HTTP 409', async () => {
    const h = harness({insertError: Object.assign(new Error('sensitive-constraint-detail'), {code: '23505'})});
    const response = await h.load('api/register.js').default.fetch(registerRequest());
    assert.equal(response.status, 409);
    assert.equal((await response.text()).includes('sensitive-constraint-detail'), false);
    assert.equal(h.users.has(registration.username), false);
});

test('simultaneous registrations cannot both create the same identity', async () => {
    const h = harness();
    const responses = await Promise.all([1, 2].map(() => h.load('api/register.js').default.fetch(registerRequest())));
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    assert.equal([...h.users.values()].filter(row => row.username === registration.username).length, 1);
});

test('registration rejects invalid JSON and unsupported methods without inserting', async () => {
    const h = harness();
    const api = h.load('api/register.js').default.fetch;
    const malformed = await api(new Request('https://urc.invalid/api/register', {
        method: 'POST', body: '{', headers: {'Content-Type': 'application/json'},
    }));
    assert.equal(malformed.status, 400);
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
        const response = await api(new Request('https://urc.invalid/api/register', {method}));
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'POST');
    }
    assert.equal(h.calls.insert, 0);
});

test('registration hides PostgreSQL details on both read and insert failures', async () => {
    for (const failure of ['sqlError', 'insertError']) {
        const h = harness({[failure]: new Error('sensitive-postgres-detail')});
        const response = await h.load('api/register.js').default.fetch(registerRequest());
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.equal(body.includes('sensitive-postgres-detail'), false);
        assert.equal(body.includes(registration.password), false);
        h.assertSafeLogs(['sensitive-postgres-detail', registration.password]);
    }
});

test('a newly registered account can log in and use /api/me', async () => {
    const h = harness();
    assert.equal((await h.load('api/register.js').default.fetch(registerRequest())).status, 201);
    const login = await h.load('api/login.js').default.fetch(new Request('https://urc.invalid/api/login', {
        method: 'POST', body: JSON.stringify({username: registration.username, password: registration.password}),
        headers: {'Content-Type': 'application/json'},
    }));
    assert.equal(login.status, 200);
    const session = await login.json();
    const me = await h.load('api/me.js').default(meRequest(session.token));
    assert.equal(me.status, 200);
    assert.equal((await me.json()).username, registration.username);
    assert.equal(h.calls.release, 1);
    h.assertSafeLogs([registration.password]);
});

test('the historical seeded account still authenticates with its existing SQL fingerprint', async () => {
    const h = harness();
    const sql = fs.readFileSync(path.join(root, 'scripts/db.sql'), 'utf8');
    const match = sql.match(/values\s*\('test',\s*'([^']+)'/i);
    assert.equal(Boolean(match), true, 'Historical seed must be identifiable');
    h.users.set('test', {user_id: 999, username: 'test', email: 'historic@example.invalid',
        external_id: 'historic-fixture-id', password: match[1]});
    const response = await h.load('api/login.js').default.fetch(new Request('https://urc.invalid/api/login', {
        method: 'POST', body: JSON.stringify({username: 'test', password: 'testubo'}),
        headers: {'Content-Type': 'application/json'},
    }));
    assert.equal(response.status, 200);
    assert.equal(h.users.get('test').password === match[1], true, 'No silent hash migration');
    h.assertSafeLogs([match[1]]);
});

test('Argon2id uses independent salts, preserves Unicode and rejects the wrong password', async () => {
    const passwords = harness().load('lib/password.js');
    const password = 'synthetic-é🙂-password';
    const first = await passwords.hashPassword(password);
    const second = await passwords.hashPassword(password);
    assert.equal(first !== second, true);
    assert.equal(await passwords.verifyPassword('any-user', password, first), true);
    assert.equal(await passwords.verifyPassword('any-user', password + 'x', first), false);
    assert.equal(await passwords.verifyPassword('any-user', password, '$argon2id$invalid'), false);
});

test('registration frontend sends POST, strips unexpected response fields and leaves storage unchanged', async () => {
    const h = harness();
    const before = JSON.stringify([...h.storage.values]);
    const result = await h.load('src/user/registerApi.ts').registerUser(registration);
    assert.equal(result.username, registration.username);
    assert.deepEqual(Object.keys(result).sort(), ['id', 'username']);
    assert.equal(JSON.stringify([...h.storage.values]), before);
    assert.equal(h.calls.set, 0);
});

test('registration frontend handles HTTP, network and JSON failures without leaking details', async () => {
    for (const fetch of [
        async () => new Response('private-postgres-detail', {status: 400}),
        async () => new Response('private-postgres-detail', {status: 409}),
        async () => new Response('private-postgres-detail', {status: 500}),
        async () => {throw new Error('private-network-detail');},
        async () => new Response('not-json', {status: 201}),
        async () => Response.json({password: 'must-not-escape'}, {status: 201}),
    ]) {
        const h = harness({fetch});
        await assert.rejects(h.load('src/user/registerApi.ts').registerUser(registration),
            error => !error.message.includes('private-') && !error.message.includes('must-not-escape'));
    }
});

test('/register renders a public, labelled and controlled form', () => {
    const markup = renderRoute(harness(), '/register');
    assert.match(markup, /Inscription/);
    assert.match(markup, /type="email"/);
    assert.match(markup, /type="password"/);
    assert.match(markup, /minLength="12"/i);
    assert.match(markup, /maxLength="50"/i);
    assert.match(markup, /href="\/login"/);
});

function registrationForm(options = {}) {
    const state = ['', '', '', '', false, {}];
    let cursor = 0;
    const navigations = [];
    const h = harness({...options,
        react: {useState: () => {
            const index = cursor++;
            return [state[index], value => {state[index] = value;}];
        }},
        reactRouter: {useNavigate: () => (to, options) => navigations.push({to, options})},
    });
    const render = () => {
        cursor = 0;
        return h.load('src/pages/RegisterPage.tsx').RegisterPage();
    };
    return {h, state, navigations, render,
        fill(data) {
            const form = render().props.children[1];
            for (const input of form.props.children.filter(child => child?.type === 'input')) {
                input.props.onChange({target: {value: data[input.props.name]}});
            }
        },
        submit() {return render().props.children[1].props.onSubmit({preventDefault() {}});},
    };
}

test('controlled registration fields validate locally before sending any request', async () => {
    let calls = 0;
    const form = registrationForm({fetch: async () => {calls++; throw new Error('Unexpected request');}});
    form.fill({...registration, password: 'short'});
    assert.equal(form.state[0], registration.username);
    await form.submit();
    assert.equal(calls, 0);
    assert.match(form.state[5].password, /12 et 128/);
    assert.equal(form.state[4], false);
    assert.equal(form.navigations.length, 0);
});

test('registration form displays pending, disables submit, and navigates after success without logging in', async () => {
    const request = deferred();
    const form = registrationForm({fetch: () => request.promise});
    const snapshot = JSON.stringify([...form.h.storage.values]);
    form.fill(registration);
    const completion = form.submit();
    assert.equal(form.state[4], true);
    const markup = form.render();
    const button = markup.props.children[1].props.children.find(child => child?.type === 'button');
    assert.equal(button.props.disabled, true);
    assert.equal(markup.props.children[2].props.role, 'status');
    assert.equal(form.navigations.length, 0);
    request.resolve(Response.json({id: 42, username: registration.username}, {status: 201}));
    await completion;
    assert.equal(form.state[4], false);
    assert.equal(form.state[2], '');
    assert.equal(form.navigations.length, 1);
    assert.equal(form.navigations[0].to, '/login');
    assert.equal(form.navigations[0].options.state.registrationComplete, true);
    assert.equal(JSON.stringify([...form.h.storage.values]), snapshot);
    assert.equal(form.h.load('src/app/store.ts').store.getState().auth.user, null);
    assert.equal(JSON.stringify(form.navigations).includes(registration.password), false);
    form.h.assertSafeLogs([registration.password]);
});

test('registration shows all field errors below their inputs without calling the API', async () => {
    let calls = 0;
    const form = registrationForm({fetch: async () => {calls++; throw new Error('Unexpected request');}});
    form.fill({username: 'a', email: 'toto@gmail..com', password: 'a'.repeat(11)});
    await form.submit();
    const rendered = form.render().props.children[1];
    assert.equal(rendered.props.noValidate, true);
    for (const name of ['username', 'email', 'password']) {
        const children = rendered.props.children;
        const index = children.findIndex(child => child?.type === 'input' && child.props.name === name);
        const input = children[index];
        assert.equal(input.props['aria-invalid'], true);
        const error = children.slice(index + 1).find(child => child?.props?.id === `register-${name}-error`);
        assert.equal(error.props.children, form.state[5][name]);
        assert.equal(error.props.role, 'alert');
        assert.equal(input.props['aria-describedby'].includes(error.props.id), true);
    }
    assert.equal(calls, 0);
});

test('registration form accepts twelve characters and clears previous field errors', async () => {
    const form = registrationForm({fetch: async () => Response.json({id: 42, username: registration.username}, {status: 201})});
    form.fill({...registration, password: 'a'.repeat(11)});
    await form.submit();
    assert.equal(typeof form.state[5].password, 'string');
    form.fill({...registration, password: 'a'.repeat(12)});
    await form.submit();
    assert.equal(Object.keys(form.state[5]).length, 0);
    assert.equal(form.navigations[0].to, '/login');
});

test('registration form shows a safe conflict error and re-enables submission', async () => {
    const form = registrationForm({fetch: async () => new Response('private-db-detail', {status: 409})});
    form.fill(registration);
    await form.submit();
    assert.equal(form.state[4], false);
    assert.match(form.state[3], /déjà utilisé/);
    assert.equal(form.state[3].includes('private-db-detail'), false);
    assert.equal(form.navigations.length, 0);
});

test('login displays registration success from router state with no automatic authentication', () => {
    const h = harness();
    const markup = renderRoute(h, {pathname: '/login', state: {registrationComplete: true}});
    assert.match(markup, /Compte créé/);
    assert.match(markup, /href="\/register"/);
    assert.equal(h.load('src/app/store.ts').store.getState().auth.user, null);
});

test('registration loads under native Node, not only through the test transpiler', async () => {
    const {pathToFileURL} = require('node:url');
    const module = await import(pathToFileURL(path.join(root, 'api/register.js')).href);
    const response = await module.default.fetch(new Request('http://fixture.invalid/api/register'));
    assert.equal(response.status, 405);
});

// Étape 6 : API utilisateurs, cycle du thunk et routes de conversation.
const publicUsers = [
    {user_id: fixture.id, username: fixture.username, last_login: null},
    {user_id: 2, username: 'recipient-fixture', last_login: '22/10/2026 10:00'},
];
function usersApp(options = {}) {
    const h = harness(options);
    const store = h.load('src/app/store.ts').store;
    const auth = h.load('src/features/auth/authSlice.ts');
    store.dispatch(auth.setUser({id: fixture.id, username: fixture.username, externalId: fixture.externalId}));
    return {h, store, auth, ...h.load('src/features/users/usersSlice.ts')};
}

test('GET users returns only the public SQL contract with no-store', async () => {
    const h = harness({userRows: publicUsers.map(user => ({...user,
        password: 'private-fingerprint', email: 'private-email', token: 'private-token'}))});
    const login = await frontendLogin(h);
    const token = login.successes[0].token;
    const response = await h.load('api/users.js').default(protectedRequest(token));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), publicUsers);
    h.assertSafeLogs([token, 'private-fingerprint', 'private-email', 'private-token']);
});

for (const mode of ['missing', 'invalid', 'expired']) {
    test(`GET users refuses ${mode} session before querying PostgreSQL`, async () => {
        const h = harness();
        let token = mode === 'missing' ? null : unknownToken;
        if (mode === 'expired') {
            token = (await frontendLogin(h)).successes[0].token;
            h.advance(3600 * 1000 + 1);
        }
        const response = await h.load('api/users.js').default(protectedRequest(token));
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(h.calls.list, 0);
        h.assertSafeLogs([unknownToken]);
    });
}

test('GET users returns an empty list and hides provider errors, including enumerable details', async () => {
    for (const failed of [false, true]) {
        const h = harness({userRows: [], ...(failed ? {sqlError: Object.assign(new Error('private-db'), {detail: 'private-detail'})} : {})});
        const token = (await frontendLogin(h)).successes[0].token;
        const response = await h.load('api/users.js').default(protectedRequest(token));
        assert.equal(response.status, failed ? 500 : 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        if (failed) {
            assert.equal(body.code, 'USERS_UNAVAILABLE');
            assert.equal(JSON.stringify(body).includes('private'), false);
        } else assert.deepEqual(body, []);
    }
});

test('users endpoint rejects unsupported methods without querying PostgreSQL', async () => {
    const h = harness();
    const response = await h.load('api/users.js').default(new Request('https://urc.invalid/api/users', {method: 'POST'}));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(h.calls.list, 0);
});

test('users service uses Bearer, no-store and signal, and strips unexpected fields', async () => {
    let request;
    const h = harness({fetch: async (url, init) => {
        request = {url, ...init};
        return Response.json(publicUsers.map(user => ({...user, token: 'private-response-token', password: 'private-hash'})));
    }});
    const controller = new AbortController();
    const items = await h.load('src/features/users/usersApi.ts').getUsers(controller.signal);
    assert.equal(request.url, '/api/users');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization === `Bearer ${h.storage.getItem('token')}`, true);
    assert.equal(request.cache, 'no-store');
    assert.equal(request.signal, controller.signal);
    assert.equal(JSON.stringify(items), JSON.stringify(publicUsers));
    h.assertSafeLogs(['private-response-token', 'private-hash']);
});

for (const [description, response, kind] of [
    ['401', () => new Response('private-provider', {status: 401}), 'unauthorized'],
    ['500', () => new Response('private-provider', {status: 500}), 'server'],
    ['network', () => {throw new Error('private-network');}, 'network'],
    ['JSON', () => new Response('invalid-json'), 'invalid'],
    ['object instead of array', () => Response.json({users: publicUsers}), 'invalid'],
    ['invalid ID', () => Response.json([{...publicUsers[0], user_id: '1'}]), 'invalid'],
    ['unsafe ID', () => Response.json([{...publicUsers[0], user_id: Number.MAX_SAFE_INTEGER + 1}]), 'invalid'],
    ['missing username', () => Response.json([{user_id: 1, last_login: null}]), 'invalid'],
    ['missing last_login', () => Response.json([{user_id: 1, username: 'fixture'}]), 'invalid'],
    ['duplicate ID', () => Response.json([publicUsers[0], publicUsers[0]]), 'invalid'],
]) {
    test(`users thunk rejects ${description} with a safe typed error`, async () => {
        const app = usersApp({fetch: async () => response()});
        const token = app.h.storage.getItem('token');
        const result = await app.store.dispatch(app.fetchUsers());
        assert.equal(app.fetchUsers.rejected.match(result), true);
        assert.equal(result.payload.kind, kind);
        assert.equal(JSON.stringify(result).includes('private-'), false);
        if (kind === 'unauthorized') {
            assertStorageCleared(app.h.storage);
            assert.equal(app.store.getState().auth.status, 'anonymous');
            assert.equal(app.store.getState().users.items.length, 0);
            assert.equal(renderRoute(app.h, '/messages').includes('UBO Relay Chat'), false);
        } else {
            assert.equal(app.h.storage.getItem('token') === token, true);
            assert.equal(app.store.getState().auth.status, 'authenticated');
            assert.equal(app.store.getState().users.status, 'failed');
            assert.match(renderRoute(app.h, '/messages'), /Réessayer/);
        }
        app.h.assertSafeLogs([token]);
    });
}

test('users thunk pending then fulfilled updates the list and excludes the connected account', async () => {
    const request = deferred();
    const app = usersApp({fetch: () => request.promise});
    const completion = app.store.dispatch(app.fetchUsers());
    assert.equal(app.store.getState().users.status, 'loading');
    assert.equal(typeof app.store.getState().users.requestId, 'string');
    assert.match(renderRoute(app.h, '/messages'), /Chargement/);
    request.resolve(Response.json(publicUsers));
    const result = await completion;
    assert.equal(app.fetchUsers.fulfilled.match(result), true);
    const state = app.store.getState().users;
    assert.equal(state.status, 'succeeded');
    assert.equal(JSON.stringify(state.items), JSON.stringify(publicUsers));
    assert.equal(state.error, null);
    assert.equal(state.requestId, null);
    const markup = renderRoute(app.h, '/messages');
    assert.match(markup, /Connecté : fixture-user/);
    assert.match(markup, /href="\/messages\/user\/2"/);
    assert.equal(markup.includes('href="/messages/user/1"'), false);
    assert.equal(markup.includes(app.h.storage.getItem('token')), false);
    assert.equal(JSON.stringify(app.store.getState()).includes(app.h.storage.getItem('token')), false);
});

test('empty or current-account-only users list displays the empty state', async () => {
    for (const items of [[], [publicUsers[0]]]) {
        const app = usersApp({fetch: async () => Response.json(items)});
        await app.store.dispatch(app.fetchUsers());
        assert.match(renderRoute(app.h, '/messages'), /Aucun autre utilisateur disponible/);
    }
});

test('users retry changes failed to loading then succeeded', async () => {
    let calls = 0;
    const app = usersApp({fetch: async () => ++calls === 1 ? new Response('', {status: 500}) : Response.json(publicUsers)});
    await app.store.dispatch(app.fetchUsers());
    assert.equal(app.store.getState().users.status, 'failed');
    await app.store.dispatch(app.fetchUsers());
    assert.equal(app.store.getState().users.status, 'succeeded');
    assert.equal(app.store.getState().users.error, null);
});

test('latest users request wins even if an older response arrives later', async () => {
    const requests = [deferred(), deferred()];
    let index = 0;
    const app = usersApp({fetch: () => requests[index++].promise});
    const old = app.store.dispatch(app.fetchUsers());
    const current = app.store.dispatch(app.fetchUsers());
    requests[1].resolve(Response.json(publicUsers));
    await current;
    requests[0].resolve(Response.json([]));
    await old;
    assert.equal(JSON.stringify(app.store.getState().users.items), JSON.stringify(publicUsers));
});

test('an obsolete 401 cannot erase a newer successful request or its session', async () => {
    const requests = [deferred(), deferred()];
    let index = 0;
    const app = usersApp({fetch: () => requests[index++].promise});
    const token = app.h.storage.getItem('token');
    const old = app.store.dispatch(app.fetchUsers());
    const current = app.store.dispatch(app.fetchUsers());
    requests[1].resolve(Response.json(publicUsers));
    await current;
    requests[0].resolve(new Response('', {status: 401}));
    await old;
    assert.equal(app.store.getState().auth.status, 'authenticated');
    assert.equal(app.h.storage.getItem('token') === token, true);
    assert.equal(app.store.getState().users.items.length, 2);
});

for (const actionName of ['resetAuth', 'setUser', 'startChecking', 'sessionUnavailable']) {
    test(`auth ${actionName} clears users and ignores an in-flight response`, async () => {
        const request = deferred();
        let calls = 0;
        const app = usersApp({fetch: async () => ++calls === 1 ? Response.json(publicUsers) : request.promise});
        await app.store.dispatch(app.fetchUsers());
        assert.equal(app.store.getState().users.items.length, 2);
        const pending = app.store.dispatch(app.fetchUsers());
        const user = {id: 9, username: 'new-account-fixture', externalId: 'new-public-id'};
        app.store.dispatch(app.auth[actionName](actionName === 'setUser' ? user : undefined));
        assert.equal(app.store.getState().users.items.length, 0);
        request.resolve(Response.json(publicUsers));
        await pending;
        assert.equal(app.store.getState().users.items.length, 0);
        assert.equal(app.store.getState().users.status, 'idle');
    });
}

test('an old-session 401 cannot clear a newly stored token or a new Redux identity', async () => {
    for (const changeIdentity of [false, true]) {
        const request = deferred();
        const app = usersApp({fetch: () => request.promise});
        const pending = app.store.dispatch(app.fetchUsers());
        app.h.storage.setItem('token', 'replacement-fixture-session');
        if (changeIdentity) app.store.dispatch(app.auth.setUser({id: 9, username: 'next-fixture', externalId: 'next-public-id'}));
        request.resolve(new Response('', {status: 401}));
        await pending;
        assert.equal(app.h.storage.getItem('token') === 'replacement-fixture-session', true);
        assert.equal(app.store.getState().auth.status, 'authenticated');
        assert.equal(app.store.getState().users.items.length, 0);
    }
});

test('an aborted users request returns idle and cannot later restore its data', async () => {
    const request = deferred();
    const app = usersApp({fetch: () => request.promise});
    const pending = app.store.dispatch(app.fetchUsers());
    pending.abort();
    const result = await pending;
    assert.equal(result.meta.aborted, true);
    assert.equal(app.store.getState().users.status, 'idle');
    assert.equal(app.store.getState().users.error, null);
    request.resolve(Response.json(publicUsers));
    await flush();
    assert.equal(app.store.getState().users.items.length, 0);
});

test('StrictMode effect setup, cleanup, setup leaves a live users request', async () => {
    let store, effect;
    const requests = [];
    const h = harness({fetch: () => {const request = deferred(); requests.push(request); return request.promise;},
        react: {useEffect: setup => {effect = setup;}},
        reactRedux: {
            useDispatch: () => store.dispatch, useStore: () => store,
            useSelector: selector => selector(store.getState()),
        },
    });
    store = h.load('src/app/store.ts').store;
    store.dispatch(h.load('src/features/auth/authSlice.ts').setUser({id: 1, username: fixture.username, externalId: fixture.externalId}));
    h.load('src/features/users/useUsers.ts').useUsers();
    const cleanup = effect();
    cleanup();
    const cleanupCurrent = effect();
    assert.equal(requests.length, 2);
    requests[1].resolve(Response.json(publicUsers));
    await flush();
    requests[0].resolve(Response.json([]));
    await flush();
    assert.equal(store.getState().users.status, 'succeeded');
    assert.equal(store.getState().users.items.length, 2);
    cleanupCurrent();
});

for (const [id, expected] of [
    ['2', 'Conversation avec recipient-fixture'], ['abc', 'Identifiant utilisateur invalide'],
    ['0', 'Identifiant utilisateur invalide'], ['-1', 'Identifiant utilisateur invalide'],
    ['1.2', 'Identifiant utilisateur invalide'], ['02', 'Identifiant utilisateur invalide'],
    ['9007199254740992', 'Identifiant utilisateur invalide'],
    ['999', 'Utilisateur introuvable'], ['1', 'votre propre compte'],
]) {
    test(`dynamic conversation route validates useParams ID ${id}`, async () => {
        const app = usersApp({fetch: async () => Response.json(publicUsers)});
        await app.store.dispatch(app.fetchUsers());
        const markup = renderRoute(app.h, '/messages/user/' + id);
        assert.equal(markup.includes(expected), true);
        assert.match(markup, /href="\/messages"/);
        assert.equal(markup.includes(app.h.storage.getItem('token')), false);
    });
}

test('direct conversation access stays protected and loads recipient after session restoration', async () => {
    const h = harness({fetch: async () => Response.json(publicUsers)});
    assert.match(renderRoute(h, '/messages/user/2'), /Vérification de la session/);
    const store = h.load('src/app/store.ts').store;
    const auth = h.load('src/features/auth/authSlice.ts');
    store.dispatch(auth.setUser({id: fixture.id, username: fixture.username, externalId: fixture.externalId}));
    assert.match(renderRoute(h, '/messages/user/2'), /Chargement du destinataire/);
    await store.dispatch(h.load('src/features/users/usersSlice.ts').fetchUsers());
    assert.match(renderRoute(h, '/messages/user/2'), /Conversation avec recipient-fixture/);
    store.dispatch(auth.resetAuth());
    assert.equal(renderRoute(h, '/messages/user/2').includes('recipient-fixture'), false);
});

test('users data never enters Redux actions with credentials or response-only fields', async () => {
    const h = harness({fetch: async () => Response.json(publicUsers.map(user => ({...user,
        password: 'private-password-field', token: 'private-token-field', email: 'private-email-field'})))});
    const actions = [];
    const store = require('@reduxjs/toolkit').configureStore({
        reducer: {auth: h.load('src/features/auth/authSlice.ts').default, users: h.load('src/features/users/usersSlice.ts').default},
        middleware: getDefault => getDefault().concat(() => next => action => {actions.push(action); return next(action);}),
    });
    store.dispatch(h.load('src/features/auth/authSlice.ts').setUser({id: 1, username: fixture.username, externalId: fixture.externalId}));
    await store.dispatch(h.load('src/features/users/usersSlice.ts').fetchUsers());
    const serialized = JSON.stringify({actions, state: store.getState()});
    for (const secret of [h.storage.getItem('token'), 'private-password-field', 'private-token-field', 'private-email-field']) {
        assert.equal(serialized.includes(secret), false);
    }
    h.assertSafeLogs(['private-password-field', 'private-token-field', 'private-email-field']);
});

test('a current 401 clears a previously successful list and all authentication storage', async () => {
    let calls = 0;
    const app = usersApp({fetch: async () => ++calls === 1 ? Response.json(publicUsers) : new Response('', {status: 401})});
    await app.store.dispatch(app.fetchUsers());
    assert.equal(app.store.getState().users.items.length, 2);
    const retry = app.store.dispatch(app.fetchUsers());
    assert.equal(app.store.getState().users.items.length, 0);
    await retry;
    assert.equal(app.store.getState().auth.status, 'anonymous');
    assert.equal(app.store.getState().users.status, 'idle');
    assert.equal(app.store.getState().users.items.length, 0);
    assertStorageCleared(app.h.storage);
});

test('a stored token alone cannot authorize the users thunk', async () => {
    let calls = 0;
    const h = harness({fetch: async () => {calls++; return Response.json(publicUsers);}});
    const store = h.load('src/app/store.ts').store;
    const {fetchUsers} = h.load('src/features/users/usersSlice.ts');
    const result = await store.dispatch(fetchUsers());
    assert.equal(result.meta.condition, true);
    assert.equal(calls, 0);
    assert.equal(store.getState().users.items.length, 0);
});

// Étape 7 : messages privés. Redis et PostgreSQL restent strictement simulés.
const thirdPublicUser = {user_id: 3, username: 'third-fixture', last_login: null};
const sampleMessage = (overrides = {}) => ({
    id: '10000000-0000-4000-8000-000000000001', senderId: 1, recipientId: 2,
    content: 'private-fixture-text', createdAt: new Date().toISOString(), ...overrides,
});
function messagesApp(options = {}) {
    const app = usersApp({userRows: [...publicUsers, thirdPublicUser], ...options});
    const slice = app.h.load('src/features/messages/messagesSlice.ts');
    app.store.dispatch(slice.openConversation(2));
    // Session de test isolée ; aucune connexion réelle ni token de production.
    app.h.storage.setItem('token', unknownToken);
    app.h.sessions.set(unknownToken, {user: {id: 1, username: fixture.username, externalId: fixture.externalId}, expiresAt: Infinity});
    return {...app, ...slice};
}
async function messageCall(h, {method = 'GET', token = unknownToken, userId = '2', body} = {}) {
    const response = nodeResponse();
    await h.load('api/message.js').default({method, headers: token ? {Authorization: `Bearer ${token}`} : {},
        query: {userId}, body}, response);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.replies, 1);
    return response;
}

test('private POST identifies sender from session, stores in Redis, and returns only the message', async () => {
    const {h} = messagesApp();
    const response = await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'private-fixture-text', senderId: 3}});
    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.senderId, 1);
    assert.equal(response.payload.recipientId, 2);
    assert.deepEqual(Object.keys(response.payload).sort(), ['content', 'createdAt', 'id', 'recipientId', 'senderId']);
    assert.match(response.payload.id, /^[0-9a-f-]{36}$/);
    assert.equal(Number.isFinite(Date.parse(response.payload.createdAt)), true);
    assert.equal(h.calls.eval, 1);
    assert.equal(h.messageSets.size, 1);
    assert.equal(JSON.stringify(response.payload).includes(unknownToken), false);
    h.assertSafeLogs([unknownToken, 'private-fixture-text']);
});

for (const content of ['', '   \n\t', null, 4, 'a'.repeat(2001)]) {
    test(`private POST refuses invalid content ${typeof content}:${typeof content === 'string' ? content.length : 'non-string'}`, async () => {
        const {h} = messagesApp();
        const response = await messageCall(h, {method: 'POST', body: {recipientId: 2, content}});
        assert.equal(response.statusCode, 400);
        assert.equal(h.calls.lookup, 0);
        assert.equal(h.calls.eval, 0);
    });
}
for (const id of [0, -1, 1.2, '2', null, 2147483648, 1]) {
    test(`private POST refuses invalid or own recipient ${String(id)}`, async () => {
        const {h} = messagesApp();
        assert.equal((await messageCall(h, {method: 'POST', body: {recipientId: id, content: 'fixture'}})).statusCode, 400);
        assert.equal(h.calls.eval, 0);
    });
}
for (const id of ['0', '-1', '1.2', '02', 'invalid', '2147483648', ['2', '3'], undefined, '1']) {
    test(`private GET refuses invalid or own userId ${String(id)}`, async () => {
        const {h} = messagesApp();
        const response = await messageCall(h, {userId: id === undefined ? null : id});
        assert.equal(response.statusCode, 400);
        assert.equal(h.calls.eval, 0);
    });
}

test('private messages handle missing recipients, JSON, empty bodies and unsupported methods', async () => {
    const {h} = messagesApp();
    for (const method of ['GET', 'POST']) {
        const response = await messageCall(h, {method, userId: '999', body: {recipientId: 999, content: 'fixture'}});
        assert.equal(response.statusCode, 404);
    }
    for (const body of ['{bad-json', null, [], {}, undefined]) {
        assert.equal((await messageCall(h, {method: 'POST', body})).statusCode, 400);
    }
    const method = await messageCall(h, {method: 'DELETE'});
    assert.equal(method.statusCode, 405);
    assert.equal(method.headers.allow, 'GET, POST');
    assert.equal(h.calls.eval, 0);
});

for (const mode of ['absent', 'invalid', 'expired']) {
    test(`private GET and POST refuse ${mode} sessions without SQL or message access`, async () => {
        const {h} = messagesApp();
        if (mode === 'expired') h.sessions.set(unknownToken, {user: {id: 1, username: fixture.username, externalId: fixture.externalId}, expiresAt: 1});
        if (mode === 'expired') h.advance(2);
        for (const method of ['GET', 'POST']) {
            const response = await messageCall(h, {method, token: mode === 'absent' ? null : mode === 'invalid' ? 'bad-token' : unknownToken});
            assert.equal(response.statusCode, 401);
        }
        assert.equal(h.calls.lookup, 0);
        assert.equal(h.calls.eval, 0);
    });
}

test('both participants read the same chronological exchange and conversations remain isolated', async () => {
    const {h} = messagesApp();
    const one = await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'first-private-fixture'}});
    h.advance(10);
    h.sessions.set(unknownToken, {user: {id: 2, username: 'recipient-fixture', externalId: 'public-two'}, expiresAt: Infinity});
    const two = await messageCall(h, {method: 'POST', body: {recipientId: 1, content: 'second-private-fixture'}});
    const fromTwo = await messageCall(h, {userId: '1'});
    assert.equal(fromTwo.statusCode, 200);
    assert.equal(JSON.stringify(fromTwo.payload), JSON.stringify([one.payload, two.payload]));
    h.sessions.set(unknownToken, {user: {id: 1, username: fixture.username, externalId: fixture.externalId}, expiresAt: Infinity});
    const fromOne = await messageCall(h);
    assert.equal(JSON.stringify(fromOne.payload), JSON.stringify(fromTwo.payload));
    await messageCall(h, {method: 'POST', body: {recipientId: 3, content: 'separate-private-fixture'}});
    assert.equal((await messageCall(h)).payload.length, 2);
    // Le client tiers ne peut jamais choisir l'expéditeur de sa lecture.
    h.sessions.set(unknownToken, {user: {id: 3, username: 'third-fixture', externalId: 'public-three'}, expiresAt: Infinity});
    const outsider = nodeResponse();
    await h.load('api/message.js').default({method: 'GET', headers: {Authorization: `Bearer ${unknownToken}`},
        query: {userId: '2', senderId: '1', recipientId: '2'}}, outsider);
    assert.equal(outsider.statusCode, 200);
    assert.equal(outsider.payload.length, 0);
    h.assertSafeLogs([unknownToken, 'first-private-fixture', 'second-private-fixture', 'separate-private-fixture']);
});

test('Redis message storage is bounded, expires, and removes old messages in an active conversation', async () => {
    const {h} = messagesApp();
    const {MESSAGE_LIMIT, MESSAGE_TTL_SECONDS, conversationKey} = h.load('lib/privateMessages.js');
    const first = await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'old-private-fixture'}});
    h.advance(MESSAGE_TTL_SECONDS * 1000 - 1);
    await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'recent-private-fixture'}});
    h.advance(2);
    const active = await messageCall(h);
    assert.equal(active.payload.length, 1);
    assert.equal(active.payload.some(message => message.id === first.payload.id), false);
    assert.equal(h.messageSets.get(conversationKey(1, 2)).expiresAt > 0, true);
    const storage = h.load('lib/messageStorage.js');
    await Promise.all(Array.from({length: MESSAGE_LIMIT + 5}, (_, index) => storage.storeMessage(sampleMessage({
        id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        createdAt: new Date(Date.parse(active.payload[0].createdAt) + index).toISOString(),
    }))));
    const bounded = await messageCall(h);
    assert.equal(bounded.payload.length, MESSAGE_LIMIT);
    const dates = bounded.payload.map(message => message.createdAt);
    assert.deepEqual(Array.from(dates), [...dates].sort());
    h.advance(MESSAGE_TTL_SECONDS * 1000 + 1);
    assert.equal((await messageCall(h)).payload.length, 0);
    assert.equal(h.messageSets.has(conversationKey(1, 2)), false);
});

for (const failure of ['sqlError', 'messageError', 'redisError']) {
    test(`private messages hide ${failure} without logging private data`, async () => {
        const {h} = messagesApp({[failure]: Object.assign(new Error('private-provider-detail'), {detail: 'private-detail'})});
        for (const method of ['GET', 'POST']) {
            const response = await messageCall(h, {method, body: {recipientId: 2, content: 'private-content'}});
            assert.equal(response.statusCode, 500);
            assert.equal(JSON.stringify(response.payload).includes('private'), false);
        }
        h.assertSafeLogs(['private-provider-detail', 'private-content', unknownToken]);
    });
}

test('private backend refuses corrupt Redis history or a foreign conversation member', async () => {
    for (const evalRows of [{bad: true}, ['{bad-json'], [sampleMessage({senderId: 3})]]) {
        const {h} = messagesApp({evalRows});
        assert.equal((await messageCall(h)).statusCode, 500);
    }
});

test('messages service sends only recipient and content, validates responses and strips extras', async () => {
    const requests = [];
    const h = harness({fetch: async (url, init) => {
        requests.push({url, init});
        const message = sampleMessage({token: 'private-extra', password: 'private-extra'});
        return Response.json(init.method === 'POST' ? message : [message], {status: init.method === 'POST' ? 201 : 200});
    }});
    const api = h.load('src/features/messages/messagesApi.ts');
    const controller = new AbortController();
    const result = await api.sendMessage(2, 'private-fixture-text', controller.signal);
    assert.equal(JSON.stringify(result).includes('private-extra'), false);
    assert.deepEqual(JSON.parse(requests[0].init.body), {recipientId: 2, content: 'private-fixture-text'});
    assert.equal(requests[0].init.headers.Authorization === `Bearer ${h.storage.getItem('token')}`, true);
    assert.equal(requests[0].init.cache, 'no-store');
    assert.equal(requests[0].init.signal, controller.signal);
    assert.equal((await api.fetchMessages(2)).length, 1);
    assert.equal(requests[1].url, '/api/message?userId=2');
    h.assertSafeLogs([h.storage.getItem('token'), 'private-fixture-text']);
});

for (const operation of ['fetchMessages', 'sendMessage']) {
    for (const [description, makeResponse, kind] of [
        ['400', () => new Response('private-detail', {status: 400}), 'input'],
        ['401', () => new Response('private-detail', {status: 401}), 'unauthorized'],
        ['404', () => new Response('private-detail', {status: 404}), 'notFound'],
        ['500', () => new Response('private-detail', {status: 500}), 'server'],
        ['network', () => {throw new Error('private-detail');}, 'network'],
        ['invalid JSON', () => new Response('{bad-json', {status: operation === 'sendMessage' ? 201 : 200}), 'invalid'],
        ['wrong participants', () => Response.json(operation === 'sendMessage' ? sampleMessage({senderId: 3, recipientId: 4})
            : [sampleMessage({senderId: 3, recipientId: 4})], {status: operation === 'sendMessage' ? 201 : 200}), 'invalid'],
    ]) {
        test(`${operation}: typed ${description} rejection and session handling`, async () => {
            const app = messagesApp({fetch: async () => makeResponse()});
            const result = await app.store.dispatch(operation === 'fetchMessages' ? app.fetchMessages(2)
                : app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
            assert.equal(result.payload.kind, kind);
            assert.equal(JSON.stringify(result.payload).includes('private-detail'), false);
            assert.equal(app.store.getState().messages.items.length, 0);
            if (kind === 'unauthorized') {
                assert.equal(app.store.getState().auth.status, 'anonymous');
                assertStorageCleared(app.h.storage);
                assert.equal(app.store.getState().messages.userId, null);
            } else {
                assert.equal(app.store.getState().auth.status, 'authenticated');
                assert.equal(app.h.storage.getItem('token') === unknownToken, true);
                assert.equal(app.store.getState().messages[operation === 'fetchMessages' ? 'readStatus' : 'sendStatus'], 'failed');
            }
            app.h.assertSafeLogs([unknownToken, 'private-detail', 'private-fixture-text']);
        });
    }
}

test('both message thunks progress through pending and fulfilled without optimistic sending', async () => {
    const requests = [];
    const app = messagesApp({fetch: () => {const request = deferred(); requests.push(request); return request.promise;}});
    const reading = app.store.dispatch(app.fetchMessages(2));
    assert.equal(app.store.getState().messages.readStatus, 'loading');
    const sending = app.store.dispatch(app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
    assert.equal(app.store.getState().messages.sendStatus, 'loading');
    assert.equal(app.store.getState().messages.items.length, 0);
    requests[1].resolve(Response.json(sampleMessage(), {status: 201}));
    assert.equal(app.sendMessage.fulfilled.match(await sending), true);
    assert.equal(app.store.getState().messages.items.length, 1);
    // Une lecture commencée avant l'envoi ne doit pas effacer la confirmation récente.
    requests[0].resolve(Response.json([]));
    assert.equal(app.fetchMessages.fulfilled.match(await reading), true);
    assert.equal(app.store.getState().messages.items.length, 1);
    assert.equal(app.store.getState().messages.readStatus, 'succeeded');
    assert.equal(app.store.getState().messages.sendStatus, 'succeeded');
});

test('refresh and send confirmations deduplicate by server message ID and purge expired snapshots', async () => {
    let calls = 0;
    const app = messagesApp({fetch: async () => ++calls <= 2 ? Response.json([sampleMessage(), sampleMessage()]) : Response.json([])});
    await app.store.dispatch(app.fetchMessages(2));
    await app.store.dispatch(app.fetchMessages(2));
    assert.equal(app.store.getState().messages.items.length, 1);
    await app.store.dispatch(app.fetchMessages(2));
    assert.equal(app.store.getState().messages.items.length, 0);
});

for (const lane of ['fetchMessages', 'sendMessage']) {
    test(`${lane}: obsolete result cannot overwrite another conversation`, async () => {
        const request = deferred();
        const app = messagesApp({fetch: () => request.promise});
        const old = app.store.dispatch(lane === 'fetchMessages' ? app.fetchMessages(2) : app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
        app.store.dispatch(app.openConversation(3));
        request.resolve(Response.json(lane === 'fetchMessages' ? [sampleMessage()] : sampleMessage(), {status: lane === 'fetchMessages' ? 200 : 201}));
        await old;
        assert.equal(app.store.getState().messages.userId, 3);
        assert.equal(app.store.getState().messages.items.length, 0);
    });
    for (const change of ['resetAuth', 'setUser', 'startChecking', 'sessionUnavailable']) {
        test(`${lane}: ${change} clears messages and prevents late reintroduction`, async () => {
            const request = deferred();
            const app = messagesApp({fetch: () => request.promise});
            const old = app.store.dispatch(lane === 'fetchMessages' ? app.fetchMessages(2) : app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
            app.store.dispatch(app.auth[change](change === 'setUser' ? {id: 3, username: 'next-fixture', externalId: 'next-public'} : undefined));
            request.resolve(Response.json(lane === 'fetchMessages' ? [sampleMessage()] : sampleMessage(), {status: lane === 'fetchMessages' ? 200 : 201}));
            await old;
            assert.equal(app.store.getState().messages.items.length, 0);
            assert.equal(app.store.getState().messages.userId, null);
        });
    }
    test(`${lane}: cancellation clears loading and ignores late data`, async () => {
        const request = deferred();
        const app = messagesApp({fetch: () => request.promise});
        const old = app.store.dispatch(lane === 'fetchMessages' ? app.fetchMessages(2) : app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
        old.abort();
        assert.equal((await old).meta.aborted, true);
        assert.equal(app.store.getState().messages[lane === 'fetchMessages' ? 'readStatus' : 'sendStatus'], 'idle');
        request.resolve(Response.json(lane === 'fetchMessages' ? [sampleMessage()] : sampleMessage(), {status: lane === 'fetchMessages' ? 200 : 201}));
        await flush();
        assert.equal(app.store.getState().messages.items.length, 0);
    });
}

test('latest history request wins and an older 401 cannot invalidate it', async () => {
    const requests = [deferred(), deferred()]; let index = 0;
    const app = messagesApp({fetch: () => requests[index++].promise});
    const old = app.store.dispatch(app.fetchMessages(2));
    const current = app.store.dispatch(app.fetchMessages(2));
    requests[1].resolve(Response.json([sampleMessage()])); await current;
    requests[0].resolve(new Response('', {status: 401})); await old;
    assert.equal(app.store.getState().messages.items.length, 1);
    assert.equal(app.store.getState().auth.status, 'authenticated');
    assert.equal(app.h.storage.getItem('token') === unknownToken, true);
});

test('an old-token message 401 does not remove a newly stored session', async () => {
    const request = deferred();
    const app = messagesApp({fetch: () => request.promise});
    const old = app.store.dispatch(app.fetchMessages(2));
    app.h.storage.setItem('token', 'new-synthetic-session');
    request.resolve(new Response('', {status: 401})); await old;
    assert.equal(app.h.storage.getItem('token') === 'new-synthetic-session', true);
    assert.equal(app.store.getState().auth.status, 'authenticated');
});

test('messages reject a mixed or foreign conversation before it enters Redux', async () => {
    const app = messagesApp({fetch: async () => Response.json([sampleMessage({senderId: 3})])});
    const result = await app.store.dispatch(app.fetchMessages(2));
    assert.equal(app.fetchMessages.rejected.match(result), true);
    assert.equal(app.store.getState().messages.items.length, 0);
});

test('StrictMode message setup/abort/setup keeps the second request current', async () => {
    const requests = [deferred(), deferred()]; let index = 0;
    const app = messagesApp({fetch: () => requests[index++].promise});
    app.store.dispatch(app.openConversation(2));
    const first = app.store.dispatch(app.fetchMessages(2)); first.abort();
    app.store.dispatch(app.clearMessages());
    app.store.dispatch(app.openConversation(2));
    const second = app.store.dispatch(app.fetchMessages(2));
    requests[1].resolve(Response.json([sampleMessage()])); await second;
    requests[0].resolve(Response.json([])); await first; await flush();
    assert.equal(app.store.getState().messages.readStatus, 'succeeded');
    assert.equal(app.store.getState().messages.items.length, 1);
});

test('private conversation markup escapes HTML and aligns participants without exposing session', async () => {
    const app = messagesApp({fetch: async () => Response.json(publicUsers)});
    await app.store.dispatch(app.h.load('src/features/users/usersSlice.ts').fetchUsers());
    const message = sampleMessage({content: '<img src=x onerror=alert(1)>'});
    const pending = app.fetchMessages.pending('fixture-read', 2);
    app.store.dispatch(pending);
    app.store.dispatch(app.fetchMessages.fulfilled([message, sampleMessage({id: '20000000-0000-4000-8000-000000000002', senderId: 2, recipientId: 1})], 'fixture-read', 2));
    const markup = renderRoute(app.h, '/messages/user/2');
    assert.match(markup, /&lt;img/);
    assert.equal(markup.includes('<img'), false);
    assert.match(markup, /message-sent/); assert.match(markup, /message-received/);
    assert.match(markup, /<time/); assert.match(markup, /Actualiser/); assert.match(markup, /Envoyer/);
    assert.equal(markup.includes(unknownToken), false);
    assert.equal(JSON.stringify(app.store.getState()).includes(unknownToken), false);
    app.h.assertSafeLogs([message.content, unknownToken]);
});

test('private POST accepts exactly 2000 characters', async () => {
    const {h} = messagesApp();
    const response = await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'a'.repeat(2000)}});
    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.content.length, 2000);
});

test('send service rejects invalid input before HTTP, including an undefined content', async () => {
    let calls = 0;
    const h = harness({fetch: async () => {calls++; throw new Error('Unexpected network');}});
    for (const content of [undefined, null, '', '  ', 'a'.repeat(2001)]) {
        await assert.rejects(h.load('src/features/messages/messagesApi.ts').sendMessage(2, content), error => error.kind === 'input');
    }
    assert.equal(calls, 0);
});

test('a second send is blocked while the current send is pending', async () => {
    let calls = 0;
    const request = deferred();
    const app = messagesApp({fetch: () => {calls++; return request.promise;}});
    const first = app.store.dispatch(app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
    const second = await app.store.dispatch(app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
    assert.equal(second.meta.condition, true);
    assert.equal(calls, 1);
    request.resolve(Response.json(sampleMessage(), {status: 201}));
    await first;
    assert.equal(app.store.getState().messages.items.length, 1);
});

// Étape 8 : hook réel avec Redux réel, horloge et événements navigateur simulés.
function pollingApp(options = {}) {
    let clock = 0, sequence = 0, store, effect;
    const timers = new Map();
    const refs = []; let cursor = 0;
    function events(extra = {}) {
        const listeners = new Map();
        return {...extra,
            addEventListener(type, callback) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(callback);
            },
            removeEventListener(type, callback) {listeners.get(type)?.delete(callback);},
            emit(type) {for (const callback of [...listeners.get(type) ?? []]) callback();},
            count() {return [...listeners.values()].reduce((total, entries) => total + entries.size, 0);},
        };
    }
    const browser = {
        document: events({visibilityState: 'visible'}), window: events(), navigator: {onLine: true},
        setTimeout(callback, delay) {const id = ++sequence; timers.set(id, {at: clock + delay, callback}); return id;},
        clearTimeout(id) {timers.delete(id);},
    };
    const app = messagesApp({...options, browser,
        react: {useEffect: setup => {effect = setup;}, useCallback: callback => callback,
            useRef: initial => {const index = cursor++; return refs[index] ??= {current: initial};}},
        reactRedux: {useDispatch: () => store.dispatch, useStore: () => store,
            useSelector: selector => selector(store.getState())},
    });
    store = app.store;
    return {...app, browser, timers,
        mount(id = 2, kind = 'private') {
            cursor = 0;
            const refresh = app.h.load('src/features/messages/useMessagePolling.ts').useMessagePolling(id, kind);
            const cleanup = effect();
            return {refresh, cleanup: () => cleanup?.()};
        },
        async advance(milliseconds) {
            const target = clock + milliseconds;
            while (true) {
                const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                clock = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
            }
            clock = target; await flush();
        },
        now: () => clock,
    };
}

test('polling loads immediately, then eight seconds after completion, adding messages without duplicates', async () => {
    let calls = 0;
    const app = pollingApp({fetch: async () => Response.json(++calls === 1 ? [] : [sampleMessage(), sampleMessage()])});
    const mounted = app.mount(); await flush();
    assert.equal(calls, 1); assert.equal(app.store.getState().messages.hasLoaded, true);
    await app.advance(7999); assert.equal(calls, 1);
    await app.advance(1); assert.equal(calls, 2); assert.equal(app.store.getState().messages.items.length, 1);
    await app.advance(8000); assert.equal(calls, 3); assert.equal(app.store.getState().messages.items.length, 1);
    mounted.cleanup();
});

test('a slow polling request never overlaps and the delay starts after its response', async () => {
    const request = deferred(); let calls = 0;
    const app = pollingApp({fetch: () => {calls++; return request.promise;}});
    const mounted = app.mount();
    await app.advance(60000);
    assert.equal(calls, 1); assert.equal(app.timers.size, 0);
    request.resolve(Response.json([])); await flush();
    await app.advance(7999); assert.equal(calls, 1);
    await app.advance(1); assert.equal(calls, 2);
    mounted.cleanup();
});

test('polling cleanup aborts its HTTP request and removes every timer and event listener', async () => {
    let signal, calls = 0; const request = deferred();
    const app = pollingApp({fetch: (_, init) => {calls++; signal = init.signal; return request.promise;}});
    const mounted = app.mount();
    assert.equal(app.browser.document.count(), 1); assert.equal(app.browser.window.count(), 2);
    mounted.cleanup();
    assert.equal(signal.aborted, true);
    assert.equal(app.timers.size, 0); assert.equal(app.browser.document.count(), 0); assert.equal(app.browser.window.count(), 0);
    request.resolve(Response.json([sampleMessage()])); await flush();
    await app.advance(60000); assert.equal(calls, 1); assert.equal(app.store.getState().messages.items.length, 0);
});

for (const mode of ['hidden', 'offline']) {
    test(`polling suspends while ${mode} and immediately resumes when available`, async () => {
        let calls = 0;
        const app = pollingApp({fetch: async () => {calls++; return Response.json([]);}});
        const mounted = app.mount(); await flush();
        if (mode === 'hidden') {app.browser.document.visibilityState = 'hidden'; app.browser.document.emit('visibilitychange');}
        else {app.browser.navigator.onLine = false; app.browser.window.emit('offline');}
        await app.advance(60000); assert.equal(calls, 1); assert.equal(app.timers.size, 0);
        if (mode === 'hidden') {app.browser.document.visibilityState = 'visible'; app.browser.document.emit('visibilitychange');}
        else {app.browser.navigator.onLine = true; app.browser.window.emit('online');}
        await flush(); assert.equal(calls, 2);
        await app.advance(8000); assert.equal(calls, 3);
        mounted.cleanup();
    });
}

test('initially hidden or offline conversations wait before making any HTTP request', async () => {
    for (const mode of ['hidden', 'offline']) {
        let calls = 0;
        const app = pollingApp({fetch: async () => {calls++; return Response.json([]);}});
        if (mode === 'hidden') app.browser.document.visibilityState = 'hidden';
        else app.browser.navigator.onLine = false;
        const mounted = app.mount(); await app.advance(60000); assert.equal(calls, 0);
        app.browser.document.visibilityState = 'visible'; app.browser.navigator.onLine = true;
        app.browser.window.emit('online'); await flush(); assert.equal(calls, 1);
        mounted.cleanup();
    }
});

test('rapid hide/show while abort settles resumes immediately without an extra immediate loop', async () => {
    const request = deferred(); let calls = 0;
    const app = pollingApp({fetch: async () => ++calls === 1 ? request.promise : Response.json([])});
    const mounted = app.mount();
    app.browser.document.visibilityState = 'hidden'; app.browser.document.emit('visibilitychange');
    app.browser.document.visibilityState = 'visible'; app.browser.document.emit('visibilitychange');
    app.browser.document.visibilityState = 'hidden'; app.browser.document.emit('visibilitychange');
    await flush();
    app.browser.document.visibilityState = 'visible'; app.browser.document.emit('visibilitychange');
    await flush(); assert.equal(calls, 2);
    await app.advance(7999); assert.equal(calls, 2);
    request.resolve(Response.json([sampleMessage()])); await flush();
    assert.equal(app.store.getState().messages.items.length, 0);
    mounted.cleanup();
});

test('manual refresh and polling share one request and restart the timer after completion', async () => {
    let calls = 0; const request = deferred();
    const app = pollingApp({fetch: async () => ++calls === 1 ? Response.json([]) : request.promise});
    const mounted = app.mount(); await flush(); await app.advance(4000);
    mounted.refresh(); mounted.refresh(); await flush(); assert.equal(calls, 2);
    await app.advance(20000); assert.equal(calls, 2);
    request.resolve(Response.json([])); await flush();
    await app.advance(7999); assert.equal(calls, 2);
    await app.advance(1); assert.equal(calls, 3);
    mounted.cleanup();
});

test('polling joins an equivalent external read instead of starting another one', async () => {
    let calls = 0; const request = deferred();
    const app = pollingApp({fetch: async () => ++calls === 1 ? request.promise : Response.json([])});
    const external = app.store.dispatch(app.fetchMessages(2));
    const mounted = app.mount(); await app.advance(60000); assert.equal(calls, 1);
    request.resolve(Response.json([])); await external; await flush();
    await app.advance(7999); assert.equal(calls, 1);
    await app.advance(1); assert.equal(calls, 2);
    mounted.cleanup();
});

for (const failure of ['500', 'network']) {
    test(`polling ${failure} keeps the session and waits eight seconds before retry`, async () => {
        let calls = 0;
        const app = pollingApp({fetch: async () => {calls++; if (failure === 'network') throw new Error('private-error'); return new Response('', {status: 500});}});
        const mounted = app.mount(); await flush();
        assert.equal(app.store.getState().messages.readStatus, 'failed');
        assert.equal(app.h.storage.getItem('token') === unknownToken, true);
        await app.advance(7999); assert.equal(calls, 1);
        await app.advance(1); assert.equal(calls, 2);
        app.h.assertSafeLogs([unknownToken, 'private-error']);
        mounted.cleanup();
    });
}

test('a polling 401 clears all private state and permanently stops this session loop', async () => {
    let calls = 0;
    const app = pollingApp({fetch: async () => ++calls === 1 ? Response.json([sampleMessage()]) : new Response('', {status: 401})});
    const mounted = app.mount(); await flush(); assert.equal(app.store.getState().messages.items.length, 1);
    await app.advance(8000);
    assert.equal(app.store.getState().auth.status, 'anonymous'); assertStorageCleared(app.h.storage);
    assert.equal(app.store.getState().messages.items.length, 0);
    await app.advance(60000); assert.equal(calls, 2); assert.equal(app.timers.size, 0);
    mounted.cleanup();
});

test('a send-triggered 401 also stops an active polling request', async () => {
    let calls = 0; const pending = deferred();
    const app = pollingApp({fetch: async (_, init) => {calls++; return init.method === 'POST' ? new Response('', {status: 401}) : pending.promise;}});
    const mounted = app.mount();
    await app.store.dispatch(app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
    await app.advance(60000); assert.equal(calls, 2);
    assert.equal(app.store.getState().auth.status, 'anonymous'); assert.equal(app.timers.size, 0);
    pending.resolve(Response.json([sampleMessage()])); await flush();
    assert.equal(app.store.getState().messages.items.length, 0);
    mounted.cleanup();
});

test('StrictMode setup/cleanup/setup replaces its cancelled read immediately', async () => {
    let calls = 0; const old = deferred();
    const app = pollingApp({fetch: async () => ++calls === 1 ? old.promise : Response.json([sampleMessage()])});
    const first = app.mount(); first.cleanup();
    const second = app.mount(); await flush();
    assert.equal(calls, 2); assert.equal(app.store.getState().messages.items.length, 1);
    assert.equal(app.timers.size, 1); assert.equal(app.browser.document.count(), 1);
    old.resolve(Response.json([])); await flush();
    await app.advance(8000); assert.equal(calls, 3);
    second.cleanup();
});

test('fast conversation change aborts its polling and ignores old results', async () => {
    const old = deferred(); const requests = [];
    const app = pollingApp({fetch: async url => {requests.push(url); return url.includes('userId=2') ? old.promise : Response.json([]);}});
    const first = app.mount(); first.cleanup();
    app.store.dispatch(app.openConversation(3)); const second = app.mount(3); await flush();
    old.resolve(Response.json([sampleMessage()])); await flush();
    assert.equal(app.store.getState().messages.userId, 3); assert.equal(app.store.getState().messages.items.length, 0);
    await app.advance(8000);
    assert.equal(requests.filter(url => url.includes('userId=2')).length, 1);
    second.cleanup();
});

test('account replacement prevents old polling from changing a new session', async () => {
    const old = deferred(); let calls = 0;
    const app = pollingApp({fetch: async () => {calls++; return old.promise;}});
    const mounted = app.mount();
    app.store.dispatch(app.auth.setUser({id: 3, username: 'new-fixture', externalId: 'new-public'}));
    app.h.storage.setItem('token', 'replacement-fixture');
    old.resolve(new Response('', {status: 401})); await flush(); await app.advance(60000);
    assert.equal(calls, 1); assert.equal(app.store.getState().auth.user.id, 3);
    assert.equal(app.h.storage.getItem('token') === 'replacement-fixture', true);
    assert.equal(app.store.getState().messages.items.length, 0);
    mounted.cleanup();
});

test('polling does not run on the mere presence of a stored token', async () => {
    let calls = 0;
    const app = pollingApp({fetch: async () => {calls++; return Response.json([]);}});
    app.store.dispatch(app.auth.resetAuth());
    const mounted = app.mount(); await app.advance(60000);
    assert.equal(calls, 0); assert.equal(app.timers.size, 0); mounted.cleanup();
});

test('silent polling keeps loaded messages or empty state visible, including on failure', async () => {
    const app = messagesApp({fetch: async () => Response.json(publicUsers)});
    await app.store.dispatch(app.h.load('src/features/users/usersSlice.ts').fetchUsers());
    app.store.dispatch(app.fetchMessages.pending('initial-read', 2));
    app.store.dispatch(app.fetchMessages.fulfilled([sampleMessage()], 'initial-read', 2));
    app.store.dispatch(app.fetchMessages.pending('poll-read', 2));
    let markup = renderRoute(app.h, '/messages/user/2');
    assert.equal(markup.includes('Chargement des messages'), false);
    assert.equal(markup.includes('private-fixture-text'), true);
    app.store.dispatch(app.fetchMessages.rejected(null, 'poll-read', 2, {kind: 'server', message: 'Actualisation indisponible.'}));
    markup = renderRoute(app.h, '/messages/user/2');
    assert.match(markup, /class="polling-error" role="status"/);
    assert.equal(markup.includes('private-fixture-text'), true);
    app.store.dispatch(app.fetchMessages.pending('empty-read', 2));
    app.store.dispatch(app.fetchMessages.fulfilled([], 'empty-read', 2));
    app.store.dispatch(app.fetchMessages.pending('empty-poll', 2));
    markup = renderRoute(app.h, '/messages/user/2');
    assert.equal(markup.includes('Aucun message pour le moment'), true);
    assert.equal(markup.includes('Chargement des messages'), false);
});

test('a message sent during polling survives an older history snapshot', async () => {
    const read = deferred(); let calls = 0;
    const app = pollingApp({fetch: async (_, init) => {calls++; return init.method === 'POST' ? Response.json(sampleMessage(), {status: 201}) : read.promise;}});
    const mounted = app.mount();
    await app.store.dispatch(app.sendMessage({recipientId: 2, content: 'private-fixture-text'}));
    read.resolve(Response.json([])); await flush();
    assert.equal(app.store.getState().messages.items.length, 1); assert.equal(calls, 2);
    assert.equal(JSON.stringify(app.store.getState()).includes(unknownToken), false);
    app.h.assertSafeLogs([unknownToken, 'private-fixture-text']); mounted.cleanup();
});

test('hide then immediate show restarts a cancelled polling request before the normal delay', async () => {
    const old = deferred(); let calls = 0;
    const app = pollingApp({fetch: async () => ++calls === 1 ? old.promise : Response.json([])});
    const mounted = app.mount();
    app.browser.document.visibilityState = 'hidden'; app.browser.document.emit('visibilitychange');
    app.browser.document.visibilityState = 'visible'; app.browser.document.emit('visibilitychange');
    await flush(); assert.equal(calls, 2); assert.equal(app.timers.size, 1);
    old.resolve(Response.json([sampleMessage()])); await flush();
    assert.equal(app.store.getState().messages.items.length, 0);
    mounted.cleanup();
});

test('an external read begun during the polling delay cancels the timer until its completion', async () => {
    const externalRead = deferred(); let calls = 0;
    const app = pollingApp({fetch: async () => ++calls === 2 ? externalRead.promise : Response.json([])});
    const mounted = app.mount(); await flush(); await app.advance(4000);
    const external = app.store.dispatch(app.fetchMessages(2));
    await app.advance(20000); assert.equal(calls, 2); assert.equal(app.timers.size, 0);
    externalRead.resolve(Response.json([])); await external; await flush();
    await app.advance(7999); assert.equal(calls, 2);
    await app.advance(1); assert.equal(calls, 3);
    mounted.cleanup();
});

// Étape 9 : salons publics pour les comptes authentifiés, bases simulées uniquement.
function roomApp(options = {}) {
    const app = messagesApp(options);
    const roomsSlice = app.h.load('src/features/rooms/roomsSlice.ts');
    const messageSlice = app.h.load('src/features/rooms/roomMessagesSlice.ts');
    app.store.dispatch(messageSlice.openRoom(1));
    return {...app, ...roomsSlice, ...messageSlice};
}
const roomMessage = (overrides = {}) => ({id: '50000000-0000-4000-8000-000000000001', roomId: 1,
    senderId: 1, senderName: fixture.username, content: 'room-private-fixture', createdAt: new Date().toISOString(), ...overrides});
async function roomCall(h, {endpoint = 'rooms', method = 'GET', token = unknownToken, roomId = '1', body} = {}) {
    const response = nodeResponse();
    await h.load(`api/${endpoint}.js`).default({method, headers: token ? {Authorization: `Bearer ${token}`} : {}, query: {roomId}, body}, response);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.replies, 1);
    return response;
}

test('rooms schema has UNIQUE VARCHAR(50), no membership or creator FK; seeded orphan creators stay visible', async () => {
    const schema = fs.readFileSync(path.join(root, 'scripts/db.sql'), 'utf8');
    const definition = schema.match(/CREATE TABLE rooms \(([\s\S]*?)\);/)[1];
    assert.match(definition, /name VARCHAR \( 50 \) UNIQUE NOT NULL/);
    assert.match(definition, /created_by INTEGER NOT NULL/);
    assert.equal(/REFERENCES|FOREIGN KEY/i.test(definition), false);
    const {h} = roomApp(); const response = await roomCall(h);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.map(room => room.name), ['General', 'News', 'Random']);
    assert.equal(JSON.stringify(response.payload).includes('created_by'), false);
});

test('rooms API handles empty list and creates only public output using the session creator', async () => {
    const {h} = roomApp({roomRows: []});
    assert.equal((await roomCall(h)).payload.length, 0);
    const response = await roomCall(h, {method: 'POST', body: {name: '  Study room  ', created_by: 3}});
    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.name, 'Study room');
    assert.deepEqual(Object.keys(response.payload).sort(), ['name', 'room_id']);
    assert.equal(h.rooms.get(response.payload.room_id).created_by, 1);
    assert.equal(typeof h.rooms.get(response.payload.room_id).created_on, 'string');
    assert.equal(h.calls.roomInsert, 1);
});

for (const name of ['', '  ', 42, null, 'a'.repeat(51), 'bad\nname', 'bad\0name']) {
    test(`room creation rejects invalid name ${typeof name}:${typeof name === 'string' ? name.length : 'not-string'}`, async () => {
        const {h} = roomApp();
        assert.equal((await roomCall(h, {method: 'POST', body: {name}})).statusCode, 400);
        assert.equal(h.calls.roomInsert, 0);
    });
}

test('room creation accepts fifty characters, rejects duplicates and concurrent duplicate insertion', async () => {
    const {h} = roomApp();
    assert.equal((await roomCall(h, {method: 'POST', body: {name: 'a'.repeat(50)}})).statusCode, 201);
    assert.equal((await roomCall(h, {method: 'POST', body: {name: ' General '}})).statusCode, 409);
    const responses = await Promise.all([1, 2].map(() => roomCall(h, {method: 'POST', body: {name: 'Concurrent room'}})));
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
    assert.equal([...h.rooms.values()].filter(room => room.name === 'Concurrent room').length, 1);
    const forced = roomApp({roomInsertError: Object.assign(new Error('private-constraint'), {code: '23505'})});
    assert.equal((await roomCall(forced.h, {method: 'POST', body: {name: 'Any room'}})).statusCode, 409);
});

for (const endpoint of ['rooms', 'room-messages']) {
    for (const auth of ['missing', 'invalid', 'expired']) {
        test(`${endpoint} GET/POST refuse ${auth} sessions before SQL or messages`, async () => {
            const {h} = roomApp();
            if (auth === 'expired') h.sessions.delete(unknownToken);
            for (const method of ['GET', 'POST']) {
                const response = await roomCall(h, {endpoint, method, token: auth === 'missing' ? null : auth === 'invalid' ? 'bad-token' : unknownToken});
                assert.equal(response.statusCode, 401);
            }
            assert.equal(h.calls.roomList + h.calls.roomInsert + h.calls.roomLookup, 0);
            assert.equal(h.calls.eval, 0);
        });
    }
    test(`${endpoint} handles invalid JSON and method with safe headers`, async () => {
        const {h} = roomApp();
        assert.equal((await roomCall(h, {endpoint, method: 'POST', body: '{bad-json'})).statusCode, 400);
        const response = await roomCall(h, {endpoint, method: 'DELETE'});
        assert.equal(response.statusCode, 405); assert.equal(response.headers.allow, 'GET, POST');
    });
}

for (const id of [0, -1, 1.2, '1', 2147483648, null]) {
    test(`room messages POST rejects invalid ID ${String(id)}`, async () => {
        const {h} = roomApp();
        const response = await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: id, content: 'fixture'}});
        assert.equal(response.statusCode, 400); assert.equal(h.calls.eval, 0);
    });
}
for (const id of ['0', '-1', '1.2', '01', ['1', '2'], '2147483648']) {
    test(`room messages GET rejects invalid ID ${String(id)}`, async () => {
        const {h} = roomApp();
        assert.equal((await roomCall(h, {endpoint: 'room-messages', roomId: id})).statusCode, 400);
    });
}
for (const content of ['', ' \n ', null, 42, 'a'.repeat(2001)]) {
    test(`room messages reject invalid text ${typeof content}:${typeof content === 'string' ? content.length : 'non-string'}`, async () => {
        const {h} = roomApp();
        assert.equal((await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: 1, content}})).statusCode, 400);
        assert.equal(h.calls.eval, 0);
    });
}

test('room message author is the session and all authenticated participants see the same history', async () => {
    const {h} = roomApp();
    const sent = [];
    for (const id of [1, 2, 3]) {
        h.sessions.set(unknownToken, {user: {id, username: `public-fixture-${id}`, externalId: `public-id-${id}`}, expiresAt: Infinity});
        const response = await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {
            roomId: 1, content: 'private-group-text-' + id, senderId: 999, senderName: 'spoofed'}});
        assert.equal(response.statusCode, 201); assert.equal(response.payload.senderId, id);
        assert.equal(response.payload.senderName, `public-fixture-${id}`); sent.push(response.payload);
        h.advance(10);
    }
    for (const id of [1, 2, 3]) {
        h.sessions.set(unknownToken, {user: {id, username: `public-fixture-${id}`, externalId: `public-id-${id}`}, expiresAt: Infinity});
        const response = await roomCall(h, {endpoint: 'room-messages'});
        assert.equal(response.statusCode, 200); assert.equal(JSON.stringify(response.payload), JSON.stringify(sent));
    }
    h.assertSafeLogs([unknownToken, ...sent.map(message => message.content)]);
});

test('room, other room, and private conversation keys and histories remain isolated', async () => {
    const {h} = roomApp();
    await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: 1, content: 'room-one-private'}});
    await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: 2, content: 'room-two-private'}});
    await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'private-direct'}});
    assert.equal((await roomCall(h, {endpoint: 'room-messages'})).payload[0].content, 'room-one-private');
    assert.equal((await roomCall(h, {endpoint: 'room-messages', roomId: '2'})).payload[0].content, 'room-two-private');
    assert.equal((await messageCall(h)).payload[0].content, 'private-direct');
    assert.equal(h.messageSets.size, 3);
    assert.equal(h.messageSets.has('urc:room:v1:1'), true);
    assert.equal(h.messageSets.has('urc:room:v1:2'), true);
    assert.equal(h.messageSets.has('urc:private:v1:1:2'), true);
});

test('room messages use the same atomic scripts, 100-message cap, chronology and 24h expiration', async () => {
    const {h} = roomApp(); const storage = h.load('lib/messageStorage.js');
    const first = await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: 1, content: 'old-room-fixture'}});
    assert.equal(first.statusCode, 201);
    h.advance(86400000 - 1);
    await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: 1, content: 'new-room-fixture'}});
    h.advance(2);
    assert.equal((await roomCall(h, {endpoint: 'room-messages'})).payload.length, 1);
    await Promise.all(Array.from({length: 110}, (_, index) => storage.storeRoomMessage(roomMessage({
        id: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        createdAt: new Date(Date.parse(first.payload.createdAt) + 86400010 + index).toISOString()}))));
    const response = await roomCall(h, {endpoint: 'room-messages'});
    assert.equal(response.payload.length, 100);
    const dates = Array.from(response.payload, message => message.createdAt);
    assert.deepEqual(dates, [...dates].sort());
    assert.equal(h.messageSets.get('urc:room:v1:1').expiresAt > 0, true);
    h.advance(86400001);
    assert.equal((await roomCall(h, {endpoint: 'room-messages'})).payload.length, 0);
    assert.equal(h.messageSets.has('urc:room:v1:1'), false);
});

test('unknown rooms and provider errors return only safe public errors', async () => {
    const {h} = roomApp();
    for (const method of ['GET', 'POST']) {
        assert.equal((await roomCall(h, {endpoint: 'room-messages', roomId: '999', method,
            body: {roomId: 999, content: 'fixture'}})).statusCode, 404);
    }
    for (const failure of ['sqlError', 'redisError', 'messageError']) {
        const app = roomApp({[failure]: Object.assign(new Error('private-provider'), {detail: 'private-detail'})});
        const endpoints = failure === 'messageError' ? ['room-messages'] : ['rooms', 'room-messages'];
        for (const endpoint of endpoints) {
            const response = await roomCall(app.h, {endpoint});
            assert.equal(response.statusCode, 500); assert.equal(JSON.stringify(response.payload).includes('private'), false);
        }
        app.h.assertSafeLogs(['private-provider', unknownToken]);
    }
    const corrupt = roomApp({evalRows: [roomMessage({roomId: 2})]});
    assert.equal((await roomCall(corrupt.h, {endpoint: 'room-messages'})).statusCode, 500);
});

test('rooms thunks expose separate pending/fulfilled statuses and protect creation from an old list', async () => {
    const list = deferred(), creation = deferred();
    const app = roomApp({fetch: (_, init) => init.method === 'POST' ? creation.promise : list.promise});
    const read = app.store.dispatch(app.fetchRooms());
    const create = app.store.dispatch(app.createRoom('New room'));
    assert.equal(app.store.getState().rooms.status, 'loading'); assert.equal(app.store.getState().rooms.createStatus, 'loading');
    creation.resolve(Response.json({room_id: 4, name: 'New room'}, {status: 201}));
    assert.equal(app.createRoom.fulfilled.match(await create), true);
    list.resolve(Response.json([])); await read;
    assert.equal(app.store.getState().rooms.items.length, 1);
    assert.equal(app.store.getState().rooms.items[0].name, 'New room');
});

for (const operation of ['fetchRooms', 'createRoom', 'fetchRoomMessages', 'sendRoomMessage']) {
    for (const [status, kind] of [[400, 'input'], [401, 'unauthorized'], [404, 'notFound'], [409, 'conflict'], [500, 'server'], [0, 'network']]) {
        test(`${operation} safely rejects ${status || 'network'} and cleans only refused sessions`, async () => {
            const app = roomApp({fetch: async () => {
                if (!status) throw new Error('private-network-detail');
                return new Response('private-provider-detail', {status});
            }});
            const thunk = operation === 'fetchRooms' ? app.fetchRooms() : operation === 'createRoom' ? app.createRoom('Test room')
                : operation === 'fetchRoomMessages' ? app.fetchRoomMessages(1) : app.sendRoomMessage({roomId: 1, content: 'private-room-text'});
            const result = await app.store.dispatch(thunk);
            assert.equal(result.payload.kind, kind); assert.equal(JSON.stringify(result.payload).includes('private-'), false);
            if (status === 401) {
                assert.equal(app.store.getState().auth.status, 'anonymous'); assertStorageCleared(app.h.storage);
                assert.equal(app.store.getState().rooms.items.length, 0); assert.equal(app.store.getState().roomMessages.roomId, null);
            } else {
                assert.equal(app.store.getState().auth.status, 'authenticated'); assert.equal(app.h.storage.getItem('token') === unknownToken, true);
                const state = operation.includes('RoomMessages') || operation === 'sendRoomMessage' ? app.store.getState().roomMessages : app.store.getState().rooms;
                assert.equal(state[operation === 'fetchRooms' ? 'status' : operation === 'createRoom' ? 'createStatus' : operation === 'fetchRoomMessages' ? 'readStatus' : 'sendStatus'], 'failed');
            }
            app.h.assertSafeLogs([unknownToken, 'private-network-detail', 'private-provider-detail', 'private-room-text']);
        });
    }
}

test('room messages thunks keep reading and sending separate and deduplicate confirmations', async () => {
    const read = deferred();
    const app = roomApp({fetch: async (_, init) => init.method === 'POST' ? Response.json(roomMessage(), {status: 201}) : read.promise});
    const reading = app.store.dispatch(app.fetchRoomMessages(1));
    assert.equal(app.store.getState().roomMessages.readStatus, 'loading');
    await app.store.dispatch(app.sendRoomMessage({roomId: 1, content: 'room-private-fixture'}));
    assert.equal(app.store.getState().roomMessages.sendStatus, 'succeeded');
    read.resolve(Response.json([roomMessage(), roomMessage()])); await reading;
    assert.equal(app.store.getState().roomMessages.items.length, 1);
    assert.equal(app.store.getState().messages.items.length, 0);
    assert.equal(app.store.getState().roomMessages.hasLoaded, true);
});

for (const operation of ['fetchRoomMessages', 'sendRoomMessage']) {
    test(`${operation} ignores results for another room and a cancelled request`, async () => {
        for (const cancel of [false, true]) {
            const request = deferred(); const app = roomApp({fetch: () => request.promise});
            const old = app.store.dispatch(operation === 'fetchRoomMessages' ? app.fetchRoomMessages(1)
                : app.sendRoomMessage({roomId: 1, content: 'room-private-fixture'}));
            if (cancel) old.abort(); else app.store.dispatch(app.openRoom(2));
            request.resolve(Response.json(operation === 'fetchRoomMessages' ? [roomMessage()] : roomMessage(), {status: operation === 'fetchRoomMessages' ? 200 : 201}));
            await old; await flush(); assert.equal(app.store.getState().roomMessages.items.length, 0);
        }
    });
}
for (const change of ['resetAuth', 'setUser', 'startChecking', 'sessionUnavailable']) {
    test(`${change} resets room state and ignores all late room operations`, async () => {
        for (const operation of ['fetchRooms', 'createRoom', 'fetchRoomMessages', 'sendRoomMessage']) {
            const request = deferred(); const app = roomApp({fetch: () => request.promise});
            const thunk = operation === 'fetchRooms' ? app.fetchRooms() : operation === 'createRoom' ? app.createRoom('Test room')
                : operation === 'fetchRoomMessages' ? app.fetchRoomMessages(1) : app.sendRoomMessage({roomId: 1, content: 'room-private-fixture'});
            const old = app.store.dispatch(thunk);
            app.store.dispatch(app.auth[change](change === 'setUser' ? {id: 3, username: 'new-user-fixture', externalId: 'new-public'} : undefined));
            request.resolve(Response.json(operation === 'fetchRooms' ? [{room_id: 1, name: 'General'}] : operation === 'createRoom' ? {room_id: 4, name: 'Test room'}
                : operation === 'fetchRoomMessages' ? [roomMessage()] : roomMessage(), {status: ['createRoom', 'sendRoomMessage'].includes(operation) ? 201 : 200}));
            await old; assert.equal(app.store.getState().rooms.items.length, 0); assert.equal(app.store.getState().roomMessages.items.length, 0);
            assert.equal(app.store.getState().roomMessages.roomId, null);
        }
    });
}

test('newer room history wins over an older 401 and never touches private state', async () => {
    const requests = [deferred(), deferred()]; let index = 0;
    const app = roomApp({fetch: () => requests[index++].promise});
    app.store.dispatch(app.fetchMessages.pending('private-state', 2));
    app.store.dispatch(app.fetchMessages.fulfilled([sampleMessage()], 'private-state', 2));
    const old = app.store.dispatch(app.fetchRoomMessages(1)); const current = app.store.dispatch(app.fetchRoomMessages(1));
    requests[1].resolve(Response.json([roomMessage()])); await current;
    requests[0].resolve(new Response('', {status: 401})); await old;
    assert.equal(app.store.getState().auth.status, 'authenticated');
    assert.equal(app.store.getState().roomMessages.items.length, 1); assert.equal(app.store.getState().messages.items.length, 1);
    assert.equal(app.h.storage.getItem('token') === unknownToken, true);
});

for (const bad of [{room_id: '1', name: 'General'}, {room_id: 1, name: ''}, null]) {
    test(`room API client validates list entry ${bad === null ? 'null' : typeof bad.room_id}`, async () => {
        const app = roomApp({fetch: async () => Response.json([bad])});
        const result = await app.store.dispatch(app.fetchRooms()); assert.equal(result.payload.kind, 'invalid');
    });
}

test('room API clients validate message shape and strip secret fields before Redux', async () => {
    for (const value of [roomMessage({roomId: 2}), roomMessage({senderName: ''}), roomMessage({createdAt: 'bad'}), roomMessage({content: ''})]) {
        const app = roomApp({fetch: async () => Response.json([value])});
        assert.equal((await app.store.dispatch(app.fetchRoomMessages(1))).payload.kind, 'invalid');
    }
    const requests = [];
    const app = roomApp({fetch: async (url, init) => {
        requests.push({url, init}); return Response.json([roomMessage({token: 'private-extra-token', email: 'private-extra-email'})]);
    }});
    await app.store.dispatch(app.fetchRoomMessages(1));
    assert.equal(requests[0].url, '/api/room-messages?roomId=1'); assert.equal(requests[0].init.cache, 'no-store');
    assert.equal(requests[0].init.headers.Authorization === `Bearer ${unknownToken}`, true);
    assert.equal(JSON.stringify(app.store.getState()).includes('private-extra'), false);
    assert.equal(JSON.stringify(app.store.getState()).includes(unknownToken), false);
});

test('rooms pages expose real links, escaped public names and protected dynamic routes', async () => {
    const app = roomApp({fetch: async () => Response.json([{room_id: 1, name: '<b>General</b>'}])});
    assert.equal(renderRoute(app.h, '/rooms').includes('Nom du nouveau salon'), true);
    await app.store.dispatch(app.fetchRooms());
    const markup = renderRoute(app.h, '/rooms');
    assert.match(markup, /href="\/rooms\/1"/); assert.match(markup, /&lt;b&gt;General/);
    assert.equal(markup.includes('<b>General'), false);
    assert.equal(markup.includes(unknownToken), false);
    assert.match(renderRoute(app.h, '/rooms/1'), /Salon : &lt;b&gt;General/);
    assert.match(renderRoute(app.h, '/rooms/abc'), /Identifiant de salon invalide/);
    assert.match(renderRoute(app.h, '/rooms/999'), /Salon introuvable/);
    app.store.dispatch(app.auth.resetAuth());
    assert.equal(renderRoute(app.h, '/rooms/1').includes('General'), false);
});

test('direct room reload waits for session restoration then for room metadata', async () => {
    const h = harness();
    assert.match(renderRoute(h, '/rooms/1'), /Vérification de la session/);
    await frontendLogin(h);
    const store = h.load('src/app/store.ts').store;
    store.dispatch(h.load('src/features/auth/authSlice.ts').setUser({id: 1, username: fixture.username, externalId: fixture.externalId}));
    assert.match(renderRoute(h, '/rooms/1'), /Chargement du salon/);
    await store.dispatch(h.load('src/features/rooms/roomsSlice.ts').fetchRooms());
    assert.match(renderRoute(h, '/rooms/1'), /Salon : General/);
});

test('the shared polling handles rooms, StrictMode, hidden/offline suspension and cleanup', async () => {
    let calls = 0; const old = deferred();
    const app = pollingApp({fetch: async url => {
        assert.equal(url, '/api/room-messages?roomId=1'); return ++calls === 1 ? old.promise : Response.json([roomMessage()]);
    }});
    const roomSlice = app.h.load('src/features/rooms/roomMessagesSlice.ts'); app.store.dispatch(roomSlice.openRoom(1));
    const first = app.mount(1, 'room'); first.cleanup(); const current = app.mount(1, 'room'); await flush();
    assert.equal(calls, 2); assert.equal(app.store.getState().roomMessages.items.length, 1);
    await app.advance(8000); assert.equal(calls, 3);
    app.browser.document.visibilityState = 'hidden'; app.browser.document.emit('visibilitychange');
    await app.advance(16000); assert.equal(calls, 3);
    app.browser.document.visibilityState = 'visible'; app.browser.document.emit('visibilitychange'); await flush(); assert.equal(calls, 4);
    app.browser.navigator.onLine = false; app.browser.window.emit('offline'); await app.advance(16000); assert.equal(calls, 4);
    app.browser.navigator.onLine = true; app.browser.window.emit('online'); await flush(); assert.equal(calls, 5);
    old.resolve(Response.json([])); await flush(); assert.equal(app.store.getState().roomMessages.items.length, 1);
    current.cleanup(); await app.advance(16000); assert.equal(calls, 5);
});

test('room polling switches room safely and stops on a current 401', async () => {
    let calls = 0;
    const app = pollingApp({fetch: async () => ++calls === 1 ? Response.json([roomMessage()]) : new Response('', {status: 401})});
    const roomSlice = app.h.load('src/features/rooms/roomMessagesSlice.ts'); app.store.dispatch(roomSlice.openRoom(1));
    const first = app.mount(1, 'room'); await flush(); first.cleanup();
    app.store.dispatch(roomSlice.openRoom(2)); const second = app.mount(2, 'room'); await flush();
    assert.equal(app.store.getState().auth.status, 'anonymous'); assertStorageCleared(app.h.storage);
    await app.advance(60000); assert.equal(calls, 2); assert.equal(app.store.getState().roomMessages.items.length, 0);
    second.cleanup();
});

test('room metadata refreshes on entry even after an older list was cached', async () => {
    let store, effect, dependencies, calls = 0;
    const app = roomApp({fetch: async () => Response.json(++calls === 1 ? [{room_id: 1, name: 'General'}]
        : [{room_id: 1, name: 'General'}, {room_id: 4, name: 'Created elsewhere'}]),
        react: {useEffect: (setup, deps) => {effect = setup; dependencies = deps;}},
        reactRedux: {useDispatch: () => store.dispatch, useSelector: selector => selector(store.getState())},
    });
    store = app.store; await store.dispatch(app.fetchRooms());
    assert.equal(store.getState().rooms.items.length, 1);
    app.h.load('src/features/rooms/useRooms.ts').useRooms(4);
    const cleanup = effect(); await flush();
    assert.equal(calls, 2); assert.equal(store.getState().rooms.items.some(room => room.room_id === 4), true);
    assert.equal(dependencies.includes(4), true); cleanup();
});

// Étape 10 : uniquement des SDK / données simulés, aucune publication réelle.
for (const scenario of ['absent', 'expired', 'forged', 'missing-config', 'valid', 'redis-error', 'method']) {
    test(`Beams endpoint: ${scenario}`, async () => {
        const {h} = messagesApp({env: scenario === 'missing-config' ? {PUSHER_SECRET_KEY: ''} : {},
            redisError: scenario === 'redis-error' ? new Error('private-provider-detail') : undefined});
        if (scenario === 'expired') h.sessions.get(unknownToken).expiresAt = 0;
        const response = nodeResponse();
        await h.load('api/beams.js').default({method: scenario === 'method' ? 'POST' : 'GET',
            ...protectedRequest(scenario === 'absent' ? null : unknownToken),
            query: {user_id: scenario === 'forged' ? 'other-account' : fixture.externalId}}, response);
        const expected = ['absent', 'expired', 'forged'].includes(scenario) ? 401
            : ['missing-config', 'redis-error'].includes(scenario) ? 503 : scenario === 'method' ? 405 : 200;
        assert.equal(response.statusCode, expected);
        assert.equal(response.replies, 1);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(h.calls.beams, expected === 200 ? 1 : 0);
        assert.equal(JSON.stringify(response.payload).includes('fixture-key'), false);
        h.assertSafeLogs([unknownToken, 'private-provider-detail', fixture.externalId]);
    });
}

for (const scenario of ['success', 'push-failure', 'redis-failure', 'missing-config', 'recipient-not-found']) {
    test(`private push after storage: ${scenario}`, async () => {
        const {h} = messagesApp({userRows: scenario === 'recipient-not-found' ? [] : [{user_id: 2, external_id: 'recipient-beams-fixture'}],
            pushError: scenario === 'push-failure' ? new Error('private-provider-detail fixture-key') : undefined,
            messageError: scenario === 'redis-failure' ? new Error('private-redis-detail') : undefined,
            env: scenario === 'missing-config' ? {PUSHER_INSTANCE_ID: ''} : {}});
        const result = await messageCall(h, {method: 'POST', body: {recipientId: 2, senderId: 999,
            externalId: 'forged-recipient', url: 'https://attacker.invalid', content: 'private-push-text'}});
        assert.equal(result.statusCode, scenario === 'redis-failure' ? 500 : scenario === 'recipient-not-found' ? 404 : 201);
        const publishes = ['success', 'push-failure'].includes(scenario) ? 1 : 0;
        assert.equal(h.calls.push.length, publishes);
        if (publishes) {
            const call = h.calls.push[0];
            assert.equal(call.writes, 1);
            assert.equal(JSON.stringify(call.users), JSON.stringify(['recipient-beams-fixture']));
            assert.equal(call.payload.web.data.path, '/messages/user/1');
            for (const value of ['private-push-text', 'forged-recipient', fixture.externalId, unknownToken, '999', 'attacker'])
                assert.equal(JSON.stringify(call.payload).includes(value), false);
        }
        assert.equal(h.messageSets.size, ['redis-failure', 'recipient-not-found'].includes(scenario) ? 0 : 1);
        h.assertSafeLogs([unknownToken, 'private-push-text', 'fixture-key', 'private-provider-detail', 'private-redis-detail']);
    });
}
test('rooms never publish push notifications', async () => {
    const {h} = roomApp();
    assert.equal((await roomCall(h, {endpoint: 'room-messages', method: 'POST', body: {roomId: 1, content: 'room-no-push'}})).statusCode, 201);
    assert.equal(h.calls.push.length, 0);
});

function pushApp(options = {}) {
    const events = []; let permission = options.permission ?? 'default'; let associated = options.previous ?? null;
    const pending = options.startPending;
    let stops = 0; let unauthorized = 0;
    class Client {
        constructor() { events.push('construct'); if (options.initError) throw options.initError; }
        async getUserId() { return associated; }
        async getDeviceId() { return associated ? 'test-device' : null; }
        async start() { events.push('start'); if (options.startError) throw options.startError; if (pending) await pending.promise; }
        async setUserId(id, provider) {
            events.push(`associate:${id}`);
            await provider.fetchToken(id);
            if (options.associationError) throw options.associationError;
            associated = id;
        }
        async stop() { stops++; events.push('stop'); if (options.stopError) throw new Error('private-sdk-error'); associated = null; }
    }
    class TokenProvider {
        constructor(config) { assert.equal(config.url, '/api/beams'); assert.equal(config.headers.Authorization, 'Bearer test-session'); }
        async fetchToken(id) { events.push(`authorize:${id}`); if (options.authError) throw new Error(`Unexpected status code ${options.authError}: ${options.authError === 503 ? 'PUSH_NOT_CONFIGURED, ' : ''}private-detail`); return {token: 'test-beams'}; }
    }
    const h = harness();
    const controller = h.load('src/features/notifications/pushController.ts').createPushController({
        instanceId: options.config === false ? '' : 'public-instance', supported: () => options.supported !== false,
        permission: () => permission,
        requestPermission: async () => {events.push('permission'); permission = options.answer ?? 'granted'; return permission;},
        loadSDK: async () => ({Client, TokenProvider}), token: () => 'test-session', unauthorized: () => {unauthorized++;},
    });
    return {controller, events, h, get associated() {return associated;}, get stops() {return stops;}, get unauthorized() {return unauthorized;}};
}
for (const scenario of ['unconfigured', 'unsupported', 'granted', 'denied', 'refused', 'dismissed', 'auth401', 'auth503']) {
    test(`push frontend permission/configuration: ${scenario}`, async () => {
        const app = pushApp({config: scenario !== 'unconfigured', supported: scenario !== 'unsupported',
            permission: scenario === 'denied' ? 'denied' : scenario === 'granted' ? 'granted' : 'default',
            answer: scenario === 'refused' ? 'denied' : scenario === 'dismissed' ? 'default' : 'granted',
            authError: scenario === 'auth401' ? 401 : scenario === 'auth503' ? 503 : undefined});
        await app.controller.setIdentity('account-a');
        assert.equal(app.events.includes('permission'), false);
        assert.equal(app.events.includes('start'), false);
        await app.controller.enable();
        const expected = ['unconfigured', 'unsupported'].includes(scenario) ? scenario
            : ['denied', 'refused'].includes(scenario) ? 'denied' : scenario === 'dismissed' ? 'disabled'
            : scenario === 'auth401' ? 'error' : scenario === 'auth503' ? 'unconfigured' : 'active';
        assert.equal(app.controller.getSnapshot(), expected);
        assert.equal(app.unauthorized, scenario === 'auth401' ? 1 : 0);
        assert.equal(app.events.filter(event => event === 'permission').length,
            ['unconfigured', 'unsupported', 'denied', 'granted'].includes(scenario) ? 0 : 1);
        if (expected === 'denied') {await app.controller.enable(); assert.equal(app.events.filter(event => event === 'permission').length, scenario === 'refused' ? 1 : 0);}
        app.h.assertSafeLogs(['test-session', 'test-beams', 'private-detail']);
    });
}
test('push enable, account switch, disable and logout clean old associations', async () => {
    const app = pushApp(); let notifications = 0;
    const unsubscribe = app.controller.subscribe(() => notifications++);
    await app.controller.setIdentity('account-a'); await app.controller.enable();
    assert.equal(app.associated, 'account-a');
    await app.controller.setIdentity('account-b');
    assert.equal(app.associated, null); assert.equal(app.controller.getSnapshot(), 'disabled');
    await app.controller.enable(); assert.equal(app.associated, 'account-b');
    await app.controller.disable(); assert.equal(app.associated, null);
    await app.controller.enable(); await app.controller.setIdentity(null);
    assert.equal(app.associated, null); assert.equal(app.controller.getSnapshot(), 'disabled');
    assert.equal(notifications > 0, true); unsubscribe();
});
test('pending activation cannot associate old account after logout or a switch', async () => {
    const pending = deferred(); const app = pushApp({startPending: pending});
    await app.controller.setIdentity('account-a');
    const enabling = app.controller.enable(); await flush();
    const switching = app.controller.setIdentity('account-b'); pending.resolve();
    await enabling; await switching;
    assert.equal(app.associated, null);
    assert.equal(app.events.includes('associate:account-a'), false);
    assert.equal(app.controller.getSnapshot(), 'disabled');
});
test('existing association restored without automatic start or permission', async () => {
    const app = pushApp({previous: 'account-a', permission: 'granted'});
    await app.controller.setIdentity('account-a');
    assert.equal(app.controller.getSnapshot(), 'active');
    assert.equal(app.events.includes('start'), false); assert.equal(app.events.includes('permission'), false);
});
test('failed cleanup prevents associating a new account and can be retried', async () => {
    const app = pushApp({previous: 'account-a', permission: 'granted', stopError: true});
    await app.controller.setIdentity('account-b'); assert.equal(app.controller.getSnapshot(), 'error');
    await app.controller.enable(); assert.equal(app.controller.getSnapshot(), 'error');
    assert.equal(app.events.includes('associate:account-b'), false);
});

test('service worker sanitizes display and validates click destinations before the SDK handler', async () => {
    const handlers = {}; const opened = []; let importedAfterClick = false;
    const sdk = {};
    const self = {location: {origin: 'https://urc.invalid'}, clients: {openWindow: async url => opened.push(url)},
        addEventListener: (type, handler) => {handlers[type] = handler;}};
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/service-worker.js'), 'utf8'), {
        self, URL, PusherPushNotifications: sdk, importScripts: url => {
            assert.equal(url, 'https://js.pusher.com/beams/service-worker.js'); importedAfterClick = !!handlers.notificationclick;
        }, console: {log() {throw new Error('Unexpected SW log');}},
    });
    assert.equal(importedAfterClick, true);
    for (const [input, expected] of [['/messages/user/2', '/messages/user/2'], ['https://attacker.invalid', '/messages'],
        ['//attacker.invalid', '/messages'], ['/messages/user/2?token=sensitive', '/messages'],
        ['/messages/user/2147483648', '/messages'], ['/messages/user/0', '/messages'], [undefined, '/messages']]) {
        let sanitized; let work;
        sdk.onNotificationReceived({payload: {notification: {title: 'private-title', body: 'private-text', deep_link: 'https://attacker.invalid'}, data: {path: input, token: 'secret'}},
            pushEvent: {waitUntil: promise => {work = promise;}}, handleNotification: async payload => {sanitized = payload;}});
        await work;
        assert.equal(JSON.stringify(sanitized).includes('private-'), false);
        assert.equal(JSON.stringify(sanitized).includes('secret'), false);
        let stopped = false; let closed = false;
        handlers.notificationclick({stopImmediatePropagation() {stopped = true;}, notification: {
            data: {pusher: {customerPayload: sanitized}}, close() {closed = true;}}, waitUntil: promise => {work = promise;}});
        await work; assert.equal(stopped && closed, true); assert.equal(opened.at(-1), 'https://urc.invalid' + expected);
    }
});

test('frontend references only public Beams configuration and Vercel serves the worker as static JS', () => {
    for (const filename of ['src/features/notifications/usePushNotifications.ts', 'src/features/notifications/pushController.ts', 'public/service-worker.js']) {
        assert.equal(fs.readFileSync(path.join(root, filename), 'utf8').includes('PUSHER_SECRET_KEY'), false);
    }
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const pattern = new RegExp('^' + config.rewrites[0].source + '$');
    assert.equal(pattern.test('/service-worker.js'), false);
});

test('reading private messages does not publish push', async () => {
    const {h} = messagesApp({userRows: [{user_id: 2, external_id: 'recipient-beams-fixture'}]});
    assert.equal((await messageCall(h)).statusCode, 200);
    assert.equal(h.calls.push.length, 0);
});
test('requestPermission rejection is handled without an unhandled rejection', async () => {
    const h = harness();
    const controller = h.load('src/features/notifications/pushController.ts').createPushController({
        instanceId: 'public', supported: () => true, permission: () => 'default',
        requestPermission: async () => {throw new Error('private-permission-detail');},
        loadSDK: async () => ({Client: class {
            async getUserId() {return null;}
            async stop() {}
        }}), token: () => null, unauthorized() {},
    });
    await controller.setIdentity('account-a'); await controller.enable();
    assert.equal(controller.getSnapshot(), 'error'); h.assertSafeLogs(['private-permission-detail']);
});
test('slow push publication cannot hold the stored message response indefinitely', async () => {
    let timeout;
    const {h} = messagesApp({userRows: [{user_id: 2, external_id: 'recipient-beams-fixture'}],
        pushPending: new Promise(() => {}), browser: {setTimeout(callback, delay) {
            timeout = delay; return setTimeout(callback, 0);
        }}});
    const response = await messageCall(h, {method: 'POST', body: {recipientId: 2, content: 'private-timeout-fixture'}});
    assert.equal(response.statusCode, 201); assert.equal(timeout, 3000);
    assert.equal(h.messageSets.size, 1); assert.equal(h.calls.push.length, 1);
    h.assertSafeLogs(['private-timeout-fixture']);
});

for (const [failure, stage, reason] of [
    ['redisError', 'session', 'redis_access_denied'],
    ['sqlError', 'recipient_lookup', 'database_column_missing'],
    ['messageError', 'history_read', 'redis_wrong_type'],
]) {
    test(`message diagnostics classify ${stage} without exposing provider details`, async () => {
        const error = Object.assign(new Error('NOPERM WRONGTYPE sensitive-provider-fixture'), {code: '42703'});
        if (failure !== 'sqlError') delete error.code;
        if (failure === 'redisError') error.message = 'NOPERM sensitive-provider-fixture';
        const {h} = messagesApp({[failure]: error});
        const result = await messageCall(h);
        assert.equal(result.statusCode, 500);
        assert.equal(JSON.stringify(h.logs), JSON.stringify([['MESSAGES_UNAVAILABLE', {stage, reason}]]));
        h.assertSafeLogs(['sensitive-provider-fixture']);
    });
}

for (const scenario of ['development', 'production', 'missing-file', 'inherited', 'local-region', 'production-region', 'unspecified']) {
    test(`Beams local environment fallback: ${scenario}`, () => {
        const h = harness({env: {VERCEL_ENV: ['production', 'production-region'].includes(scenario) ? 'production'
                : ['local-region', 'unspecified'].includes(scenario) ? undefined : 'development',
            NOW_REGION: ['local-region', 'production-region'].includes(scenario) ? 'dev1' : undefined,
            PUSHER_INSTANCE_ID: scenario === 'inherited' ? 'inherited-instance' : '',
            PUSHER_SECRET_KEY: scenario === 'inherited' ? 'inherited-key' : ''},
            localEnv: scenario === 'missing-file' ? undefined
                : 'PUSHER_INSTANCE_ID=local-instance\nPUSHER_SECRET_KEY=local-test-key\n'});
        const client = h.load('lib/beams.js').getBeamsClient();
        assert.equal(client !== null, ['development', 'inherited', 'local-region'].includes(scenario));
        assert.equal(h.calls.localConfig ?? 0, ['production', 'inherited', 'production-region', 'unspecified'].includes(scenario) ? 0 : 1);
        h.assertSafeLogs(['local-test-key', 'inherited-key']);
    });
}

for (const stage of ['initialization', 'cleanup', 'registration', 'authentication', 'association']) {
    test(`push failures expose only safe ${stage} diagnostics`, async () => {
        const error = new Error('Unexpected status code 400: private-error test-session test-beams');
        const app = pushApp({initError: stage === 'initialization' ? error : undefined,
            stopError: stage === 'cleanup', startError: stage === 'registration' ? error : undefined,
            authError: stage === 'authentication' ? 400 : undefined,
            associationError: stage === 'association' ? error : undefined});
        await app.controller.setIdentity('account-a');
        await app.controller.enable();
        assert.equal(app.controller.getSnapshot(), 'error');
        const failure = app.controller.getFailureSnapshot();
        assert.equal(failure.stage, stage);
        assert.equal(failure.httpStatus, stage === 'cleanup' ? undefined : 400);
        for (const secret of ['private-error', 'test-session', 'test-beams']) assert.equal(JSON.stringify(failure).includes(secret), false);
        app.h.assertSafeLogs(['private-error', 'test-session', 'test-beams']);
    });
}
