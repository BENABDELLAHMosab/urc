// Firefox réel, SDK et API simulés : aucune souscription ni publication Pusher réelle.
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer, build} from 'vite';
import WebSocket from 'ws';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'urc-push-browser-'));
let server, browser, socket;
let documentRequests = 0;
const messages = [];
let mode = 'valid';
let authCalls = 0;
let messageCalls = 0;
const user = 'browser-fixture-user';
const password = 'browser-fixture-password';
const freshToken = '00000000-0000-4000-8000-000000000003';
const mockSDK = `
export class Client {
    constructor() {window.__pushCalls.push('construct');}
    async getUserId() {return localStorage.getItem('test-push-user');}
    async getDeviceId() {return localStorage.getItem('test-push-user') ? 'test-device' : null;}
    async start() {window.__pushCalls.push('start');if(window.__registrationFail)throw new Error('Unexpected status code 400: private-provider-detail');}
    async stop() {window.__pushCalls.push('stop');localStorage.removeItem('test-push-user');}
    async setUserId(id, provider) {await provider.fetchToken(id);localStorage.setItem('test-push-user',id);window.__pushCalls.push('associate');}
}
export class TokenProvider {
    constructor(options) {this.options=options;}
    async fetchToken(id) {
        const response=await fetch(this.options.url+'?user_id='+encodeURIComponent(id),{headers:this.options.headers});
        if(!response.ok)throw new Error('Unexpected status code '+response.status+': PUSH_NOT_CONFIGURED, fixture-error');
        return response.json();
    }
}`;
try {
    server = await createServer({root: workspace, envFile: false, configLoader: 'runner',
        cacheDir: join(temporary, 'cache'),
        define: {'import.meta.env.VITE_PUSHER_INSTANCE_ID': JSON.stringify('test-public-instance')},
        server: {host: '127.0.0.1', port: 0, hmr: false},
        plugins: [{name:'fake-beams', enforce:'pre',
            resolveId(source) {if(source==='@pusher/push-notifications-web')return '\0fake-beams';},
            load(id) {if(id==='\0fake-beams')return mockSDK;},
            configureServer(vite) {vite.middlewares.use(async(req,res,next)=>{
                if(req.headers.accept?.includes('text/html'))documentRequests++;
                if(!req.url.startsWith('/api/'))return next();
                res.setHeader('Content-Type','application/json');
                const reply=(body,status=200)=>{res.statusCode=status;res.end(JSON.stringify(body));};
                if(req.url==='/api/login')return reply({id:1,username:user,externalId:'browser-public-id',token:freshToken});
                if(req.url==='/api/me')return req.headers.authorization==='Bearer '+freshToken
                    ?reply({id:1,username:user,externalId:'browser-public-id'}):reply({code:'UNAUTHORIZED'},401);
                if(req.url==='/api/users')return reply([{user_id:1,username:user,last_login:null},{user_id:2,username:'recipient',last_login:null}]);
                if(req.url.startsWith('/api/beams')){
                    authCalls++;
                    assert.equal(req.headers.authorization==='Bearer '+freshToken,true);
                    assert.equal(new URL(req.url,'http://fixture.invalid').searchParams.get('user_id'),'browser-public-id');
                    return reply(mode==='valid'?{token:'test-beams-token'}:{code:'PUSH_NOT_CONFIGURED'},mode==='valid'?200:503);
                }
                if(req.url.startsWith('/api/message')){
                    messageCalls++;
                    if(req.method==='POST'){
                        let raw='';for await(const chunk of req)raw+=chunk;
                        const body=JSON.parse(raw);
                        return reply({id:crypto.randomUUID(),senderId:1,recipientId:2,content:body.content,createdAt:new Date().toISOString()},201);
                    }
                    return reply([]);
                }
                reply({},404);
            });},
        }],
    });
    await server.listen();
    const origin = 'http://127.0.0.1:'+server.httpServer.address().port;
    const profile = join(temporary, 'firefox-profile');
    const {mkdir} = await import('node:fs/promises');
    await mkdir(profile);
    await writeFile(join(profile, 'user.js'), 'user_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("toolkit.telemetry.enabled", false);\n');
    browser = spawn('/usr/bin/firefox', ['--headless', '--no-remote', '--profile', profile,
        '--remote-debugging-port', '0'], {stdio: ['ignore', 'pipe', 'pipe']});
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Firefox debugging endpoint unavailable')), 20000);
        let output = '';
        const consume = chunk => {
            output += chunk.toString();
            const match = output.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        };
        browser.stdout.on('data', consume);
        browser.stderr.on('data', consume);
        browser.once('error', error => {clearTimeout(timer); reject(error);});
        browser.once('exit', code => {clearTimeout(timer); reject(new Error(`Firefox exited before startup (${code})`));});
    });
    socket = new WebSocket(endpoint.replace(/\/$/, '') + '/session');
    await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
    let sequence = 0;
    const pending = new Map();
    socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.method === 'log.entryAdded') messages.push(event.params.text || '');
        if (!event.id) return;
        const entry = pending.get(event.id);
        if (!entry) return;
        pending.delete(event.id);
        clearTimeout(entry.timer);
        if (event.type === 'error') entry.reject(new Error(`BiDi ${event.error}: ${event.message}`));
        else entry.resolve(event.result);
    });
    const command = (method, params) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {pending.delete(id); reject(new Error(`BiDi timeout: ${method}`));}, 15000);
        pending.set(id, {resolve, reject, timer});
        socket.send(JSON.stringify({id, method, params}));
    });
    await command('session.new', {capabilities: {alwaysMatch: {acceptInsecureCerts: true}}});
    await command('session.subscribe', {events: ['log.entryAdded']});
    await command('script.addPreloadScript', {functionDeclaration: `() => {
        window.__pushCalls=[];window.__permission=localStorage.getItem('test-push-user')?'granted':'default';window.__permissionAnswer='granted';
        Object.defineProperty(window,'Notification',{configurable:true,value:class {
            static get permission(){return window.__permission;}
            static async requestPermission(){window.__pushCalls.push('permission');window.__permission=window.__permissionAnswer;return window.__permission;}
        }});
        const original = window.setTimeout.bind(window);
        window.__pollDelays = [];
        window.setTimeout = (callback, delay, ...args) => {
            if (delay === 8000) window.__pollDelays.push(delay);
            return original(callback, delay === 8000 ? 250 : delay, ...args);
        };
        window.__pollVisible = true; window.__pollOnline = true;
        Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => window.__pollVisible ? 'visible' : 'hidden'});
        Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => window.__pollOnline});
    }`});
    const {context} = await command('browsingContext.create', {type: 'tab'});
    const evaluate = async expression => {
        const response = await command('script.evaluate', {expression, target: {context}, awaitPromise: true});
        assert.equal(response.type, 'success', 'Browser expression must execute successfully');
        return response.result.value;
    };
    const until = async expression => {
        for (let attempt = 0; attempt < 80; attempt++) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Expected browser state did not appear');
    };
    const visit = async route => {
        await command('browsingContext.navigate', {context, url: origin + route, wait: 'complete'});
    };
    const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
    const setField=async(selector,value)=>evaluate(`(()=>{
        const field=document.querySelector(${JSON.stringify(selector)});
        const prototype=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,${JSON.stringify(value)});
        field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const navigate=route=>evaluate(`(()=>{history.pushState({},'',${JSON.stringify(route)});window.dispatchEvent(new PopStateEvent('popstate'));})()`);
    await visit('/messages/user/2'); await until('location.pathname==="/login"');
    await evaluate(`document.querySelector('form').requestSubmit()`);
    await until('location.pathname==="/messages/user/2" && !!document.querySelector("textarea")');
    console.log('PASS: notification destination remains protected and resumes after login');
    await navigate('/messages');await until('document.body.textContent.includes("Notifications désactivées")');
    assert.equal(await evaluate('window.__pushCalls.includes("permission")'),false);
    assert.equal(authCalls,0);
    const before=documentRequests;
    const click=label=>evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
    await evaluate('window.__registrationFail=true');
    await click('Activer les notifications');
    await until('document.body.textContent.includes("Impossible d’enregistrer ce navigateur") && document.body.textContent.includes("HTTP 400")');
    assert.equal(await evaluate('document.body.textContent.includes("également échoué") || document.body.textContent.includes("private-provider-detail")'),false);
    assert.equal(authCalls,0);
    await evaluate('window.__registrationFail=false');
    await click('Activer les notifications');await until('document.body.textContent.includes("Notifications activées")');
    assert.equal(authCalls,1);assert.equal(documentRequests,before);
    assert.equal(await evaluate('window.__pushCalls.filter(x=>x==="permission").length'),1);
    assert.equal(await evaluate('localStorage.getItem("test-push-user")==="browser-public-id"'),true);
    console.log('PASS: explicit activation, authenticated TokenProvider, no reload or automatic permission');
    await visit('/messages');await until('document.body.textContent.includes("Notifications activées")');
    assert.equal(await evaluate('window.__pushCalls.includes("permission") || window.__pushCalls.includes("start")'),false);
    await click('Désactiver les notifications');await until('document.body.textContent.includes("Notifications désactivées")');
    assert.equal(await evaluate('localStorage.getItem("test-push-user")===null'),true);
    await evaluate('window.__permission="default";window.__permissionAnswer="denied"');
    await click('Activer les notifications');await until('document.body.textContent.includes("Notifications refusées")');
    assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Activer les notifications")'),false);
    console.log('PASS: reload restores existing association without prompting; disable and refusal handled');
    await evaluate('window.__permission="granted"');await visit('/messages');await until('document.body.textContent.includes("Notifications désactivées")');
    mode='503';await click('Activer les notifications');await until('document.body.textContent.includes("ne sont pas configurées")');
    await navigate('/messages/user/2');await until('!!document.querySelector("textarea")');
    await setField('textarea','private-browser-text');await evaluate('document.querySelector("form").requestSubmit()');
    await until('document.querySelectorAll(".private-messages li").length===1');
    const reads=messageCalls;await pause(650);assert.equal(messageCalls>reads,true);
    console.log('PASS: missing server configuration leaves private send and polling functional');
    mode='valid';await visit('/messages');await until('document.body.textContent.includes("Notifications désactivées")');
    await click('Activer les notifications');await until('document.body.textContent.includes("Notifications activées")');
    await evaluate(`(async()=>{const {store}=await import('/src/app/store.ts');const {resetAuth}=await import('/src/features/auth/authSlice.ts');store.dispatch(resetAuth());})()`);
    await until('location.pathname==="/login" && localStorage.getItem("test-push-user")===null');
    assert.equal(await evaluate('window.__pushCalls.includes("stop")'),true);
    const worker=await fetch(origin+'/service-worker.js');assert.equal(worker.status,200);
    assert.match(worker.headers.get('content-type'),/javascript/);assert.match(await worker.text(),/onNotificationReceived/);
    assert.equal(await evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(freshToken)}) || document.documentElement.outerHTML.includes('test-beams-token')`),false);
    assert.equal(messages.some(message=>[freshToken,'test-beams-token','private-browser-text',password].some(value=>message.includes(value))),false);
    assert.equal(messages.some(message=>/uncaught|unhandled|error occurred in/i.test(message)),false);
    console.log('PASS: logout removes association; static worker served as JS; no token in DOM/logs');
    await command('session.end',{});
    // Build réel hors du dépôt et sans charger .env ; vérifier aussi la copie public/.
    const outDir=join(temporary,'build');
    await build({root:workspace,envFile:false,configLoader:'runner',build:{outDir,emptyOutDir:true}});
    assert.equal(await readFile(join(outDir,'service-worker.js'),'utf8'),await readFile(join(workspace,'public/service-worker.js'),'utf8'));
    console.log('PASS: production Vite build copies service-worker.js at the root');
} finally {
    socket?.close();browser?.kill('SIGTERM');await server?.close();
    await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
