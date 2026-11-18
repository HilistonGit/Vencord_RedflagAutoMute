'use strict';
const EVENTS=new Set(['start','runtime','settings-request','settings-mounted','settings-not-mounted','settings-render','settings-action']);
const version=v=>/^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]{1,24})?$/.test(String(v))?String(v):'unknown';
class Diagnostics {
    constructor(api,clock=Date.now){this.api=api;this.clock=clock;this.entries=[];this.enabled=false;this.next=0;this.serial=0;this.status='Отправка выключена';
        try{const saved=api.Data.load('RedflagAutoMuteDiagnostics','events');if(Array.isArray(saved))this.entries=saved.slice(-20).filter(x=>x&&EVENTS.has(x.event)).map(x=>({event:x.event,kind:['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(x.kind)?x.kind:'none',frames:/^(?:[0-9]{1,7}:[0-9]{1,7}(?:,|$)){0,6}$/.test(x.frames)?x.frames:'',at:Number.isFinite(x.at)?x.at:0,plugin:version(x.plugin),betterdiscord:version(x.betterdiscord),react:version(x.react),discord:version(x.discord)}));}catch{}
        try{this.enabled=api.Data.load('RedflagAutoMuteDiagnostics','consent')===true;}catch{}
    }
    consent(value){this.enabled=!!value;this.api.Data.save('RedflagAutoMuteDiagnostics','consent',this.enabled);this.status=this.enabled?'Ожидание отправки':'Отправка выключена';}
    record(event,error){try{this.recordSafe(event,error);}catch{/* Diagnostics must never break the plugin. */}}
    recordSafe(event,error){
        if(!EVENTS.has(event))return;
        const kind=['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(error?.name)?error.name:'none';
        // Never persist messages, arbitrary stack text, URLs or user-provided values.
        const frames=[...String(error?.stack||'').matchAll(/RedflagAutoMute\.plugin\.js:(\d{1,7}):(\d{1,7})/g)].slice(0,6).map(m=>`${m[1]}:${m[2]}`).join(',');
        const item={event,kind,frames,at:this.clock(),plugin:'2.0.6',betterdiscord:version(this.api.version),react:version(this.api.React?.version),discord:version(globalThis.DiscordNative?.app?.getVersion?.())};
        const prev=this.entries[this.entries.length-1];
        if(prev&&prev.event===event&&prev.kind===kind&&prev.frames===frames&&item.at-prev.at<60000)return;
        this.entries.push(item);this.entries=this.entries.slice(-20);this.serial++;
        try{this.api.Data.save('RedflagAutoMuteDiagnostics','events',this.entries);}catch{}
    }
    async flush(client){
        if(!this.enabled||this.pending||!client?.session||!this.entries.length||this.clock()<this.next||(this.sent===this.serial&&this.destination===client.config?.databaseURL+':'+client.session.uid))return;
        this.next=this.clock()+60000;this.pending=true;
        const serial=this.serial,report={schema:1,updatedAt:{'.sv':'timestamp'},events:JSON.stringify(this.entries)};
        try{await client.request(`diagnostics/${client.session.uid}`,'PUT',report);this.sent=serial;this.destination=client.config?.databaseURL+':'+client.session.uid;this.status='Технический отчёт отправлен';}
        catch{this.status='Отчёт сохранён локально; проверьте сеть и правила Firebase';}
        finally{this.pending=false;}
    }
}
function guardedSettings(plugin,create){
    const api=globalThis.BdApi,R=api.React,h=R.createElement;
    const d=plugin.diagnostics ||= new Diagnostics(api);
    d.record('settings-request');
    let mounted=false;
    const timer=setTimeout(()=>{if(!mounted)d.record('settings-not-mounted');},5000);timer.unref?.();
    function Content(){R.useEffect(()=>{mounted=true;clearTimeout(timer);d.record('settings-mounted');},[]);return create();}
    class Boundary extends R.Component {
        constructor(props){super(props);this.state={failed:false};}
        static getDerivedStateFromError(){return {failed:true};}
        componentDidCatch(error){clearTimeout(timer);d.record('settings-render',error);}
        render(){return this.state.failed?h('div',{style:{padding:20}},h('h3',null,'Не удалось открыть настройки RedflagAutoMute'),h('p',null,'Техническая ошибка сохранена локально. Можно разрешить её автоматическую отправку владельцу базы после входа.'),h('button',{onClick:()=>{d.consent(!d.enabled);this.forceUpdate();}},d.enabled?'Отключить отправку отчётов':'Разрешить отправку отчётов'),h('p',null,d.status)):this.props.children;}
    }
    return h(Boundary,null,h(Content));
}
module.exports={Diagnostics,guardedSettings};
