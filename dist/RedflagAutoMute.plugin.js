/**
 * @name RedflagAutoMute
 * @author RedflagAutoMute contributors
 * @version 2.0.4
 * @description Муть токсичных людей вместе с друзьями.
 */
"use strict";
module.exports = (() => {
const modules = {"./core.cjs": (module, exports, require) => {
"use strict";

const snowflake = value => typeof value === "string" && /^[0-9]{17,20}$/.test(value);

function summarize(group, threshold = 2) {
    const result = {};
    for (const [id, votes] of Object.entries(group?.cards || {})) {
        if (!snowflake(id)) continue;
        let red = 0, yellow = 0;
        for (const [author, vote] of Object.entries(votes || {})) {
            if (!group.members?.[author]) continue;
            if (vote?.type === "red") red++;
            if (vote?.type === "yellow") yellow++;
        }
        if (red || yellow) result[id] = { red, yellow, type: red || yellow >= threshold ? "red" : "yellow" };
    }
    return result;
}

function desiredMutes(groups, options = {}, selfId) {
    const desired = new Set();
    const threshold = Math.max(2, Number(options.yellowThreshold) || 2);
    for (const group of groups) {
        for (const [id, card] of Object.entries(summarize(group, threshold))) {
            if (card.type === "red" || options.includeYellow) desired.add(id);
        }
    }
    for (const [id, choice] of Object.entries(options.overrides || {})) {
        if (!snowflake(id)) continue;
        if (choice === "allow") desired.delete(id);
        if (choice === "mute") desired.add(id);
    }
    desired.delete(selfId);
    return desired;
}

// Never take ownership of an existing manual mute. Persist ownership across reloads.
class MuteController {
    constructor(adapter, owned = [], save = () => {}) {
        this.adapter = adapter;
        this.owned = new Set(owned.filter(snowflake));
        this.save = save;
    }
    reconcile(desired) {
        for (const id of [...this.owned]) {
            if (desired.has(id)) continue;
            if (this.adapter.isMuted(id)) this.adapter.toggle(id);
            this.owned.delete(id);
            this.save([...this.owned]);
        }
        for (const id of desired) {
            if (!this.adapter.isMuted(id)) {
                this.adapter.toggle(id);
                this.owned.add(id);
                this.save([...this.owned]);
            }
        }
    }
}

module.exports = { snowflake, summarize, desiredMutes, MuteController };

},
"./transfer.cjs": (module, exports, require) => {
"use strict";
const {snowflake,summarize}=require("./core.cjs");
const MAX_TARGETS=5000, MAX_OWNED_GROUPS=5;
const slotKey=i=>`s${String(i).padStart(4,"0")}`;
function allocateTargets(group, ids) {
    const slots={...group.slots}, targets={...group.targetSlots}, changes={};
    let index=0;
    for(const id of [...new Set([...Object.keys(group.cards||{}),...ids])]) {
        if(!snowflake(id))continue;
        if(targets[id] && slots[targets[id]]===id)continue;
        while(index<MAX_TARGETS && slots[slotKey(index)])index++;
        if(index===MAX_TARGETS)throw Error("В группе уже 5000 записей. Освободите место перед добавлением новых пользователей.");
        const slot=slotKey(index);slots[slot]=id;targets[id]=slot;changes[`slots/${slot}`]=id;changes[`targetSlots/${id}`]=slot;
    }
    return {changes,slots,targets};
}
function parseImport(text) {
    if(typeof text!=="string"||text.length>2*1024*1024)throw Error("Файл должен быть текстовым и не больше 2 МБ.");
    let values;
    if(/^[\s]*[\[{]/.test(text)) {
        let data;try{data=JSON.parse(text);}catch{throw Error("Некорректный JSON.");}
        values=Array.isArray(data)?data:data?.userIds;
        if(!Array.isArray(values))throw Error("Ожидается массив Discord ID или экспорт RedflagAutoMute с полем userIds.");
    } else values=text.split(/[\s,;]+/).filter(Boolean);
    if(values.some(id=>!snowflake(id)))throw Error("Каждый Discord ID должен быть строкой из 17–20 цифр. Имена и числовые JSON-значения не принимаются.");
    const ids=[...new Set(values)];
    if(!ids.length)throw Error("Список пуст.");
    if(ids.length>MAX_TARGETS)throw Error("За один импорт допускается не больше 5000 уникальных пользователей.");
    return ids;
}
function exportList(ids,source) {
    return JSON.stringify({format:"RedflagAutoMute",version:1,source,exportedAt:new Date().toISOString(),userIds:[...new Set(ids.filter(snowflake))].sort()},null,2);
}
function discordMutes(store,selfId) {
    const settings=store?.getState?.()?.settingsByContext;
    if(!settings||typeof settings!=="object")throw Error("Discord изменил формат сохранённых мьютов. Экспорт недоступен; пустой список не создан.");
    const context=Object.values(settings).find(value=>value?.localMutes && typeof value.localMutes==="object");
    if(!context)throw Error("Не удалось прочитать сохранённые мьюты Discord.");
    // Enumerate persisted settings, then verify against the default voice context.
    const ids=[...new Set(Object.values(settings).flatMap(value=>Object.keys(value?.localMutes||{})))];
    return ids.filter(id=>snowflake(id)&&id!==selfId&&store.isLocalMute(id));
}
function bannedIds(group) {return Object.entries(summarize(group)).filter(([,v])=>v.type==="red").map(([id])=>id);}
function discordExport(store,selfId,relationships,options={}) {
    const muted=discordMutes(store,selfId);
    const valid=id=>snowflake(id)&&id!==selfId;
    let zero=[],blocked=[];
    if(options.includeZeroVolume) {
        if(typeof store.getLocalVolume!=="function")throw Error("Discord не позволяет прочитать индивидуальную громкость.");
        const settings=store.getState().settingsByContext;
        zero=[...new Set(Object.values(settings).flatMap(value=>Object.keys(value?.localVolumes||{})))].filter(id=>valid(id)&&store.getLocalVolume(id)===0);
    }
    if(options.includeBlocked) {
        if(typeof relationships?.getBlockedIDs!=="function")throw Error("Discord не позволяет прочитать список блокировок.");
        const values=relationships.getBlockedIDs();
        if(!Array.isArray(values))throw Error("Discord изменил формат списка блокировок.");
        blocked=[...new Set(values.filter(valid))];
    }
    return {ids:[...new Set([...muted,...zero,...blocked])],counts:{muted:muted.length,zero:zero.length,blocked:blocked.length}};
}
function makeInvite(config,id,secret) {
    // BetterDiscord's Buffer polyfill does not implement the base64url encoding.
    return encodeInvite("rfam1",{apiKey:config.apiKey,databaseURL:config.databaseURL,code:`${id}.${secret}`});
}
function encodeInvite(prefix,data) {return prefix+"."+Buffer.from(JSON.stringify(data)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function makeDatabaseInvite(config) {return encodeInvite("rfdb1",{apiKey:config.apiKey,databaseURL:config.databaseURL});}
module.exports={MAX_TARGETS,MAX_OWNED_GROUPS,allocateTargets,parseImport,exportList,discordMutes,discordExport,bannedIds,makeInvite,makeDatabaseInvite};

},
"./firebase.cjs": (module, exports, require) => {
"use strict";

const { snowflake } = require("./core.cjs");
const {allocateTargets,MAX_OWNED_GROUPS}=require("./transfer.cjs");
const randomId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
const validKey = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function validateConfig(config) {
    const url = new URL(config.databaseURL);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app)$/.test(url.hostname)
        || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Нужен корневой HTTPS URL Realtime Database (*.firebaseio.com или *.firebasedatabase.app)");
    }
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(config.apiKey || "")) throw new Error("Укажите Web API key Firebase");
    return { apiKey: config.apiKey, databaseURL: url.origin };
}

class FirebaseClient {
    constructor(config, transport, session, saveSession = () => {}) {
        this.config = validateConfig(config);
        this.transport = transport;
        this.session = session || null;
        this.saveSession = saveSession;
    }
    async json(url, options = {}) {
        const response = await this.transport(url, options);
        const data = await response.json();
        if (response.status < 200 || response.status >= 300) {
            const error = new Error(typeof data?.error === "string" ? data.error : data?.error?.message || `HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }
    async signIn(email, password, register = false) {
        const data = await this.json(`https://identitytoolkit.googleapis.com/v1/accounts:${register ? "signUp" : "signInWithPassword"}?key=${this.config.apiKey}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true })
        });
        this.session = { uid: data.localId, idToken: data.idToken, refreshToken: data.refreshToken, expiresAt: Date.now() + Number(data.expiresIn) * 1000 };
        this.saveSession(this.session);
    }
    async token() {
        if (!this.session) throw new Error("Сначала войдите в Firebase");
        if (this.session.expiresAt > Date.now() + 60000) return this.session.idToken;
        if (!this.refreshing) {
            this.refreshing = (async () => {
                const data = await this.json(`https://securetoken.googleapis.com/v1/token?key=${this.config.apiKey}`, {
                    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.session.refreshToken }).toString()
                });
                this.session = { uid: data.user_id, idToken: data.id_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
                this.saveSession(this.session);
                return this.session.idToken;
            })().catch(error => {
                if (error.status === 400) error.status = 401;
                throw error;
            }).finally(() => { this.refreshing = null; });
        }
        return this.refreshing;
    }
    async request(path, method = "GET", body) {
        const token = await this.token();
        return this.json(`${this.config.databaseURL}/${path}.json?auth=${encodeURIComponent(token)}`, {
            method, headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
    }
    async createGroup(name) {
        name = name.trim();
        if (!name || name.length > 80) throw new Error("Название группы: от 1 до 80 символов");
        await this.token();
        await this.listGroups();
        const id = randomId();
        for(let attempt=0;attempt<3;attempt++) {
        const slots=await this.request(`ownerSlots/${this.session.uid}`)||{};
        let n=0;while(n<MAX_OWNED_GROUPS && slots[`g${n}`])n++;
        if(n===MAX_OWNED_GROUPS)throw Error("Можно владеть не более чем 5 группами. Удалите ненужную группу.");
        const ownerSlot=`g${n}`;
        const group = {
            name, owner: this.session.uid, ownerSlot, inviteSecret: randomId(), createdAt: { ".sv": "timestamp" },
            members: { [this.session.uid]: "owner" }
        };
        try { await this.request("", "PATCH", { [`groups/${id}`]: group, [`userGroups/${this.session.uid}/${id}`]: true, [`ownerSlots/${this.session.uid}/${ownerSlot}`]:id }); }
        catch(error){if(attempt<2&&[401,403].includes(error.status))continue;throw error;}
        return id;
        }
    }
    async migrateOwnedGroup(id,group) {
        if(group.owner!==this.session.uid || group.ownerSlot)return;
        const slots=await this.request(`ownerSlots/${this.session.uid}`)||{};
        let n=0;while(n<MAX_OWNED_GROUPS&&slots[`g${n}`]&&slots[`g${n}`]!==id)n++;
        if(n===MAX_OWNED_GROUPS)throw Error("Не удалось перенести старые группы: лимит 5 групп владельца.");
        await this.request("","PATCH",{[`groups/${id}/ownerSlot`]:`g${n}`,[`ownerSlots/${this.session.uid}/g${n}`]:id});
    }
    async joinGroup(invite) {
        const [id, secret, extra] = invite.trim().split(".");
        if (!/^[a-f0-9]{48}$/.test(id) || !/^[a-f0-9]{48}$/.test(secret) || extra !== undefined) throw new Error("Неверный код приглашения");
        await this.token();
        try {
            if (await this.readGroup(id)) { await this.indexGroup(id); return id; }
        } catch (error) {
            if (![401, 403].includes(error.status)) throw error;
        }
        await this.request("", "PATCH", { [`groups/${id}/members/${this.session.uid}`]: secret, [`userGroups/${this.session.uid}/${id}`]: true });
        return id;
    }
    indexGroup(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`userGroups/${this.session.uid}/${id}`, "PUT", true);
    }
    async listGroups(knownIds = []) {
        await this.token();
        const index = await this.request(`userGroups/${this.session.uid}`) || {};
        // Migrate groups saved by older versions without exposing a global directory.
        for (const id of knownIds.filter(validKey)) {
            if (index[id]) continue;
            try {
                const group = await this.readGroup(id);
                if (!group?.members?.[this.session.uid]) continue;
                await this.indexGroup(id); index[id] = true;
            } catch (error) { if (![401,403].includes(error.status)) throw error; }
        }
        for(const id of Object.keys(index).filter(validKey)) {
            try { const group=await this.readGroup(id);if(group)await this.migrateOwnedGroup(id,group); }
            catch(error){if(![401,403].includes(error.status))throw error;}
        }
        return Object.keys(index).filter(validKey);
    }
    forgetGroup(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`userGroups/${this.session.uid}/${id}`, "DELETE");
    }
    async deleteGroup(id) {
        const group = await this.readGroup(id);
        if (!group) return this.forgetGroup(id);
        if (group.owner !== this.session.uid) throw new Error("Удалить группу может только владелец");
        const changes = { [`groups/${id}`]: null };
        if(group.ownerSlot)changes[`ownerSlots/${this.session.uid}/${group.ownerSlot}`]=null;
        for (const uid of Object.keys(group.members || {}).filter(validKey)) changes[`userGroups/${uid}/${id}`] = null;
        return this.request("", "PATCH", changes);
    }
    readGroup(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`groups/${id}`);
    }
    async card(groupId, userId, type) {
        if (!validKey(groupId) || !snowflake(userId) || !["red", "yellow", null].includes(type)) throw new Error("Неверная карточка");
        return this.writeCards(groupId,[userId],type);
    }
    async writeCards(groupId,ids,type="red") {
        if(!validKey(groupId)||!Array.isArray(ids)||ids.some(id=>!snowflake(id))||!["red","yellow",null].includes(type))throw Error("Некорректный список карточек");
        ids=[...new Set(ids)];
        for(let attempt=0;attempt<3;attempt++) {
            const group=await this.readGroup(groupId);
            if(!group?.members?.[this.session.uid])throw Error("Вы не участник группы");
            const allocated=allocateTargets(group,type?ids:[]),changes=allocated.changes;
            for(const id of ids) {
                // Import red cards without changing existing red-card timestamps.
                if(type && group.cards?.[id]?.[this.session.uid]?.type===type)continue;
                changes[`cards/${id}/${this.session.uid}`]=type?{type,updatedAt:{".sv":"timestamp"}}:null;
                if(!type && !Object.keys(group.cards?.[id]||{}).some(uid=>uid!==this.session.uid)) {
                    const slot=allocated.targets[id];
                    if(slot){changes[`slots/${slot}`]=null;changes[`targetSlots/${id}`]=null;}
                }
            }
            if(!Object.keys(changes).length)return;
            try{return await this.request(`groups/${groupId}`,"PATCH",changes);}
            catch(error){if(attempt<2&&[401,403].includes(error.status))continue;throw error;}
        }
    }
    rotateInvite(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`groups/${id}/inviteSecret`, "PUT", randomId());
    }
    removeMember(id, uid, rotate = false) {
        if (!validKey(id) || !validKey(uid)) throw new Error("Неверный ID");
        const changes = { [`groups/${id}/members/${uid}`]: null, [`userGroups/${uid}/${id}`]: null };
        if (rotate) changes[`groups/${id}/inviteSecret`] = randomId();
        return this.request("", "PATCH", changes);
    }
}

module.exports = { FirebaseClient, validateConfig };

},
"./transport.cjs": (module, exports, require) => {
"use strict";

// BetterDiscord exposes a native fetch bridge; its HTTPS polyfill has no request().
// Node HTTPS remains available for the standalone cloud test runner.
function transport(url, options = {}) {
    if (globalThis.BdApi?.Net?.fetch) return nativeTransport(url, options);
    return new Promise((resolve, reject) => {
        const req = require("https").request(url, { method: options.method || "GET", headers: options.headers }, res => {
            let size = 0;
            const chunks = [];
            res.on("data", chunk => {
                size += chunk.length;
                if (size > 8 * 1024 * 1024) req.destroy(new Error("Ответ Firebase превышает 8 МБ"));
                else chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({ status: res.statusCode, json: async () => JSON.parse(text) });
            });
        });
        const deadline = setTimeout(() => req.destroy(new Error("Firebase: время ожидания истекло")), 15000);
        req.on("close", () => clearTimeout(deadline));
        req.on("error", reject);
        if (options.body !== undefined) req.write(options.body);
        req.end();
    });
}

async function nativeTransport(url, options) {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new Error("Firebase: время ожидания истекло")), 15000);
    try {
        const response = await BdApi.Net.fetch(url, { ...options, redirect: "error", maxRedirects: 0, timeout: 15000, signal: abort.signal });
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) {
                abort.abort();
                await reader.cancel();
                throw new Error("Ответ Firebase превышает 8 МБ");
            }
            chunks.push(Buffer.from(value));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        return { status: response.status, json: async () => JSON.parse(body) };
    } finally { clearTimeout(deadline); }
}

