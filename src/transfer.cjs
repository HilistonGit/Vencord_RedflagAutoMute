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
