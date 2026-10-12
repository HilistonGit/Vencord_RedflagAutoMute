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