module.exports = { transport };

},
"./realtime.cjs": (module, exports, require) => {
"use strict";
const {validateConfig}=require("./firebase.cjs");

// Firebase paths are untrusted input; never traverse JavaScript prototypes.
function parts(path) {
    if(typeof path!=="string" || !path.startsWith("/"))throw Error("Invalid event path");
    const keys=path.split("/").filter(Boolean);
    if(keys.some(k=>["__proto__","constructor","prototype"].includes(k)))throw Error("Unsafe event path");
    return keys;
}
function replace(root,keys,value) {
    if(!keys.length)return value;
    root=root && typeof root==="object" ? root : {};
    let node=root;
    for(const key of keys.slice(0,-1))node=node[key] && typeof node[key]==="object" ? node[key] : (node[key]={});
    const last=keys.at(-1);
    if(value===null)delete node[last];else node[last]=value;
    return root;
}
function update(root,event,data) {
    if(!data || !Object.hasOwn(data,"data"))throw Error("Invalid Firebase event");
    const keys=parts(data.path);
    if(event==="put")return replace(root,keys,data.data);
    if(event!=="patch" || !data.data || typeof data.data!=="object")throw Error("Invalid Firebase patch");
    for(const [key,value] of Object.entries(data.data))root=replace(root,[...keys,...parts('/'+key)],value);
    return root;
}
function parser(onEvent) {
    let pending="";
    return chunk=>{
        pending+=chunk;
        if(pending.length>8*1024*1024)throw Error("Firebase event too large");
        let match;
        while((match=/\r?\n\r?\n/.exec(pending))) {
            const frame=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
            let event="message";const lines=[];
            for(const line of frame.split(/\r?\n/)) {
                if(line.startsWith('event:'))event=line.slice(6).trim();
                if(line.startsWith('data:'))lines.push(line.slice(5).replace(/^ /,''));
            }
            if(lines.length)onEvent(event,JSON.parse(lines.join('\n')));
        }
    };
}
async function stream(client,path,signal,onEvent) {
    const token=await client.token();
    if(signal.aborted)return;
    let url=`${client.config.databaseURL}/${path}.json?auth=${encodeURIComponent(token)}`;
    const fetcher=globalThis.BdApi?.Net?.fetch ? (...args)=>BdApi.Net.fetch(...args) : globalThis.fetch;
    let response;
    for(let i=0;i<4;i++) {
        response=await fetcher(url,{headers:{Accept:"text/event-stream"},signal,redirect:"manual",maxRedirects:0,timeout:0});
        if(![301,302,303,307,308].includes(response.status))break;
        const next=new URL(response.headers.get('location'),url);
        if(next.username || next.password)throw Error('Unsafe Firebase redirect');
        validateConfig({apiKey:client.config.apiKey,databaseURL:next.origin});
        await response.body?.cancel();url=next.href;
    }
    if(response.status!==200) {await response.body?.cancel();const e=Error(`Firebase stream HTTP ${response.status}`);e.status=response.status;throw e;}
    if(!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('Firebase did not return an event stream');
    const reader=response.body.getReader(),decoder=new TextDecoder(),feed=parser(onEvent);
    try {while(!signal.aborted){const {done,value}=await reader.read();if(done)throw Error('Firebase stream closed');feed(decoder.decode(value,{stream:true}));}}
    finally {await reader.cancel().catch(()=>{});}
}
class Realtime {
    constructor(client,onValue,onFailure,open=stream) {this.client=client;this.onValue=onValue;this.onFailure=onFailure;this.open=open;this.entries=new Map();this.closed=false;}
    reconcile(paths) {
        const wanted=new Set(paths);
        for(const [path,e] of this.entries)if(!wanted.has(path)){e.abort?.abort();this.entries.delete(path);}
        for(const path of wanted)if(!this.entries.has(path))this.entries.set(path,{ready:false,retry:0,failures:0});
        for(const [path,e] of this.entries)if(!e.abort && Date.now()>=e.retry)this.connect(path,e);
    }
    healthy() {return this.entries.size>0 && [...this.entries.values()].every(e=>e.ready);}
    connect(path,e) {
        const abort=e.abort=new AbortController();e.ready=false;let value=null;
        const valid=()=>!this.closed&&!abort.signal.aborted&&this.entries.get(path)===e;
        let idle,renew;
        const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>abort.abort(),90000);};touch();
        renew=setTimeout(()=>abort.abort(),45*60*1000);
        Promise.resolve().then(()=>this.open(this.client,path,abort.signal,(event,data)=>{
            if(!valid())return;touch();
            if(event==='keep-alive')return;
            if(event==='auth_revoked'){this.client.session.expiresAt=0;throw Error('Firebase authentication expired');}
            if(event==='cancel'){const error=Error('Firebase stream access revoked');error.status=403;throw error;}
            if(event!=='put'&&event!=='patch')return;
            if(!e.ready && (event!=='put'||data.path!=='/'))throw Error('Missing initial Firebase snapshot');
            value=update(value,event,data);e.ready=true;e.failures=0;
            this.onValue(path,structuredClone(value));
        })).catch(error=>{if(valid())this.onFailure(path,error);}).finally(()=>{
            clearTimeout(idle);clearTimeout(renew);abort.abort();
            if(this.closed||this.entries.get(path)!==e)return;
            e.ready=false;e.abort=null;e.retry=Date.now()+Math.min(30000,1000*2**Math.min(e.failures++,5));
        });
    }
    close(){this.closed=true;for(const e of this.entries.values())e.abort?.abort();this.entries.clear();}
}
module.exports={Realtime,stream,parser,update};

},
"./health.cjs": (module, exports, require) => {
"use strict";
// A small local startup signal, without IDs, group data or credentials.
class RuntimeHealth {
    constructor(folder, identity, io = require("fs"), clock = Date.now) {
        this.io=io;this.clock=clock;this.identity=identity;this.startedAt=clock();this.next=0;
        const channel=identity.channel;
        if(!/^(stable|ptb|canary)$/.test(channel)||!folder)throw Error('Unknown Discord installation');
        this.file=require('path').join(folder,`RedflagAutoMute.health.${channel}.json`);
    }
    pulse(state='running') {
        const at=this.clock();if(state==='running'&&at<this.next)return;
        const temporary=this.file+'.tmp';
        this.io.writeFileSync(temporary,JSON.stringify({schema:1,state,startedAt:this.startedAt,seenAt:at,...this.identity}),'utf8');
        this.io.renameSync(temporary,this.file);this.next=at+60000;
    }
}
function createRuntimeHealth(pluginVersion) {
    const app=globalThis.DiscordNative?.app;
    const channel=globalThis.GLOBAL_ENV?.RELEASE_CHANNEL || app?.getReleaseChannel?.();
    const folder=globalThis.BdApi?.Plugins?.folder;
    return new RuntimeHealth(folder,{channel,pluginVersion,discordVersion:app?.getVersion?.() || ''});
}
module.exports={RuntimeHealth,createRuntimeHealth};

},
"./features.cjs": (module, exports, require) => {
"use strict";

const { summarize, desiredMutes, snowflake } = require("./core.cjs");
const BAN_NOTE = "[RedflagAutoMute] БАН в активной базе.";
const WARN_NOTE = "[RedflagAutoMute] В базе: жёлтый флаг (предупреждение).";

function databaseFlags(groups, options, selfId) {
    const blocked = desiredMutes(groups, { includeYellow: options.includeYellow }, selfId);
    const notes = {};
    const records = {};
    for (const group of groups) for (const [id, summary] of Object.entries(summarize(group))) {
        if (id === selfId) continue;
        const votes = Object.entries(group.cards[id]).filter(([author, vote]) => group.members?.[author] && ["red", "yellow"].includes(vote.type)).map(([, vote]) => vote);
        const isBan = summary.type === "red" || !!options.includeYellow;
        const times = type => votes.filter(v => v.type === type).map(v => Number(v.updatedAt)).filter(t => Number.isFinite(t) && t > 0).sort((a,b) => a-b);
        const red = times("red"), yellow = times("yellow");
        const at = isBan ? Math.min(red[0] || Infinity, yellow[options.includeYellow ? 0 : 1] || Infinity) : yellow[0];
        const record = { group: group.id, at: Number.isFinite(at) ? at : null, isBan };
        const old = records[id];
        if (!old || (isBan && !old.isBan) || (isBan === old.isBan && (record.at || Infinity) < (old.at || Infinity))) records[id] = record;
    }
    for (const [id, record] of Object.entries(records)) {
        const date = record.at ? new Date(record.at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "неизвестно";
        notes[id] = `[RedflagAutoMute] ${record.isBan ? "БАН" : "Предупреждение"}\nID: ${record.group ? record.group + "/" : ""}${id}\n${record.isBan ? "Забанен" : "Отмечен"}: ${date}`;
    }
    return { blocked, notes };
}

class VideoController {
    constructor(adapter, owned = {}, save = () => {}) {
        this.adapter = adapter;
        this.owned = Object.fromEntries(Object.entries(owned).filter(([id]) => snowflake(id)));
        this.save = save;
    }
    reconcile(desired) {
        for (const [id, previous] of Object.entries(this.owned)) {
            if (desired.has(id)) continue;
            if (this.adapter.state(id) === "DISABLED") this.adapter.set(id, previous);
            delete this.owned[id]; this.save({ ...this.owned });
        }
        for (const id of desired) {
            if (this.adapter.disabled(id)) continue;
            const previous = this.adapter.state(id);
            this.adapter.set(id, "DISABLED");
            if (!(id in this.owned)) this.owned[id] = previous;
            this.save({ ...this.owned });
        }
    }
}

function editNote(current, oldMarker, newMarker, limit = 256) {
    if (typeof current !== "string") throw new Error("Не удалось прочитать заметку Discord");
    if (newMarker && (current === newMarker || current.endsWith(`\n${newMarker}`))) return { text: current, skipped: false };
    let base = current;
    if (oldMarker) {
        if (base === oldMarker) base = "";
        else if (base.endsWith(`\n${oldMarker}`)) base = base.slice(0, -oldMarker.length - 1);
        else if (base.includes(oldMarker)) return { text: current, skipped: true };
    }
    const text = newMarker ? `${base}${base ? "\n" : ""}${newMarker}` : base;
    if (text.length > limit) return { text: current, skipped: true };
    return { text, skipped: false };
}

// One request chain at a time; never replace the user's note with a cached copy.
class NoteController {
    constructor(adapter, owned = {}, save = () => {}, valid = () => true) {
        this.adapter = adapter; this.owned = owned; this.save = save; this.valid = valid;
        this.desired = {}; this.checked = {}; this.busy = false; this.next = 0;
        this.priority = {}; this.revision = 0; this.retryAt = {};
        this.status = "Заметки: ожидание синхронизации";
    }
    async reconcile(desired, now = Date.now()) {
        const revision = ++this.revision;
        for (const id of new Set([...Object.keys(this.desired), ...Object.keys(desired)])) {
            if (this.desired[id] !== desired[id]) this.priority[id] = revision;
        }
        this.desired = { ...desired };
        if (this.busy || now < this.next || !this.valid() || this.adapter.editing?.()) return;
        const changed = uid => !this.checked[uid] || this.checked[uid].marker !== desired[uid];
        const id = [...new Set([...Object.keys(this.owned), ...Object.keys(desired)])].filter(snowflake).filter(uid => {
            const check = this.checked[uid];
            return now >= (this.retryAt[uid] || 0) && (changed(uid) || now - check.at >= 300000);
        }).sort((a,b) => Number(changed(b)) - Number(changed(a)) ||
            (changed(a) ? (this.priority[b] || 0) - (this.priority[a] || 0) : this.checked[a].at - this.checked[b].at))[0];
        if (!id) return;
        this.busy = true;
        try {
            const current = await this.adapter.read(id);
            if (!this.valid()) return;
            const marker = this.desired[id];
            const old = this.owned[id];
            const result = editNote(current, old, marker);
            if (result.skipped) {
                this.status = "Заметка пропущена: нет места или отметка отредактирована вручную";
            } else {
                if (result.text !== current) {
                    if (!this.valid()) return;
                    await this.adapter.write(id, result.text);
                }
                if (!this.valid()) return;
                if (marker) this.owned[id] = marker;
                else delete this.owned[id];
                this.save({ ...this.owned });
                this.status = "Заметки: синхронизированы";
            }
            this.checked[id] = { marker, at: now };
            delete this.retryAt[id];
            this.next = now + 2000;
        } catch (error) {
            this.status = `Заметки: ${error.message}`;
            this.retryAt[id] = now + 30000;
            this.next = now + (error.status === 429 ? 30000 : 2000);
        } finally { this.busy = false; }
    }
    get pendingCount() {
        return [...new Set([...Object.keys(this.owned), ...Object.keys(this.desired)])].filter(id =>
            !this.checked[id] || this.checked[id].marker !== this.desired[id]).length;
    }
}

class Highlights {
    constructor(api, doc) {
        this.api = api; this.doc = doc; this.marked = new Set(); this.blocked = new Set();
        this.selector = '[data-call-tile], [class*="voiceUser_"], img[src*="/avatars/"]';
        const Observer = doc.defaultView?.MutationObserver;
        this.observer = Observer ? new Observer(records => {
            // React can replace className or the whole tile on hover. Repair before
            // the next paint, rather than waiting for the one-second voice tick.
            if (records.some(r => r.type === "childList" || this.marked.has(r.target) || r.target.matches?.(this.selector))) this.refresh();
        }) : null;
        this.stopped = false;
    }
    observe() {
        if (!this.stopped && this.blocked.size && this.doc.body) this.observer?.observe(this.doc.body, {
            subtree: true, childList: true, attributes: true,
            attributeFilter: ["class", "src", "data-call-tile"]
        });
    }
    userId(element) {
        const avatarId = element.getAttribute("src")?.match(/\/avatars\/(\d{17,20})\//)?.[1];
        if (avatarId) return avatarId;
        let fiber = this.api.ReactUtils.getInternalInstance(element);
        for (let i = 0; fiber && i < 12; i++, fiber = fiber.return) {
            const p = fiber.memoizedProps;
            const id = p?.participantUserId || p?.user?.id || p?.userId;
            if (snowflake(id)) return id;
        }
    }
    update(blocked) {
        this.blocked = new Set(blocked);
        this.refresh();
    }
    refresh() {
        if (this.stopped) return;
        // Do not observe our own class mutations and create a feedback loop.
        this.observer?.disconnect();
        const next = new Set();
        if (this.blocked.size) for (const element of this.doc.querySelectorAll(this.selector)) {
            try {
                if (!this.blocked.has(this.userId(element))) continue;
                if (!element.classList.contains("rfam-blocked")) element.classList.add("rfam-blocked");
                next.add(element);
            } catch { /* Discord may detach a node during rendering. */ }
        }
        for (const element of this.marked) if (!next.has(element)) element.classList.remove("rfam-blocked");
        this.marked = next;
        this.observe();
    }
    stop() {
        this.stopped = true; this.observer?.disconnect(); this.blocked.clear();
        for (const e of this.marked) e.classList.remove("rfam-blocked"); this.marked.clear();
    }
}

module.exports = { databaseFlags, VideoController, NoteController, Highlights, editNote, BAN_NOTE, WARN_NOTE };

},
"./settings.cjs": (module, exports, require) => {
"use strict";
const { summarize } = require("./core.cjs");
const {makeInvite,makeDatabaseInvite,parseImport}=require("./transfer.cjs");

const CSS = `
.rf-settings{font-family:var(--font-primary,gg sans,sans-serif);color:var(--text-normal);line-height:1.45;padding:8px;min-width:0}
.rf-settings *{box-sizing:border-box}.rf-settings h2{font-size:20px;color:var(--header-primary);margin:0 0 4px}.rf-settings h3{font-size:16px;margin:0 0 8px;color:var(--header-primary)}
.rf-settings hr{border:0;border-top:1px solid var(--background-modifier-accent,#3f4147);margin:20px 0}.rf-settings p{margin:6px 0 16px;color:var(--text-muted)}.rf-settings nav{display:flex;gap:4px;border-bottom:1px solid var(--background-modifier-accent,rgba(128,128,128,.25));margin:20px 0;padding-bottom:8px;flex-wrap:wrap}
.rf-settings button:not(.bd-button){font:inherit;cursor:pointer;border:0;border-radius:4px;padding:9px 14px;background:var(--button-secondary-background,#4e5058);color:var(--button-secondary-text,#fff)}
.rf-settings button:not(.bd-button):hover{background:var(--button-secondary-background-hover,#6d6f78)}.rf-settings button:disabled{opacity:.5;cursor:default}
.rf-settings details{margin:12px 0}.rf-settings summary{cursor:pointer;color:var(--header-primary);padding:8px 0;font-weight:600}
.rf-settings .primary{background:var(--brand-500,#5865f2);color:white}.rf-settings .danger{color:var(--text-danger,#ed4245)}
.rf-settings nav button:not(.bd-button){background:transparent;color:var(--interactive-normal)}.rf-settings nav button:not(.bd-button)[aria-selected=true]{background:var(--background-modifier-selected,rgba(255,255,255,.12));color:var(--interactive-active,#fff)}
.rf-settings .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.rf-settings .spread{justify-content:space-between}.rf-settings .stack{display:grid;gap:12px}
.rf-settings .card{background:var(--background-secondary);border:1px solid var(--background-modifier-accent,rgba(128,128,128,.25));border-radius:8px;padding:16px;margin-bottom:12px}
.rf-settings label.field{display:grid;gap:6px;font-size:12px;font-weight:600;color:var(--header-secondary);margin:14px 0}
.rf-settings input:not([type=checkbox]),.rf-settings textarea{font:inherit;font-size:14px;color:var(--text-normal);background:var(--input-background,var(--background-tertiary));border:1px solid transparent;border-radius:4px;padding:10px;width:100%}
.rf-settings input:focus,.rf-settings textarea:focus{outline:2px solid var(--text-link,#00a8fc)}.rf-settings textarea{resize:vertical;min-height:80px}
.rf-settings .switch{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--background-modifier-accent,rgba(128,128,128,.25));padding:16px 0;align-items:center}
.rf-settings .switch small{display:block;color:var(--text-muted);margin-top:4px}.rf-settings .rf-fallback-switch{appearance:none;flex-shrink:0;width:40px;height:24px;border-radius:14px;background:var(--interactive-muted,#80848e);position:relative;cursor:pointer;margin:0}
.rf-settings .rf-fallback-switch:checked{background:var(--status-positive,#23a55a)}.rf-settings .rf-fallback-switch:after{content:'';position:absolute;background:white;width:18px;height:18px;border-radius:50%;top:3px;left:3px}.rf-settings .rf-fallback-switch:checked:after{left:19px}
.rf-settings small,.rf-settings .muted{color:var(--text-muted)}.rf-settings code{font-size:12px;overflow-wrap:anywhere}.rf-settings .notice{padding:12px;border-left:3px solid var(--brand-500,#5865f2);background:var(--background-secondary);margin:12px 0}.rf-settings .error{border-color:var(--text-danger,#ed4245);color:var(--text-danger)}
`;

function settingsPanel(plugin, parseInvite) {
    const R = BdApi.React, h = R.createElement;
    function Settings() {
        const [tab, setTab] = R.useState(plugin.account?.session ? "groups" : "connect");
        const [selected, select] = R.useState(null);
        const [flow, setFlow] = R.useState(null);
        const [form, setForm] = R.useState({});
        const [busy, setBusy] = R.useState(false);
        const [transfer,setTransfer]=R.useState(null);
        const [exportOptions,setExportOptions]=R.useState({includeZeroVolume:false,includeBlocked:false});
        const [message, setMessage] = R.useState(null);
        const [, render] = R.useReducer(n=>n+1,0);
        const live = R.useRef(true);
        R.useEffect(()=>{live.current=true;const timer=setInterval(()=>render(),3000);return()=>{live.current=false;clearInterval(timer);};},[]);
        const account = plugin.account;
        if (!account) return h("p",null,"Включите плагин и войдите в Discord.");
        const epoch = plugin.epoch;
        const run = async fn => {
            if(busy || epoch!==plugin.epoch) return;
            setBusy(true);setMessage(null);
            try {await fn();} catch(e) {if(live.current)setMessage(e.message || String(e));}
            finally {if(live.current){setBusy(false);render();}}
        };
        const btn=(label,fn,kind="")=>h(BdApi.Components?.Button || "button",{type:"button",className:BdApi.Components?.Button ? "" : kind,color:kind==="primary"?"bd-button-color-brand":kind==="danger"?"bd-button-color-red":"bd-button-color-primary",size:"bd-button-small",disabled:busy,onClick:()=>run(fn)},label);
        const text=s=>h("p",null,s);
        const card=(...children)=>h("section",{className:"card"},...children);
        const row=(...children)=>h("div",{className:"row"},...children);
        const field=(key,label,type="text",hint="")=>h("label",{className:"field"},label,h("input",{type,value:form[key]||"",autoComplete:type==="password"?"new-password":"off",onChange:e=>setForm({...form,[key]:e.target.value}),onKeyDown:e=>e.stopPropagation(),placeholder:hint}));
        const toggle=(label,description,value,change)=>h("label",{className:"switch"},h("span",null,label,h("small",null,description)),BdApi.Components?.SwitchInput ? h(BdApi.Components.SwitchInput,{value:!!value,disabled:busy,onChange:v=>{change(v);render();}}) : h("input",{className:"rf-fallback-switch",type:"checkbox",role:"switch",disabled:busy,checked:!!value,onChange:e=>{change(e.target.checked);render();}}));
        const go=(next)=>{setFlow(next);setForm({});setTransfer(null);setMessage(null);};
        const saveExport=async(data,name)=>{ if(!globalThis.DiscordNative?.fileManager?.saveWithDialog)throw Error("Диалог сохранения недоступен. Скопируйте JSON из поля ниже."); await DiscordNative.fileManager.saveWithDialog(new TextEncoder().encode(data),name); };
        const join=async data=>{
            if(!data.code)throw Error("Это приглашение к базе. Для вступления в группу попросите отдельное приглашение группы.");
            if(data.databaseURL!==plugin.client.config.databaseURL || data.apiKey!==plugin.client.config.apiKey) throw Error("Это приглашение из другой базы. Сначала выйдите из аккаунта в разделе «Подключение».");
            const id=await plugin.client.joinGroup(data.code);
            if(epoch!==plugin.epoch)return;
            if(!account.groups.some(g=>g.id===id))account.groups.push({id,name:id.slice(0,8),enabled:true});
            plugin.pendingInvite=null;plugin.groupsRevision=(plugin.groupsRevision||0)+1;plugin.save();await plugin.sync();setTab("groups");setFlow(null);select(id);
        };
        let body;
        if(tab==="groups") {
            const group=account.groups.find(g=>g.id===selected);
            if(!account.session) body=card(h("h3",null,"Войдите, чтобы управлять группами"),text("Группы доступны участникам по приглашению."),btn("Перейти к подключению",()=>setTab("connect"),"primary"));
            else if(group) {
                const snapshot=account.cache[group.id], owner=snapshot?.owner===account.session.uid;
                body=h("div",null,btn("← Все мои группы",()=>{select(null);go(null);}),h("h2",{style:{marginTop:16}},group.name),
                    toggle("Применять эту группу","Отключение снимает её ограничения только у вас. Членство сохраняется.",group.enabled,v=>{group.enabled=v;plugin.save();plugin.apply();plugin.nextSync=0;}),
                    text(owner?"Вы — владелец группы.":"Вы — участник группы."),
                    !snapshot?text("Данные пока не загружены. Обновите список или проверьте подключение."):h("div",null,
                        row(btn("Пригласить друга",()=>go(flow==="share"?null:"share")),btn("Участники",()=>go(flow==="members"?null:"members")),btn("Импорт / экспорт",()=>go(flow==="transfer"?null:"transfer"))),
                        flow==="share"?card(h("h3",null,"Приглашение в группу"),text("Передайте этот код другу. Он откроет «Подключение → У меня есть приглашение». Код даёт доступ к группе — не публикуйте его."),h("textarea",{readOnly:true,"aria-label":"Код приглашения",value:makeInvite(plugin.client.config,group.id,snapshot.inviteSecret),onFocus:e=>e.target.select()}),owner?btn("Заменить код приглашения",async()=>{await plugin.client.rotateInvite(group.id);await plugin.sync();}):null):null,
                        flow==="transfer"?card(
                            h("h3",null,"Мои мьюты → в эту группу"),
                            text(`Перенесите сохранённые мьюты Discord в «${group.name}». Они станут вашими красными флажками для всей группы. Повторы объединятся автоматически.`),
                            h("details",null,h("summary",null,"Что включить в список"),
                                text("Обычные мьюты включены всегда."),
                                toggle("Громкость 0%","Также добавить тех, кому вы убрали звук ползунком.",exportOptions.includeZeroVolume,v=>{setExportOptions({...exportOptions,includeZeroVolume:v});setTransfer(null);}),
                                toggle("Заблокированные аккаунты","Также добавить пользователей из вашего списка блокировок.",exportOptions.includeBlocked,v=>{setExportOptions({...exportOptions,includeBlocked:v});setTransfer(null);})),
                            btn("Добавить мои мьюты в группу",async()=>{
                                setTransfer(null);
                                const result=plugin.exportMutes(undefined,exportOptions);
                                const count=await plugin.importMutes(group.id,result.ids);
                                if(epoch!==plugin.epoch || !live.current || count===undefined)return;
                                setTransfer({mode:"done",count});
                            },"primary"),
                            transfer?.mode==="done"?h("div",{className:"notice",role:"status"},`Готово! Обработано пользователей: ${transfer.count}. Список группы обновлён, повторы объединены.`):null,
                            h("hr",null),
                            h("details",null,h("summary",null,"Загрузить список из файла"),
                                text("Выберите JSON / TXT или вставьте список Discord ID. Перед добавлением покажем количество пользователей."),
                                h("label",{className:"field"},"Файл со списком (до 2 МБ)",h("input",{type:"file",accept:".json,.txt",disabled:busy,onChange:e=>{
                                    const file=e.target.files?.[0];
                                    if(file)void run(async()=>{
                                        if(file.size>2*1024*1024)throw Error("Файл больше 2 МБ");
                                        const value=await file.text();
                                        if(epoch!==plugin.epoch || !live.current)return;
                                        setForm({...form,importText:value});setTransfer(null);
                                    });
                                }})),
                                h("textarea",{value:form.importText||"",disabled:busy,"aria-label":"Список для импорта",placeholder:"Или вставьте JSON / Discord ID сюда",onChange:e=>{setForm({...form,importText:e.target.value});setTransfer(null);},onKeyDown:e=>e.stopPropagation()}),
                                btn("Проверить список",()=>{
                                    const ids=parseImport(form.importText||"").filter(id=>id!==plugin.accountId);
                                    if(!ids.length)throw Error("Нет пользователей для импорта");
                                    const added=ids.filter(id=>!snapshot.cards?.[id]).length;
                                    if(Object.keys(snapshot.cards||{}).length+added>5000)throw Error("После импорта будет больше 5000 записей в группе.");
                                    setTransfer({mode:"import",ids,added});
                                }),
                                transfer?.mode==="import"?h("div",null,
                                    text(`Пользователей: ${transfer.ids.length}. Новых в группе: ${transfer.added}. Будут добавлены ваши красные флажки для всей группы.`),
                                    btn("Добавить в группу",async()=>{
                                        const count=await plugin.importMutes(group.id,transfer.ids);
                                        if(epoch!==plugin.epoch || !live.current || count===undefined)return;
                                        setTransfer({mode:"done",count});setForm({});
                                    },"primary")):null),
                            h("details",null,h("summary",null,"Сохранить список в файл"),
                                text("Для друга или резервной копии. Файл содержит только Discord ID."),
                                row(btn("Мои мьюты Discord",async()=>{
                                    const result=plugin.exportMutes(undefined,exportOptions);
                                    setTransfer({...result,mode:"export"});
                                    await saveExport(result.text,"RedflagAutoMute-mutes.json");
                                }),btn("Мьюты этой группы",async()=>{
                                    const result=plugin.exportMutes(group.id);
                                    setTransfer({...result,mode:"export"});
                                    await saveExport(result.text,"RedflagAutoMute-group.json");
                                })),
                                transfer?.mode==="export"?h("details",null,h("summary",null,`Скопировать список · ${transfer.ids.length}`),h("textarea",{readOnly:true,value:transfer.text,"aria-label":"Экспортированный список",onFocus:e=>e.target.select()})):null)
                        ):null,
                        flow==="members"?card(h("h3",null,`Участники · ${Object.keys(snapshot.members||{}).length}`),text("Это ID аккаунтов плагина, не Discord ID."),...Object.keys(snapshot.members||{}).map(uid=>h("div",{className:"row spread",key:uid},h("code",null,uid===account.session.uid?`${uid} · вы`:uid),owner&&uid!==snapshot.owner?btn("Исключить",async()=>{await plugin.client.removeMember(group.id,uid,true);await plugin.sync();},"danger"):h("small",null,uid===snapshot.owner?"Владелец":"Участник")))):null,
                        h("h3",{style:{marginTop:24}},`Пользователи в базе · ${Object.keys(snapshot.cards||{}).length} / 5000`),text("Чтобы добавить человека: ПКМ по нему в Discord → Redflag → название группы → флажок."),
                        field("search","Найти пользователя по Discord ID","text","Необязательно"),
                        text("Показаны первые 100 совпадений. Для большого списка используйте поиск по ID."),
                        ...Object.entries(summarize(snapshot)).filter(([id])=>id.includes(form.search||"")).slice(0,100).map(([id,status])=>card(h("div",{className:"row spread"},plugin.flagLabel(BdApi.Webpack.getStore("UserStore")?.getUser(id)?.username||id,status.type==="red"?"#ed4245":"#fee75c"),h("small",null,`Красных: ${status.red} · жёлтых: ${status.yellow}`)),h("code",null,`ID: ${id}`),snapshot.cards[id]?.[account.session.uid]?btn("Отозвать мой флажок",()=>plugin.setCard(group.id,id,null)):null)),
                        Object.keys(summarize(snapshot)).length?null:card(text("Здесь пока никого нет. Новые флажки появятся автоматически.")),
                        btn("Добавить по Discord ID",()=>go(flow==="target"?null:"target")),flow==="target"?card(field("target","Discord ID · обязательно","text","17–20 цифр"),row(btn(plugin.flagLabel("Красный флажок","#ed4245"),()=>plugin.setCard(group.id,(form.target||"").trim(),"red")),btn(plugin.flagLabel("Жёлтый флажок","#fee75c"),()=>plugin.setCard(group.id,(form.target||"").trim(),"yellow")))):null),
                    h("hr",null),owner?btn("Удалить группу",()=>BdApi.UI.showConfirmationModal("Удалить группу «" + group.name + "»?", "Группа, все карточки и приглашение будут удалены из базы для всех участников. Отменить удаление нельзя. Если хотите только перестать применять её у себя, отключите переключатель группы.", {danger:true,confirmText:"Удалить навсегда",cancelText:"Отмена",onConfirm:()=>run(async()=>{await plugin.deleteGroup(group.id);select(null);go(null);})}),"danger"):btn("Выйти из группы",()=>go("leave"),"danger"),
                    flow==="leave"?card(text("Группа исчезнет из вашего списка, её ограничения перестанут действовать. Ваши голоса больше не будут учитываться. Чтобы вернуться, понадобится приглашение."),row(btn("Остаться",()=>go(null)),btn("Выйти из этой группы",async()=>{await plugin.client.removeMember(group.id,account.session.uid);if(epoch!==plugin.epoch)return;plugin.groupsRevision=(plugin.groupsRevision||0)+1;account.groups=account.groups.filter(g=>g.id!==group.id);delete account.cache[group.id];plugin.save();plugin.apply();select(null);go(null);},"danger"))):null);
            } else body=h("div",null,h("h2",null,"Мои группы"),text("Здесь все группы вашего аккаунта в подключённой базе. Список автоматически загружается после входа, в том числе на другом устройстве. Закрытые группы других людей не отображаются — присоединиться можно по приглашению."),row(btn("Создать группу",()=>go("create"),"primary"),btn("По приглашению",()=>go("join")),btn("Обновить список",()=>plugin.sync())),
                flow==="create"?card(h("h3",null,"Новая группа"),text("Отдельный список для вашей компании. Можно владеть максимум 5 группами; после удаления место освобождается."),field("name","Название · обязательно","text","Например, друзья из голосового"),row(btn("Создать",async()=>{const name=(form.name||"").trim();const id=await plugin.client.createGroup(name);if(epoch!==plugin.epoch)return;account.groups.push({id,name,enabled:true});plugin.groupsRevision=(plugin.groupsRevision||0)+1;plugin.save();await plugin.sync();go(null);select(id);},"primary"),btn("Отмена",()=>go(null)))):null,
                flow==="join"?card(field("invite","Код приглашения · обязательно","text","rfdb1.… или rfam1.…"),row(btn("Присоединиться",()=>join(parseInvite((form.invite||"").trim())),"primary"),btn("Отмена",()=>go(null)))):null,
                h("div",{style:{marginTop:16}},...account.groups.map(g=>card(h("div",{className:"row spread"},h("div",null,h("h3",null,g.name),h("small",null,g.enabled?"Применяется":"Отключена")),btn("Открыть",()=>{select(g.id);go(null);}))))),account.groups.length?null:card(h("h3",null,"Пока нет групп"),text("Создайте группу для друзей или вставьте полученное от них приглашение.")));
        } else if(tab==="connect") {
            body=h("div",null,h("h2",null,"Подключение"),text("Одна база — несколько независимых групп. Аккаунт плагина создаётся в уже настроенном Firebase-проекте. Регистрация не создаёт базу и не меняет ваш Google-аккаунт."),
                account.session?card(h("h3",null,"Вы подключены"),text("Вход выполнен. Можно создавать группы и вступать по приглашениям."),h("code",null,plugin.config.databaseURL),btn("Поделиться подключением",()=>go(flow==="database-share"?null:"database-share")),flow==="database-share"?card(h("h3",null,"Приглашение к базе"),text("Друг вставляет код в «Подключение → У меня есть приглашение» и создаёт свой аккаунт. Код содержит адрес базы и публичный ключ проекта, без пароля, токенов и доступа к вашим группам. Для вступления в группу передайте приглашение группы — оно тоже настроит базу."),h("textarea",{readOnly:true,"aria-label":"Приглашение к базе",value:makeDatabaseInvite(plugin.client.config),onFocus:e=>e.target.select()})):null,text("Для подключения к другой базе сначала выйдите. При смене базы отобразятся группы другого проекта. При возвращении и входе ваш список загрузится из базы."),btn("Выйти из аккаунта плагина",()=>{plugin.controller?.reconcile(new Set());plugin.video?.reconcile(new Set());plugin.epoch++;account.session=null;account.cache={};plugin.save();plugin.makeClient();plugin.apply();go(null);},"danger")):
                h("div",null,row(btn("У меня есть приглашение",()=>go("invite"),"primary"),btn("Настроить свою базу",()=>go("manual"))),
                    flow==="invite"?card(field("invite","Приглашение от друга · обязательно","text","rfam1.…"),btn("Продолжить",()=>{const data=parseInvite((form.invite||"").trim());plugin.configure(data);plugin.pendingInvite=data.code||null;go(null);},"primary")):null,
                    flow==="manual"?card(h("h3",null,"Для владельца базы"),text("Сначала создайте Firebase-проект, включите Email/Password и Realtime Database, опубликуйте правила из инструкции проекта. Эти поля нужны только владельцу; друзья получат настройки с приглашением."),field("database","Realtime Database URL · обязательно","url","https://…firebasedatabase.app"),field("key","Web API key · обязательно"),btn("Сохранить подключение",()=>{plugin.configure({databaseURL:(form.database||"").trim(),apiKey:(form.key||"").trim()});go(null);},"primary")):null,
                    plugin.client?card(h("h3",null,flow==="register"?"Создать аккаунт плагина":"Войти в аккаунт плагина"),text("Email и отдельный пароль для этой базы. Это не пароль Discord или Google."),field("email","Email · обязательно","email"),field("password","Пароль · обязательно (от 6 символов)","password"),row(btn(flow==="register"?"Создать аккаунт":"Войти",async()=>{if(!form.email?.trim()||!form.password||form.password.length<6)throw Error("Укажите email и пароль длиной от 6 символов.");await plugin.client.signIn(form.email.trim(),form.password,flow==="register");if(epoch!==plugin.epoch)return;setForm({});if(plugin.pendingInvite)await join({...plugin.client.config,code:plugin.pendingInvite});else{setTab("groups");go(null);await plugin.sync();}},"primary"),btn(flow==="register"?"Уже есть аккаунт":"Нет аккаунта? Создать",()=>{setFlow(flow==="register"?null:"register");setMessage(null);})),plugin.pendingInvite?text("После входа вы автоматически присоединитесь к приглашённой группе."):null):text("Начните с приглашения друга. Если вы первый в компании — настройте свою базу.")));
        } else if(tab==="preferences") body=h("div",null,h("h2",null,"Мои настройки"),text("Эти настройки действуют только у вас."),
            ...[["includeYellow","Мутить за один жёлтый флажок","По умолчанию нужны два жёлтых от разных участников одной группы.",false],["disableVideo","Отключать видео","Вместе с голосом скрывать вебкамеру только у вас.",true],["markNotes","Добавлять информацию в заметки","ID записи и время блокировки. Ваш текст сохраняется. При выключенном плагине остаётся последний известный статус.",true]].map(([key,label,desc,fallback])=>toggle(label,desc,account[key]??fallback,v=>{account[key]=v;plugin.save();plugin.apply();})),
            h("h3",{style:{marginTop:20}},"Личные исключения"),text("ПКМ по человеку → Redflag → всегда разрешать / всегда мутить. Разрешение отменяет звук и видео-мут, но отметка базы остаётся."),...Object.entries(account.overrides).map(([id,value])=>card(h("code",null,id),text(value==="allow"?"Всегда разрешён":"Всегда замьючен"),btn("Следовать правилам групп",()=>plugin.override(id,null)))),Object.keys(account.overrides).length?null:text("Исключений нет."));
        else body=h("div",null,h("h2",null,"Как это работает"),card(h("h3",null,"Флажки и мут"),text("Один красный или два жёлтых от разных участников одной включённой группы отключают звук и видео. Жёлтые из разных групп не складываются. При отзыве флажков ограничения снимаются.")),card(h("h3",null,"Группы"),text("Группа — отдельный список внутри подключённой базы. Учитываются все ваши включённые группы. Выключение группы действует только у вас; выход прекращает членство. Каталога чужих групп нет. После входа на другом устройстве список групп загружается автоматически. Владелец может удалить группу для всех участников с подтверждением.")),card(h("h3",null,"Заметки"),text("ID записи — ID группы / Discord ID пользователя. Время берётся из сохранённых флажков, вызвавших блокировку, в UTC. Это время по текущим голосам: после отзыва или замены карточек оно может измениться; отдельной истории банов пока нет. Если пользователь отмечен в нескольких группах, показана самая ранняя действующая блокировка.")),h("details",null,h("summary",null,"Диагностика"),text(plugin.status),text(plugin.notes?.status||"Заметки: ожидание"),plugin.notes?text(`Заметок в очереди: ${plugin.notes.pendingCount}`):null,text(plugin.video?"Видео подключено":"Видео недоступно")));
        return h("div",{className:"rf-settings"},h("style",null,CSS),h("h2",null,"RedflagAutoMute"),text("Муть токсичных людей вместе с друзьями."),h("nav",{"aria-label":"Разделы настроек",role:"tablist"},...[ ["groups","Мои группы"],["connect","Подключение"],["preferences","Мои настройки"],["help","Как это работает"] ].map(([key,label])=>h("button",{key,role:"tab","aria-selected":tab===key,onClick:()=>{setTab(key);go(null);select(null);}},label))),message?h("div",{className:"notice error",role:"alert"},message):null,busy?h("div",{role:"status",className:"notice"},"Подождите…"):null,body);
    }
    return h(Settings);
}
module.exports={settingsPanel};

},
"./plugin.cjs": (module, exports, require) => {
"use strict";

const { desiredMutes, summarize, MuteController, snowflake } = require("./core.cjs");
const { FirebaseClient, validateConfig } = require("./firebase.cjs");
const { transport } = require("./transport.cjs");
const { Realtime } = require("./realtime.cjs");
const { createRuntimeHealth } = require("./health.cjs");
const { databaseFlags, VideoController, NoteController, Highlights } = require("./features.cjs");
const { settingsPanel } = require("./settings.cjs");
const {discordExport,exportList,bannedIds}=require("./transfer.cjs");
const NAME = "RedflagAutoMute";
const DEFAULT_CONFIG = require("../firebase.public.json");

function parseInvite(text) {
    if (typeof text!=="string" || !/^(rfam1|rfdb1)\.[A-Za-z0-9_-]+$/.test(text) || text.length > 4096) throw new Error("Ожидается приглашение rfam1.… или rfdb1.…");
    const data = JSON.parse(Buffer.from(text.slice(6).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const config = validateConfig(data);
    if(text.startsWith("rfdb1.")) return config;
    if (!/^[a-f0-9]{48}\.[a-f0-9]{48}$/.test(data.code)) throw new Error("Повреждённый код приглашения");
    return { ...config, code: data.code };
}

module.exports = class RedflagAutoMute {
    start() {
        this.running = true;
        this.epoch = (this.epoch || 0) + 1;
        this.config = BdApi.Data.load(NAME, "config") || DEFAULT_CONFIG;
        this.accounts = BdApi.Data.load(NAME, "accounts") || {};
        this.status = "Настройте Firebase и войдите";
        this.versions = {};
        BdApi.DOM?.addStyle(NAME, '.rfam-blocked { outline: 3px solid #ed4245 !important; outline-offset: -3px !important; } [class*="voiceUser_"].rfam-blocked { border-radius: var(--radius-sm, 6px) !important; } [data-call-tile].rfam-blocked::after { content: ""; position: absolute; inset: 0; z-index: 100; pointer-events: none; border-radius: inherit; box-shadow: inset 0 0 0 3px #ed4245; } img.rfam-blocked { border-radius: 50%; outline-offset: 1px !important; }');
        if (typeof document !== "undefined") this.highlights = new Highlights(BdApi, document);
        this.unpatches = ["user-context", "user-profile", "user-profile-overflow-menu"].map(nav =>
            BdApi.ContextMenu.patch(nav, (tree, props) => this.patchMenu(tree, props)));
        try { this.runtimeHealth = createRuntimeHealth("2.0.4"); this.runtimeHealth.pulse(); } catch { /* Optional local maintenance signal. */ }
        this.tick();
        this.timer = setInterval(() => this.tick(), 1000);
    }
    save() { BdApi.Data.save(NAME, "accounts", this.accounts); }
    error(error) {
        this.status = error.message || String(error);
        BdApi.UI.showToast(`Redflag: ${this.status}`, { type: "error" });
    }
    tick() {
        try { this.runtimeHealth?.pulse(); } catch { /* Maintenance must not interrupt the plugin. */ }
        try {
            const id = BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id;
            if (!id) return;
            if (id !== this.accountId) {
                this.epoch++;
                this.accountId = id;
                this.account = this.accounts[id] ||= { groups: [], overrides: {}, owned: [], cache: {} };
                this.controller = null;
                this.video = null; this.notes = null;
                this.highlights?.update(new Set());
                this.makeClient();
                this.nextSync = 0;
            }
            if (!this.controller) {
                const store = BdApi.Webpack.getStore("MediaEngineStore");
                const actions = BdApi.Webpack.getByKeys("toggleLocalMute");
                if (!store?.isLocalMute || !actions?.toggleLocalMute) {
                    this.status = "Ожидание голосовых модулей Discord. Откройте голосовой канал.";
                    return;
                }
                const account = this.account;
                this.controller = new MuteController({
                    isMuted: uid => store.isLocalMute(uid), toggle: uid => actions.toggleLocalMute(uid)
                }, account.owned || [], owned => { account.owned = owned; this.save(); });
            }
            this.setupFeatures();
            this.setupVoiceWatchers();
            this.apply();
            this.setupRealtime();
            if (this.client?.session && !this.realtime?.healthy() && Date.now() >= (this.nextSync || 0)) void this.sync();
        } catch (error) { this.status = error.message; }
    }
    makeClient() {
        this.realtime?.close(); this.realtime = null;
        this.client = null;
        this.notes = null;
        try {
            const epoch = this.epoch, account = this.account;
            const project = validateConfig(this.config).databaseURL;
            if (account.project && account.project !== project) {
                account.session = null; account.firebaseUid = null; account.groups = []; account.cache = {};
            }
            account.project = project;
            this.client = new FirebaseClient(this.config, transport, account.session, session => {
                if (this.running && epoch === this.epoch) {
                    if (account.firebaseUid && account.firebaseUid !== session.uid) { account.groups = []; account.cache = {}; }
                    account.firebaseUid = session.uid; account.session = session; this.save();
                }
            });
        } catch { /* Empty configuration is expected on first run. */ }
    }
    setupRealtime() {
        if (!this.client?.session) { this.realtime?.close(); this.realtime = null; return; }
        const client = this.client, epoch = this.epoch, account = this.account;
        if (!this.realtime) this.realtime = new Realtime(client, (path, value) => {
            if (!this.running || this.epoch !== epoch || this.client !== client) return;
            if (path.startsWith("userGroups/")) {
                const ids = Object.keys(value || {}).filter(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id));
                const old = new Map(account.groups.map(g => [g.id,g]));
                account.groups = ids.map(id => old.get(id) || {id,name:id.slice(0,8),enabled:true});
                this.groupsRevision = (this.groupsRevision || 0) + 1;
                for (const id of Object.keys(account.cache)) if (!ids.includes(id)) delete account.cache[id];
                this.setupRealtime();
            } else {
                const id = path.slice(7);
                this.versions[id] = (this.versions[id] || 0) + 1;
                const group = account.groups.find(g => g.id === id);
                if (!group) return;
                if (value && value.members?.[client.session.uid]) { account.cache[id] = value; group.name = value.name; }
                else delete account.cache[id];
            }
            this.status = `Событийная синхронизация ${new Date().toLocaleTimeString()}`;
            this.save(); this.apply();
        }, (path, error) => {
            if (!this.running || this.epoch !== epoch || this.client !== client) return;
            if ([401,403].includes(error.status) && path.startsWith("groups/")) {
                const id = path.slice(7);
                this.versions[id] = (this.versions[id] || 0) + 1;
                delete account.cache[id]; this.save(); this.apply();
            }
            if ([401,403].includes(error.status) && path.startsWith("userGroups/")) {
                this.groupsRevision = (this.groupsRevision || 0) + 1;
                for (const id of Object.keys(account.cache)) this.versions[id] = (this.versions[id] || 0) + 1;
                account.cache = {}; this.save(); this.apply();
            }
            this.status = "Соединение с событиями прервано; резервная синхронизация";
            this.nextSync = 0;
        });
        this.realtime.reconcile([`userGroups/${client.session.uid}`, ...account.groups.map(g => `groups/${g.id}`)]);
    }
    active() {
        return (this.account?.groups || []).filter(g => g.enabled && this.account.cache?.[g.id]).map(g => ({ ...this.account.cache[g.id], id: g.id }));
    }
    setupFeatures() {
        const account = this.account, epoch = this.epoch;
        if (!this.video) {
            const store = BdApi.Webpack.getStore("MediaEngineStore");
            const actions = BdApi.Webpack.getByKeys("setDisableLocalVideo");
            if (store?.isLocalVideoDisabled && store?.getVideoToggleState && actions?.setDisableLocalVideo) {
                this.video = new VideoController({ disabled: id => store.isLocalVideoDisabled(id), state: id => store.getVideoToggleState(id), set: (id, value) => actions.setDisableLocalVideo(id, value) }, account.videoOwned || {}, owned => { account.videoOwned = owned; this.save(); });
            }
        }
        if (!this.notes) {
            const http = BdApi.Webpack.getModule(m => m && typeof m === "object" && typeof m.get === "function" && typeof m.put === "function" && typeof m.del === "function" && typeof m.patch === "function", { searchExports: true });
            const actions = BdApi.Webpack.getByKeys("updateNote");
            if (http && actions) this.notes = new NoteController({
                read: async id => {
                    try {
                        const res = await http.get({ url: `/users/@me/notes/${id}`, retries: 0 });
                        if (res.body?.note === null) return "";
                        if (typeof res.body?.note !== "string") throw new Error("Неизвестный формат заметки Discord");
                        return res.body.note;
                    } catch (e) { if (e.status === 404) return ""; throw e; }
                },
                write: (id, value) => actions.updateNote(id, value),
                editing: () => typeof document !== "undefined" && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
            }, account.noteOwned || {}, owned => { account.noteOwned = owned; this.save(); },
            () => this.running && this.epoch === epoch && BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id === this.accountId);
        }
    }
    setupVoiceWatchers() {
        this.voiceWatchers ||= [];
        for (const name of ["VoiceStateStore", "SelectedChannelStore", "MediaEngineStore"]) {
            const store = BdApi.Webpack.getStore(name);
            if (!store?.addChangeListener || !store?.removeChangeListener || this.voiceWatchers.some(item => item.store === store)) continue;
            const listener = () => {
                if (!this.running || this.voiceApplyTimer != null) return;
                // Leave Flux dispatch before toggling mute; coalesce simultaneous events.
                this.voiceApplyTimer = setTimeout(() => {
                    this.voiceApplyTimer = null;
                    if (this.running) try { this.apply(); } catch (error) { this.error(error); }
                }, 0);
            };
            store.addChangeListener(listener);
            this.voiceWatchers.push({ store, listener });
        }
    }
    voiceTargets(desired) {
        const selected = BdApi.Webpack.getStore("SelectedChannelStore");
        const voice = BdApi.Webpack.getStore("VoiceStateStore");
        // Unknown API must not cause a bulk mute of the entire database.
        if (!selected?.getVoiceChannelId || !voice?.getVoiceStatesForChannel) return null;
        const channel = selected.getVoiceChannelId();
        if (!channel) return new Set();
        const states = voice.getVoiceStatesForChannel(channel);
        if (!states || typeof states !== "object") return null;
        return new Set(Object.keys(states).filter(id => desired.has(id)));
    }
    apply() {
        if (!this.running || BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id !== this.accountId) return;
        const desired = desiredMutes(this.active(), this.account, this.accountId);
        const flags = databaseFlags(this.active(), this.account, this.accountId);
        const audible = this.voiceTargets(desired);
        if (audible) {
            this.controller?.reconcile(audible);
            this.video?.reconcile(this.account.disableVideo !== false ? audible : new Set());
        }
        this.highlights?.update(flags.blocked);
        void this.notes?.reconcile(this.account.markNotes !== false ? flags.notes : {});
    }
    async sync() {
        if (!this.client?.session) return;
        const epoch = this.epoch;
        if (this.syncEpoch === epoch) return;
        this.syncEpoch = epoch;
        const account = this.account, client = this.client;
        const problems = [];
        try {
            const revision = this.groupsRevision || 0;
            try {
                const ids = await client.listGroups(account.groups.map(g => g.id));
                if (!this.running || epoch !== this.epoch) return;
                if ((this.groupsRevision || 0) !== revision) { this.nextSync = 0; return; }
                const old = new Map(account.groups.map(g => [g.id, g]));
                account.groups = ids.map(id => old.get(id) || { id, name: id.slice(0,8), enabled: true });
                for (const id of Object.keys(account.cache)) if (!ids.includes(id)) delete account.cache[id];
            } catch (error) {
                if (!this.running || epoch !== this.epoch) return;
                problems.push(`Список групп: ${error.message}`);
            }
            for (const group of [...account.groups]) {
                try {
                    const version = this.versions[group.id] || 0;
                    const snapshot = await client.readGroup(group.id);
                    if (!this.running || epoch !== this.epoch) return;
                    if ((this.versions[group.id] || 0) !== version) continue;
                    if (!account.groups.some(g => g.id === group.id)) continue;
                    if (snapshot) { account.cache[group.id] = snapshot; group.name = snapshot.name; }
                    else { delete account.cache[group.id]; account.groups = account.groups.filter(g => g.id !== group.id); await client.forgetGroup(group.id); }
                } catch (error) {
                    if (!this.running || epoch !== this.epoch) return;
                    // Revoked access must not keep applying cached cards.
                    if ([401, 403].includes(error.status)) {
                        delete account.cache[group.id];
                        account.groups = account.groups.filter(g => g.id !== group.id);
                        try { await client.forgetGroup(group.id); } catch { /* Retry stale-index cleanup on next discovery. */ }
                    }
                    problems.push(`${group.name}: ${error.message}`);
                }
            }
            if (!this.running || epoch !== this.epoch) return;
            this.status = problems.length ? `Нет синхронизации: ${problems.join("; ")}` : `Синхронизировано ${new Date().toLocaleTimeString()}`;
            this.nextSync = Date.now() + (problems.length ? 30000 : 5000);
            this.save();
            this.apply();
        } finally { if (this.syncEpoch === epoch) this.syncEpoch = null; }
    }
    async deleteGroup(id) {
        const epoch = this.epoch;
        await this.client.deleteGroup(id);
        if (!this.running || epoch !== this.epoch) return;
        this.groupsRevision = (this.groupsRevision || 0) + 1;
        this.versions[id] = (this.versions[id] || 0) + 1;
        this.account.groups = this.account.groups.filter(g => g.id !== id);
        delete this.account.cache[id]; this.save(); this.apply(); this.nextSync = 0;
    }
    exportMutes(groupId,options={}) {
        const result=groupId?{ids:bannedIds(this.account.cache[groupId]||{})}:discordExport(BdApi.Webpack.getStore("MediaEngineStore"),this.accountId,BdApi.Webpack.getStore("RelationshipStore"),options);
        return {...result,text:exportList(result.ids,groupId?"group":"discord-local-selection")};
    }
    async importMutes(groupId,ids) {
        ids=ids.filter(id=>id!==this.accountId);
        if(!ids.length)throw Error("Нет пользователей для импорта");
        const epoch=this.epoch,client=this.client;
        await client.writeCards(groupId,ids,"red");
        if(!this.running||epoch!==this.epoch)return;
        const version=this.versions[groupId]=(this.versions[groupId]||0)+1;
        const snapshot=await client.readGroup(groupId);
        if(!this.running||epoch!==this.epoch)return;
        if(this.versions[groupId]!==version)return ids.length;
        this.account.cache[groupId]=snapshot;this.save();this.apply();this.nextSync=0;
        return ids.length;
    }
    async operation(fn) {
        try {
            if (!this.running || !this.account) throw new Error("Включите плагин и войдите в Discord");
            await fn();
        } catch (error) { this.error(error); }
    }
    async setCard(groupId, uid, type) {
        const epoch = this.epoch, client = this.client;
        if (!client?.session) throw new Error("Сначала войдите в Firebase");
        await client.card(groupId, uid, type);
        if (!this.running || epoch !== this.epoch) return;
        const version = this.versions[groupId] = (this.versions[groupId] || 0) + 1;
        // The acknowledged write is authoritative even if a previous poll is still in flight.
        const snapshot = await client.readGroup(groupId);
        if (!this.running || epoch !== this.epoch) return;
        if (this.versions[groupId] !== version) return;
        this.account.cache[groupId] = snapshot;
        this.save(); this.apply(); this.nextSync = 0;
        BdApi.UI.showToast(type ? "Карточка сохранена" : "Ваша карточка отозвана", { type: "success" });
    }
    override(uid, value) {
        if (!snowflake(uid)) throw new Error("Неверный Discord ID");
        if (value) this.account.overrides[uid] = value;
        else delete this.account.overrides[uid];
        this.save(); this.apply();
    }
    patchMenu(tree, props) {
        const uid = props?.user?.id;
        if (!this.account || !snowflake(uid) || uid === this.accountId || !tree?.props) return;
        const items = [
            { id: "rfam-allow", label: "Всегда разрешать лично мне", action: () => this.override(uid, "allow") },
            { id: "rfam-mute", label: "Всегда мутить лично мне", action: () => this.override(uid, "mute") },
            { id: "rfam-follow", label: "Следовать правилам групп", action: () => this.override(uid, null) }
        ];
        for (const group of this.account.groups.filter(g => g.enabled)) {
            items.push({ id: `rfam-group-${group.id}`, type: "submenu", label: group.name, items: [
                { id: "rfam-red", label: this.flagLabel("Красная карточка", "#ed4245"), action: () => this.operation(() => this.setCard(group.id, uid, "red")) },
                { id: "rfam-yellow", label: this.flagLabel("Жёлтая карточка", "#fee75c"), action: () => this.operation(() => this.setCard(group.id, uid, "yellow")) },
                { id: "rfam-revoke", label: "Отозвать мою карточку", action: () => this.operation(() => this.setCard(group.id, uid, null)) }
            ] });
        }
        const children = BdApi.React.Children.toArray(tree.props.children);
        children.push(BdApi.ContextMenu.buildItem({ type: "submenu", label: "Redflag", items }));
        tree.props.children = children;
    }
    flagIcon(color) {
        return BdApi.React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", "aria-hidden": true },
            BdApi.React.createElement("path", { d: "M5 22V3M5 4C10 0 15 8 21 3V14C15 19 10 11 5 15", fill: color, stroke: color, strokeWidth: 2, strokeLinejoin: "round" }));
    }
    flagLabel(text, color) {
        return BdApi.React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 8 } }, this.flagIcon(color), text);
    }
    stop() {
        try { this.runtimeHealth?.pulse("stopped"); } catch {}
        this.runtimeHealth = null;
        this.running = false;
        this.realtime?.close(); this.realtime = null;
        this.epoch++;
        clearInterval(this.timer);
        clearTimeout(this.voiceApplyTimer); this.voiceApplyTimer = null;
        for (const { store, listener } of this.voiceWatchers || []) store.removeChangeListener(listener);
        this.voiceWatchers = [];
        for (const unpatch of this.unpatches || []) unpatch();
        if (BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id === this.accountId) {
            try { this.controller?.reconcile(new Set()); } catch (error) { this.error(error); }
            try { this.video?.reconcile(new Set()); } catch (error) { this.error(error); }
        }
        this.highlights?.stop(); BdApi.DOM?.removeStyle(NAME);
        this.video = null; this.notes = null;
        this.accountId = null;
        this.controller = null;
        this.client = null;
    }
    getSettingsPanel() {
        // Discord's settings dialog traps focus outside BetterDiscord's modal.
        // Close that underlying dialog before showing the plugin settings.
        const settingsActions = BdApi.Webpack.getByKeys("openUserSettings", "USER_SETTINGS_MODAL_KEY");
        const modalModule = BdApi.Webpack.getModule(m => m && Object.values(m).some(fn => typeof fn === "function" && String(fn).includes("?.stackNextByDefault")));
        const closeModal = BdApi.Webpack.getByKeys("openModal", "closeModal")?.closeModal || Object.values(modalModule || {}).find(fn => typeof fn === "function" && String(fn).includes(".setState") && String(fn).includes(".getState()["));
        const settingsKey = settingsActions?.USER_SETTINGS_MODAL_KEY || Array.from(modalModule?.getOpenModalKeys?.() || []).find(key => /USER_SETTINGS/i.test(key)) || "USER_SETTINGS_MODAL_MODAL_KEY";
        if (document.querySelector('[role="dialog"]')) {
            closeModal?.(settingsKey);
        }
        return settingsPanel(this, parseInvite);
    }
    configure(config) {
        const next = validateConfig(config);
        if (next.apiKey === this.config.apiKey && next.databaseURL === this.config.databaseURL) return;
        this.config = next;
        BdApi.Data.save(NAME, "config", this.config);
        this.epoch++;
        this.account.groups = []; this.account.cache = {};
        this.save(); this.makeClient(); this.apply();
        this.status = "Firebase настроен";
    }
};

module.exports.parseInvite = parseInvite;

},
"../firebase.public.json": module => { module.exports = {"apiKey":"","databaseURL":""}; }};
const cache = {};
function load(id) {
if (!modules[id]) return require(id);
if (!cache[id]) { const m = cache[id] = { exports: {} }; modules[id](m, m.exports, load); }
return cache[id].exports;
}
return load("./plugin.cjs");
})();
