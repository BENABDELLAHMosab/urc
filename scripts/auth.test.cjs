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
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); },
    };
}

function harness(options = {}) {
    let now = 0;
    const logs = [];
    const sessions = new Map();
    const calls = {get: 0, set: 0, hset: 0, list: 0, update: 0, beams: 0};
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
    };
    const sql = async () => {
        calls.list++;
        return {rowCount: 1, rows: [{user_id: fixture.id, username: fixture.username, last_login: null}]};
    };
    const db = {
        async connect() {
            if (options.dbError) throw options.dbError;
            return {
                async sql(parts, ...values) {
                    if (parts.join('?').startsWith('select')) {
                        const expectedHash = createHash('sha256')
                            .update(fixture.username + fixture.password).digest('base64');
                        const valid = values[0] === fixture.username && values[1] === expectedHash;
                        return {
                            rowCount: valid ? 1 : 0,
                            rows: valid ? [{user_id: fixture.id, username: fixture.username,
                                email: fixture.email, external_id: fixture.externalId}] : [],
                        };
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
        'react-router-dom': options.reactRouter || require('react-router-dom'),
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
            Headers, Request, Response, Error, crypto: webcrypto, btoa,
            FormData: options.FormData || FormData,
            process: {env: {PUSHER_INSTANCE_ID: 'fixture-instance', PUSHER_SECRET_KEY: 'fixture-key'}},
            console: Object.fromEntries(['log', 'error', 'warn'].map(method => [method,
                (...args) => logs.push(args)])),
            sessionStorage: storage,
            fetch: options.fetch || (async (url, init) => {
                assert.equal(url, '/api/login');
                return load('api/login.js').default(new Request('https://urc.invalid/api/login', init));
            }),
        }, {filename});
        return module.exports;
    }
    return {
        load, storage, sessions, calls,
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
    const response = await h.load('api/login.js').default(loginRequest());
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
    const response = await h.load('api/login.js').default(loginRequest('wrong-fixture-password'));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'UNAUTHORIZED');
    assert.equal(h.calls.set, 0);
    assert.equal(h.calls.update, 0);
    h.assertSafeLogs();
});

test('expired session returns 401 rather than 500', async () => {
    const h = harness();
    const login = await h.load('api/login.js').default(loginRequest());
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
    const login = await h.load('api/login.js').default(loginRequest());
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
    assert.equal((await db.load('api/login.js').default(loginRequest())).status, 500);
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

test('auth reducer starts anonymous and ignores unrelated actions', () => {
    const reducer = harness().load('src/features/auth/authSlice.ts').default;
    const state = reducer(undefined, {type: 'unrelated'});
    assert.equal(state.user, null);
    assert.equal(state.status, 'anonymous');
    assert.deepEqual(Object.keys(state).sort(), ['status', 'user']);
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
    assert.equal(previous.status, 'anonymous');
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

test('a fresh Redux store does not restore a user from sessionStorage', () => {
    const h = harness();
    const {store} = h.load('src/app/store.ts');
    const markup = renderToStaticMarkup(createElement(Provider, {store},
        createElement(MemoryRouter, null, createElement(h.load('src/user/Login.tsx').Login))));
    assert.equal(store.getState().auth.user, null);
    assert.equal(store.getState().auth.status, 'anonymous');
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

test('/messages is accessible anonymously without a status-based redirect', () => {
    const h = harness();
    const markup = renderRoute(h, '/messages');
    assert.match(markup, /UBO Relay Chat/);
    assert.match(markup, /La messagerie sera développée prochainement/);
    assert.equal(markup.includes('Connecté'), false);
    assert.equal(h.load('src/app/store.ts').store.getState().auth.status, 'anonymous');
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
