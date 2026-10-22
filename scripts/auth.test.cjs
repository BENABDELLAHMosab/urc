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
            Headers, Request, Response, Error, AbortController, DOMException, crypto: webcrypto, btoa,
            FormData: options.FormData || FormData,
            process: {env: {PUSHER_INSTANCE_ID: 'fixture-instance', PUSHER_SECRET_KEY: 'fixture-key'}},
            console: Object.fromEntries(['log', 'error', 'warn'].map(method => [method,
                (...args) => logs.push(args)])),
            sessionStorage: storage,
            fetch: options.fetch || (async (url, init) => {
                assert.equal(['/api/login', '/api/me'].includes(url), true);
                return load(url === '/api/me' ? 'api/me.js' : 'api/login.js')
                    .default(new Request('https://urc.invalid' + url, init));
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
    const login = await h.load('api/login.js').default(loginRequest());
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
    const login = await h.load('api/login.js').default(loginRequest());
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
            : app.h.load('api/login.js').default(new Request('https://urc.invalid/api/login', init))});
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
