// Vérifie de vrais paquets @vercel/node dans /tmp, sans installation, réseau ni déploiement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {nodeFileTrace} = require('@vercel/nft');
const {build} = require('@vercel/node');
const {FileFsRef, FileBlob} = require('@vercel/build-utils');

const root = path.resolve(__dirname, '..');

test('Vercel packages authentication and messages with the PostgreSQL Node entrypoint', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'urc-packaging-'));
    const source = path.join(temporary, 'source');
    try {
        const entries = ['api/login.js', 'api/register.js', 'api/message.js', 'api/rooms.js', 'api/room-messages.js'];
        const {fileList} = await nodeFileTrace(entries, {
            base: root, mixedModules: true, moduleSyncCatchall: true,
        });
        for (const file of fileList) {
            assert.equal(file.startsWith('..'), false);
            const destination = path.join(source, file);
            await fs.mkdir(path.dirname(destination), {recursive: true});
            await fs.copyFile(path.join(root, file), destination);
        }
        // Présent après npm install, mais peut manquer dans le résultat du traçage ESM.
        await fs.cp(path.join(root, 'node_modules/@vercel/postgres/dist'),
            path.join(source, 'node_modules/@vercel/postgres/dist'), {recursive: true});
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        assert.equal(typeof pkg.dependencies['@vercel/postgres'], 'string');
        // Version du Node local uniquement, pas de modification du package du projet.
        pkg.engines = {node: `${process.versions.node.split('.')[0]}.x`};
        await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(pkg));
        const config = JSON.parse(await fs.readFile(path.join(root, 'vercel.json'), 'utf8'));

        for (const entrypoint of entries) {
            await t.test(`${entrypoint}: isolated startup and validation`, async () => {
                const {output} = await build({
                    files: {[entrypoint]: new FileFsRef({fsPath: path.join(source, entrypoint)})},
                    entrypoint, workPath: source, meta: {}, considerBuildCommand: true,
                    config: {
                        zeroConfig: true,
                        // Aucun npm install ni build Vite dans cette copie réduite.
                        projectSettings: {installCommand: '', buildCommand: 'node -e ""'},
                        ...config.functions?.[entrypoint],
                    },
                });
                assert.equal(Object.hasOwn(output.files,
                    'node_modules/@vercel/postgres/dist/index-node.cjs'), true);
                // Placé à côté de source : aucune remontée vers ses node_modules possible.
                const artifact = path.join(temporary, path.basename(entrypoint, '.js'));
                for (const [name, file] of Object.entries(output.files)) {
                    const destination = path.join(artifact, name);
                    await fs.mkdir(path.dirname(destination), {recursive: true});
                    const blob = await FileBlob.fromStream({stream: file.toStream()});
                    await fs.writeFile(destination, blob.data);
                }

                const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
                const previous = keys.map(key => process.env[key]);
                let route;
                try {
                    process.env[keys[0]] = 'https://redis.invalid';
                    process.env[keys[1]] = 'synthetic-packaging-fixture';
                    route = require(path.join(artifact, entrypoint)).default;
                } finally {
                    keys.forEach((key, index) => {
                        if (previous[index] === undefined) delete process.env[key];
                        else process.env[key] = previous[index];
                    });
                }
                if (['api/message.js', 'api/rooms.js', 'api/room-messages.js'].includes(entrypoint)) {
                    const response = {status(code) { this.code = code; return this; },
                        setHeader() {}, json(body) { this.body = body; return this; }};
                    await route({method: 'GET', headers: {}, query: {userId: '2'}}, response);
                    assert.equal(response.code, 401);
                    assert.equal(response.body.code, 'UNAUTHORIZED');
                    return;
                }
                const get = await route.fetch(new Request('https://urc.invalid/' + entrypoint));
                assert.equal(get.status, 405);
                const post = await route.fetch(new Request('https://urc.invalid/' + entrypoint, {
                    method: 'POST', headers: {'content-type': 'application/json'}, body: '{}',
                }));
                assert.equal(post.status, 400);
                const passwords = require(path.join(artifact, 'lib/password.js'));
                const password = 'synthetic-packaging-password';
                const encoded = await passwords.hashPassword(password);
                assert.equal(await passwords.verifyPassword('fixture', password, encoded), true);
            });
        }
    } finally {
        await fs.rm(temporary, {recursive: true, force: true});
    }
});
