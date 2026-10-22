import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(workspace, 'package.json'));
const {createServer, build} = await import(require.resolve('vite'));
const WebSocket = require('ws');
const captures = join(workspace,'docs/assets/etape-11');
await mkdir(captures,{recursive:true});
const temporary = await mkdtemp(join(tmpdir(), 'urc-router-'));
let server, browser, socket;
let documentRequests = 0;
const measurements=[];
const messages = [];
const pendingRegistration = [];
const registrationRequests = [];
let mode = 'valid';
let meCalls = 0;
let usersMode = 'valid';
let usersCalls = 0;
const pendingUsers = [];
let messageMode = 'valid';
let messageCalls = 0;
const heldReads = [];
const heldSends = [];
const sentBodies = [];
let roomsMode = 'valid';
let roomMode = 'valid';
let roomCalls = 0;
const heldRoomReads = [];
const createdRoomBodies = [];
const roomRows = [{room_id:1,name:'General'},{room_id:2,name:'News'},{room_id:3,name:'Random'}];
const roomHistories = new Map([[1,[{id:'70000000-0000-4000-8000-000000000001',roomId:1,senderId:2,senderName:'Second participant',content:'<svg onload=alert(1)>room-fixture',createdAt:new Date().toISOString()}]],[2,[]],[3,[]]]);
const roomText = 'browser-room-message-fixture';
const privateText = 'browser-private-fixture';
const incomingText = '<img src=x onerror=alert(1)>incoming-fixture';
const history = new Map([[2, [{id: '30000000-0000-4000-8000-000000000001', senderId: 2, recipientId: 1, content: incomingText, createdAt: new Date().toISOString()}]], [3, []]]);

