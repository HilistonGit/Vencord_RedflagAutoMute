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
