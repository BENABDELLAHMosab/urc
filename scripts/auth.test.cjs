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
    const calls = {get: 0, set: 0, hset: 0, list: 0, update: 0, beams: 0, insert: 0, release: 0, eval: 0, lookup: 0};
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
        if (query.startsWith('select user_id from users where user_id')) {
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
        generateToken() {
            calls.beams++;
            return {token: 'fixture-beams-token'};
        }
    }
    const cache = new Map();
    const dependencies = {
        '@upstash/redis': {Redis: {fromEnv: () => redis}},
        '@vercel/postgres': {db, sql},
        '@pusher/push-notifications-server': FakeBeams,
        '@reduxjs/toolkit': require('@reduxjs/toolkit'),
        'react-redux': options.reactRedux || require('react-redux'),
        'react-router-dom': {...require('react-router-dom'), ...options.reactRouter, useLocation: options.reactRouter ? () => ({state: null}) : require('react-router-dom').useLocation},
        '@node-rs/argon2': require('@node-rs/argon2'),
        'validator/lib/isEmail.js': require('validator/lib/isEmail.js'),
        'node:crypto': require('node:crypto'),
        react: options.react || require('react'),
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
        const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
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
            process: {env: {PUSHER_INSTANCE_ID: 'fixture-instance', PUSHER_SECRET_KEY: 'fixture-key'}},
            console: Object.fromEntries(['log', 'error', 'warn'].map(method => [method,
                (...args) => logs.push(args)])),
            sessionStorage: storage,
            fetch: options.fetch || (async (url, init) => {
                const address = new URL(url, 'https://urc.invalid');
                const route = address.pathname;
                assert.equal(['/api/login', '/api/me', '/api/register', '/api/users', '/api/message'].includes(route), true);
                const module = load(route.slice(1) + '.js');
                if (route === '/api/message') {
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
        load, storage, sessions, calls, users, messageSets,
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
        mount(id = 2) {
            cursor = 0;
            const refresh = app.h.load('src/features/messages/useMessagePolling.ts').useMessagePolling(id);
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