const pendingMe = [];
const freshToken = '00000000-0000-4000-8000-000000000003';
const apiToken = '00000000-0000-4000-8000-000000000002';
const password = 'browser-fixture-password';
const user = 'Camille';
const publicUsers = [{user_id: 1, username: user, last_login: null}, {user_id: 2, username: 'browser-recipient', last_login: '22/10/2026 10:00'}, {user_id: 3, username: 'third-recipient', last_login: null}];
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
    server = await createServer({
        root: workspace, envFile: false, configLoader: 'runner',
        cacheDir: join(temporary, 'vite-cache'),
        define: {'import.meta.env.VITE_PUSHER_INSTANCE_ID': JSON.stringify('test-public-instance')},
        server: {host: '127.0.0.1', port: 0, hmr: false},
        plugins: [{name: 'isolated-login-fixture', enforce:'pre',
            resolveId(source){if(source==='@pusher/push-notifications-web')return '\0design-beams';},
            load(id){if(id==='\0design-beams')return mockSDK;},
            configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
                if (req.headers.accept?.includes('text/html')) documentRequests++;
                if(req.url.startsWith('/api/beams')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({token:'test-beams-token'}));return;}
                if (req.url === '/api/rooms') {
                    assert.equal(req.headers.authorization === 'Bearer ' + freshToken, true);
                    const isPost = req.method === 'POST';
                    let body;
                    if (isPost) {let raw=''; for await (const part of req) raw+=part; body=JSON.parse(raw); createdRoomBodies.push(body);}
                    const status = roomsMode === '500' ? 500 : isPost && (roomsMode === '409' || roomRows.some(room=>room.name===body.name)) ? 409 : isPost ? 201 : 200;
                    let result = {detail:'private-provider-detail'};
                    if (status === 201) {
                        result = {room_id:roomRows.length+1,name:body.name}; roomRows.push(result); roomHistories.set(result.room_id,[]);
                    } else if (status === 200) result = [...roomRows];
                    res.statusCode=status; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(result)); return;
                }
                if (req.url.startsWith('/api/room-messages')) {
                    roomCalls++;
                    assert.equal(req.headers.authorization === 'Bearer ' + freshToken, true);
                    const isPost=req.method==='POST'; let body;
                    if (isPost) {let raw='';for await(const part of req) raw+=part;body=JSON.parse(raw);}
                    const id=isPost?body.roomId:Number(new URL(req.url,'https://urc.invalid').searchParams.get('roomId'));
                    const snapshot=[...(roomHistories.get(id)??[])];
                    const reply=()=>{
                        const status=['400','401','404','500'].includes(roomMode)?Number(roomMode):isPost?201:200;
                        let result={detail:'private-provider-detail'};
                        if(status===201){result={id:crypto.randomUUID(),roomId:id,senderId:1,senderName:user,content:body.content,createdAt:new Date().toISOString()};roomHistories.get(id).push(result);}
                        else if(status===200) result=snapshot;
                        res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(result));
                    };
                    if(roomMode==='holdRead'&&!isPost)heldRoomReads.push(reply);else reply();return;
                }
                if (req.url.startsWith('/api/message')) {
                    messageCalls++;
                    assert.equal(req.headers.authorization === 'Bearer ' + freshToken, true);
                    const isPost = req.method === 'POST';
                    let body;
                    if (isPost) {
                        let raw = ''; for await (const part of req) raw += part;
                        body = JSON.parse(raw); sentBodies.push(body);
                    }
                    const id = isPost ? body.recipientId : Number(new URL(req.url, 'https://urc.invalid').searchParams.get('userId'));
                    const readSnapshot = isPost ? null : [...history.get(id)];
                    const reply = () => {
                        if (messageMode === 'network') { res.destroy(); return; }
                        const status = ['400', '401', '404', '500'].includes(messageMode) ? Number(messageMode) : isPost ? 201 : 200;
                        let result = {detail: 'private-provider-detail'};
                        if (status === 201) {
                            result = {id: crypto.randomUUID(), senderId: 1, recipientId: id, content: body.content, createdAt: new Date().toISOString()};
                            history.get(id).push(result);
                        } else if (status === 200) result = readSnapshot;
                        res.statusCode = status;
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Cache-Control', 'no-store');
                        res.end(JSON.stringify(result));
                    };
                    if (messageMode === 'holdRead' && !isPost) heldReads.push(reply);
                    else if (messageMode === 'holdSend' && isPost) heldSends.push(reply);
                    else reply();
                    return;
                }
                if (req.url === '/api/users') {
                    usersCalls++;
                    assert.equal(req.headers.authorization === 'Bearer ' + freshToken, true);
                    const reply = () => {
                        if (usersMode === 'network') {res.destroy(); return;}
                        res.statusCode = usersMode === '401' ? 401 : usersMode === '500' ? 500 : 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Cache-Control', 'no-store');
                        res.end(JSON.stringify(res.statusCode !== 200 ? {detail: 'private-provider-detail'}
                            : usersMode === 'empty' ? [] : publicUsers));
                    };
                    if (usersMode === 'pending') pendingUsers.push(reply);
                    else reply();
                    return;
                }
                if (req.url === '/api/register') {
                    let body = '';
                    for await (const part of req) body += part;
                    registrationRequests.push(JSON.parse(body));
                    pendingRegistration.push(status => {
                        res.statusCode = status;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(status === 201 ? {id: 42, username: user}
                            : {code: status === 409 ? 'CONFLICT' : 'REGISTER_FAILED', message: 'private-database-detail'}));
                    });
                    return;
                }
                if (req.url === '/api/me') {
                    meCalls++;
                    const reply = (status = 200) => {
                        res.statusCode = status;
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Cache-Control', 'no-store');
                        res.end(JSON.stringify(status === 200
                            ? {id: 1, username: user, externalId: 'browser-fixture-id'}
                            : {code: status === 401 ? 'UNAUTHORIZED' : 'SESSION_UNAVAILABLE'}));
                    };
                    if (mode === 'pending') { pendingMe.push(reply); return; }
                    if (mode === 'network') { res.destroy(); return; }
                    const known = ['Bearer ' + apiToken, 'Bearer ' + freshToken].includes(req.headers.authorization);
                    reply(!known || mode === 'expired' ? 401 : mode === 'server-error' ? 500 : 200);
                    return;
                }
                if (req.url !== '/api/login') return next();
                let body = '';
                for await (const part of req) body += part;
                const credentials = JSON.parse(body);
                const valid = credentials.username === user && credentials.password === password;
                res.statusCode = valid ? 200 : 401;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(valid ? {id: 1, username: user, externalId: 'browser-fixture-id', token: freshToken}
                    : {code: 'UNAUTHORIZED', message: 'Identifiant ou mot de passe incorrect'}));
            });
        }}],
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const route of ['/', '/login', '/messages', '/messages/user/2', '/rooms', '/rooms/1', '/unknown/path']) {
        const response = await fetch(origin + route, {headers: {Accept: 'text/html'}});
        assert.equal(response.status, 200);
        assert.match(await response.text(), /src\/index.jsx/);
    }
    console.log('PASS: direct HTTP access to local routes, including /messages/user/2');
    const profile = join(temporary, 'firefox-profile');
    
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
        window.__pushCalls=[];window.__permission=localStorage.getItem('test-push-user')?'granted':'default';
        Object.defineProperty(window,'Notification',{configurable:true,value:class {
            static get permission(){return window.__permission;}
            static async requestPermission(){window.__pushCalls.push('permission');window.__permission='granted';return 'granted';}
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
    const viewport=async(width,height)=>command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1});
    const capture=async(name)=>{
        await pause(180);
        assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'No horizontal overflow: '+name);
        const geometry=JSON.parse(await evaluate('JSON.stringify({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,headerTop:document.querySelector(".page-header")?.getBoundingClientRect().top,titleTop:document.querySelector(".page-header h1")?.getBoundingClientRect().top,mainScroll:document.querySelector(".chat-content")?.scrollTop})'));
        measurements.push({name,...geometry});
        const result=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        await writeFile(join(captures,name+'.png'),Buffer.from(result.data,'base64'));
        console.log('CAPTURE: '+name);
    };
    await viewport(1440,900);
    await visit('/login');await until('!!document.querySelector("[name=login]")');await capture('desktop-login');
    await evaluate('document.querySelector("[name=login]").focus()');
    await command('input.performActions',{context,actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:'\uE004'},{type:'keyUp',value:'\uE004'}]}]});
    assert.equal(await evaluate('document.activeElement.name'), 'password');
    await visit('/register');await until('!!document.querySelector("#register-email")');await capture('desktop-register');
    await evaluate('document.querySelector("form").requestSubmit()');await until('!!document.querySelector("#register-email-error")');await capture('desktop-register-errors');
    await visit('/page-inconnue');await until('document.body.textContent.includes("404")');await capture('desktop-404');
    await visit('/rooms/1');await until('location.pathname==="/login"');
    await evaluate(`(()=>{document.querySelector('[name=login]').value=${JSON.stringify(user)};document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();})()`);
    await until('location.pathname==="/messages" && !!document.querySelector(`a[href="/rooms"]`)');
    const before=documentRequests;
    await evaluate('document.querySelector(`a[href="/rooms"]`).click()');
    await until('location.pathname==="/rooms" && !!document.querySelector(`a[href="/rooms/1"]`)');
    assert.equal(documentRequests,before);
    assert.equal(await evaluate('document.body.textContent.includes("Accessibles à tous")'),true);
    console.log('PASS: anonymous room protected; private home links to real room list without reload');
    await evaluate('document.querySelector("form").requestSubmit()');
    await until('!!document.querySelector("#room-name-error")');
    assert.equal(createdRoomBodies.length,0);
    roomsMode='409';await setField('[name=name]','New study room');
    await evaluate('document.querySelector("form").requestSubmit()');
    await until('document.body.textContent.includes("déjà utilisé")');
    assert.equal(await evaluate('document.querySelector("[name=name]").value==="New study room"'),true);
    roomsMode='valid';await evaluate('document.querySelector("form").requestSubmit()');
    await until('location.pathname==="/rooms/4" && document.body.textContent.includes("Aucun message dans ce salon")');
    assert.deepEqual(Object.keys(createdRoomBodies.at(-1)),['name']);
    assert.equal(documentRequests,before);
    console.log('PASS: React form validates names, preserves name on conflict, creates via POST then navigates to new room');
    await setField('textarea',roomText);roomMode='500';
    await evaluate('document.querySelector("form").requestSubmit()');
    await until('!!document.querySelector("[role=alert]") && !document.querySelector("textarea").disabled');
    assert.equal(await evaluate(`document.querySelector('textarea').value===${JSON.stringify(roomText)}`),true);
    assert.equal(await evaluate(`sessionStorage.getItem('token')===${JSON.stringify(freshToken)}`),true);
    roomMode='valid';await evaluate('document.querySelector("form").requestSubmit()');
    await until('!!document.querySelector(".message-sent") && document.querySelector("textarea").value===""');
    assert.equal(await evaluate(`document.querySelector('.message-sent strong').textContent.includes(${JSON.stringify(user)})`),true);
    console.log('PASS: group send confirms author and body; HTTP 500 preserves draft/session; retry succeeds');
    roomHistories.get(4).push({id:crypto.randomUUID(),roomId:4,senderId:2,senderName:'Second participant',content:'second-room-participant',createdAt:new Date().toISOString()});
    roomHistories.get(4).push({id:crypto.randomUUID(),roomId:4,senderId:3,senderName:'Third participant',content:'third-room-participant',createdAt:new Date().toISOString()});
    await until('document.querySelectorAll(".private-messages li").length===3');await pause(600);
    assert.equal(await evaluate('document.querySelectorAll(".private-messages li").length'),3);
    assert.equal(await evaluate('document.body.textContent.includes("Second participant") && document.body.textContent.includes("Third participant")'),true);
    console.log('PASS: polling displays three authors in the same room without duplicates in real StrictMode (8000ms accelerated to 250ms)');
    await evaluate('window.__pollVisible=false;document.dispatchEvent(new Event("visibilitychange"))');
    const hidden=roomCalls;await pause(650);assert.equal(roomCalls,hidden);
    await evaluate('window.__pollVisible=true;document.dispatchEvent(new Event("visibilitychange"))');await pause(100);assert.equal(roomCalls>hidden,true);
    await evaluate('window.__pollOnline=false;window.dispatchEvent(new Event("offline"))');
    const offline=roomCalls;await pause(650);assert.equal(roomCalls,offline);
    await evaluate('window.__pollOnline=true;window.dispatchEvent(new Event("online"))');await pause(100);assert.equal(roomCalls>offline,true);
    roomMode='holdRead';for(let i=0;i<60&&heldRoomReads.length===0;i++)await pause(25);
    await pause(600);assert.equal(heldRoomReads.length,1);
    assert.equal(await evaluate('!document.body.textContent.includes("Chargement des messages")'),true);
    await navigate('/rooms/2');await until('document.body.textContent.includes("Salon : News")');
    for(let i=0;i<60&&heldRoomReads.length<2;i++)await pause(25);
    roomMode='valid';for(const reply of heldRoomReads.splice(0).reverse())reply();
    await until('document.body.textContent.includes("Aucun message dans ce salon")');
    assert.equal(await evaluate(`!document.querySelector('.private-messages').textContent.includes(${JSON.stringify(roomText)})`),true);
    console.log('PASS: shared visibility/offline polling, slow request and rapid room changes remain isolated');
    const previousMe=meCalls;await visit('/rooms/4');
    await until('document.querySelectorAll(".private-messages li").length===3');assert.equal(meCalls>previousMe,true);
    console.log('PASS: direct room reload restores session, room metadata and history');
    await navigate('/rooms/1');await until('document.querySelectorAll(".private-messages li").length===1');
    assert.equal(await evaluate('document.querySelector(".private-messages svg")===null && document.querySelector(".private-messages p").textContent.includes("<svg")'),true);
    await navigate('/messages');await until('!!document.querySelector(`a[href="/messages/user/2"]`)');
    const stopped=roomCalls;
    await evaluate('document.querySelector(`a[href="/messages/user/2"]`).click()');
    await until('document.body.textContent.includes("Conversation avec browser-recipient") && document.querySelectorAll(".private-messages li").length===1');
    await pause(650);assert.equal(roomCalls,stopped);
    assert.equal(await evaluate('document.querySelector(".private-messages p").textContent.includes("incoming-fixture") && !document.querySelector(".private-messages p").textContent.includes("room-fixture")'),true);
    console.log('PASS: room HTML is escaped; switching to private chat stops room polling and retains private history only');
    roomsMode='500';await visit('/rooms');await until('!!document.querySelector("[role=alert] button")');
    roomsMode='valid';await evaluate('document.querySelector("[role=alert] button").click()');
    await until('!!document.querySelector(`a[href="/rooms/4"]`)');
    console.log('PASS: room list failure has a working retry');
    await navigate('/rooms/999');await until('document.body.textContent.includes("Salon introuvable")');
    await navigate('/rooms/not-an-id');await until('document.body.textContent.includes("Identifiant de salon invalide")');
    await navigate('/rooms/4');await until('document.querySelectorAll(".private-messages li").length===3');
    roomMode='401';await until('location.pathname==="/login" && !!document.querySelector("form")');
    assert.equal(await evaluate('sessionStorage.getItem("token")===null'),true);
    const after401=roomCalls;await pause(650);assert.equal(roomCalls,after401);
    assert.equal(await evaluate(`!document.documentElement.outerHTML.includes(${JSON.stringify(freshToken)}) && !document.body.textContent.includes(${JSON.stringify(roomText)})`),true);
    assert.equal(messages.some(message=>[password,freshToken,roomText,'private-provider-detail','second-room-participant','third-room-participant'].some(secret=>message.includes(secret))),false);
    assert.equal(messages.some(message=>/uncaught|unhandled|error occurred in/i.test(message)),false);
    console.log('PASS: invalid/unknown room handling; current 401 cleans state and stops polling; no sensitive DOM/log leakage');
    // Fixtures de présentation uniquement : jamais injectées dans l'application réelle.
    roomMode='valid';roomsMode='valid';mode='valid';usersMode='valid';
    publicUsers[1].username='Nora Martin';publicUsers[2].username='Yanis Le Gall';
    for(let id=4;id<=45;id++)publicUsers.push({user_id:id,username:id===4?'Un nom utilisateur particulièrement long pour vérifier le retour à la ligne':'Participant '+id,last_login:null});
    const exchanges=[
        [2,'Bonjour ! Tu as pu regarder les consignes du projet ?'],
        [1,'Oui, je viens de terminer la partie sur les salons.'],
        [2,'Parfait. On peut faire un point sur les tests avant de rendre le TP.'],
        [1,'Bonne idée, il reste surtout à vérifier les petits écrans.'],
        [2,'J’ai préparé quelques exemples de messages pour vérifier leur lisibilité.'],
        [1,'Merci ! Je regarde ça cet après-midi.'],
    ];
    history.set(2,exchanges.map(([senderId,content],index)=>({id:'30000000-0000-4000-8000-'+String(index+20).padStart(12,'0'),senderId,recipientId:senderId===1?2:1,content,createdAt:new Date(Date.now()-(6-index)*60000).toISOString()})));
    roomHistories.set(1,[{id:'70000000-0000-4000-8000-000000000020',roomId:1,senderId:2,senderName:'Nora Martin',content:'Bonjour à tous ! On partage ici les questions sur le projet.',createdAt:new Date().toISOString()},
        {id:'70000000-0000-4000-8000-000000000021',roomId:1,senderId:1,senderName:user,content:'Merci, je viens de terminer la vérification de la navigation.',createdAt:new Date().toISOString()},
        {id:'70000000-0000-4000-8000-000000000022',roomId:1,senderId:3,senderName:'Yanis Le Gall',content:'Je pourrai relire les derniers changements demain matin.',createdAt:new Date().toISOString()}]);
    await visit('/login');await until('!!document.querySelector("[name=login]")');
    await evaluate(`(()=>{document.querySelector('[name=login]').value=${JSON.stringify(user)};document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();})()`);
    await until('location.pathname==="/messages" && document.querySelectorAll(".directory-list li").length>30');
    await capture('desktop-users');
    await evaluate('document.querySelector("input[type=search]").focus()');
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle!=="none"'),true);
    await setField('input[type=search]','Nora');await until('document.querySelectorAll(".directory-list li").length===1');
    await setField('input[type=search]','');
    await navigate('/messages/user/2');await until('document.querySelectorAll(".private-messages li").length===6');await capture('desktop-private');
    const dimensions=await evaluate('JSON.stringify({height:document.querySelector(".private-messages").clientHeight,composerBottom:document.querySelector(".message-composer").getBoundingClientRect().bottom,viewport:innerHeight})');
    assert.equal(JSON.parse(dimensions).composerBottom<=JSON.parse(dimensions).viewport,true);
    await setField('textarea','Brouillon conservé en cas d’erreur');messageMode='500';await evaluate('document.querySelector("form").requestSubmit()');
    await until('document.querySelector(".private-conversation > [role=alert]")!==null');await capture('desktop-send-error');
    assert.equal(await evaluate('document.querySelector("textarea").value'), 'Brouillon conservé en cas d’erreur');messageMode='valid';
    await navigate('/rooms');await until('!!document.querySelector("#room-name")');
    assert.equal(await evaluate('document.querySelector(".page-header").getBoundingClientRect().top>=0'),true);
    await capture('desktop-rooms');
    await navigate('/rooms/1');await until('document.querySelectorAll(".private-messages li").length===3');await capture('desktop-group');
    // Notifications toujours simulées, y compris le clic d'activation.
    await navigate('/messages');await until('!!document.querySelector("details")');await evaluate('document.querySelector("details").open=true');await capture('desktop-notifications');
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Activer les notifications").click()');
    await until('document.body.textContent.includes("Notifications activées")');await capture('desktop-notifications-active');
    // Vérification des chargements et des erreurs réels de composants avec API simulées.
    usersMode='pending';await visit('/messages');await until('document.querySelector(".directory [role=status]")!==null');await capture('desktop-loading');
    usersMode='valid';for(const reply of pendingUsers.splice(0))reply();
    usersMode='500';await visit('/messages');await until('document.querySelector(".directory [role=alert]")!==null');await capture('desktop-users-error');usersMode='valid';
    await viewport(390,844);
    await evaluate('sessionStorage.removeItem("token")');
    await visit('/login');await until('!!document.querySelector("[name=login]")');await capture('mobile-login');
    await visit('/register');await until('!!document.querySelector("#register-email")');await capture('mobile-register');
    await evaluate('document.querySelector("form").requestSubmit()');await until('!!document.querySelector("#register-email-error")');await capture('mobile-register-errors');
    await visit('/login');await until('!!document.querySelector("[name=login]")');
    await evaluate(`(()=>{document.querySelector('[name=login]').value=${JSON.stringify(user)};document.querySelector('[name=password]').value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();})()`);
    await until('location.pathname==="/messages" && document.querySelectorAll(".directory-list li").length>30');await capture('mobile-users');
    await evaluate('document.querySelector("details").open=true');await capture('mobile-notifications');await evaluate('document.querySelector("details").open=false');
    await navigate('/messages/user/2');await until('document.querySelectorAll(".private-messages li").length===6');await capture('mobile-private');
    await viewport(390,500);await evaluate('document.querySelector("textarea").focus()');await pause(150);
    assert.equal(await evaluate('document.querySelector(".message-composer").getBoundingClientRect().bottom<=innerHeight'),true);
    await capture('mobile-compact-height');await viewport(390,844);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".sidebar")).display'), 'none');
    assert.equal(await evaluate('document.querySelector(".message-composer").getBoundingClientRect().bottom<=innerHeight'),true);
    await evaluate('document.querySelector(".conversation-back").click()');await until('location.pathname==="/messages"');
    await navigate('/rooms');await until('!!document.querySelector("#room-name")');await capture('mobile-rooms');
    await evaluate('document.querySelector(".directory-action").click()');
    await evaluate('document.querySelector("#room-name").scrollIntoView({block:"center"})');await capture('mobile-room-create');
    await navigate('/rooms/1');await until('document.querySelectorAll(".private-messages li").length===3');await capture('mobile-group');
    history.get(2).push({id:crypto.randomUUID(),senderId:2,recipientId:1,content:'Un très long message : '+('https://exemple.invalid/'+ 'abcdefghij'.repeat(30))+'\nUne nouvelle ligne est conservée.',createdAt:new Date().toISOString()});
    await navigate('/messages/user/2');await until('document.querySelectorAll(".private-messages li").length===7');await capture('mobile-long-message');
    await evaluate('document.querySelector(".private-messages").scrollTop=0');await pause(100);
    history.get(2).push({id:crypto.randomUUID(),senderId:2,recipientId:1,content:'Un nouveau message pendant la lecture.',createdAt:new Date().toISOString()});
    await until('document.querySelectorAll(".private-messages li").length===8');
    assert.equal(await evaluate('document.querySelector(".private-messages").scrollTop'),0);
    await evaluate('const list=document.querySelector(".private-messages");list.scrollTop=list.scrollHeight');await pause(100);
    history.get(2).push({id:crypto.randomUUID(),senderId:2,recipientId:1,content:'Dernier message de vérification du scroll.',createdAt:new Date().toISOString()});
    await until('document.querySelectorAll(".private-messages li").length===9');
    assert.equal(await evaluate('(()=>{const l=document.querySelector(".private-messages");return l.scrollHeight-l.clientHeight-l.scrollTop<4;})()'),true);
    await navigate('/messages/user/invalide');await until('document.body.textContent.includes("Identifiant utilisateur invalide")');
    await evaluate('document.querySelector(".conversation-back").click()');await until('location.pathname==="/messages"');
    await navigate('/rooms/999');await until('document.body.textContent.includes("Salon introuvable")');
    await evaluate('document.querySelector(".conversation-back").click()');await until('location.pathname==="/rooms"');
    await visit('/page-inconnue');await until('document.body.textContent.includes("404")');await capture('mobile-404');
    assert.equal(messages.some(message=>[password,freshToken,'test-beams-token','private-provider-detail'].some(secret=>message.includes(secret))),false);
    await writeFile(join(captures,'mesures.json'),JSON.stringify(measurements,null,2)+'\n');
    console.log('PASS: desktop/mobile routes, local search, keyboard focus, bounded composer, draft preservation and screenshots');
    await command('session.end', {});
    await build({root: workspace, envFile: false, configLoader: 'runner', build: {write: false}});
    console.log('PASS: production build in memory');
} finally {
    socket?.close();
    browser?.kill('SIGTERM');
    await server?.close();
    await rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
