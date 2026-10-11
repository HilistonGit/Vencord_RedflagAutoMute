const {test}=require("node:test");
const assert=require("node:assert/strict");
const {allocateTargets,parseImport,exportList,discordMutes,makeInvite}=require("../src/transfer.cjs");
const {parseInvite}=require("../src/plugin.cjs");
const A="111111111111111111",B="222222222222222222";
test("import keeps exact snowflakes, rejects numeric JSON and deduplicates",()=>{
    assert.deepEqual(parseImport(`${A}\n${B}\n${A}`),[A,B]);
    assert.deepEqual(parseImport(exportList([A,B],"test")),[A,B]);
    for(const data of ['[111111111111111111]','{"userIds":["../evil"]}','[]','name','{bad'])assert.throws(()=>parseImport(data));
});
test("target slots have a hard boundary and reuse existing reservations",()=>{
    const ids=Array.from({length:5000},(_,i)=>(111111111111111111n+BigInt(i)).toString());
    const allocation=allocateTargets({},ids);
    assert.equal(Object.keys(allocation.slots).length,5000);
    const group={slots:allocation.slots,targetSlots:allocation.targets};
    assert.deepEqual(allocateTargets(group,[ids[0]]).changes,{});
    assert.throws(()=>allocateTargets(group,[B]),/5000/);
    delete group.slots.s0000;delete group.targetSlots[ids[0]];
    assert.equal(allocateTargets(group,[B]).targets[B],"s0000");
});
test("export enumerates persisted mutes instead of cached user or voice lists",()=>{
    const store={getState:()=>({settingsByContext:{default:{localMutes:{[A]:true,[B]:false}},stream:{localMutes:{[B]:true}}}}),isLocalMute:id=>id===A};
    assert.deepEqual(discordMutes(store),[A]);assert.deepEqual(discordMutes(store,A),[]);
    assert.throws(()=>discordMutes({getState:()=>({})}),/недоступен/);
});
test("invite encoding works with a Buffer that has no base64url encoding",()=>{
    const original=global.Buffer;
    global.Buffer={from:data=>({toString:encoding=>{assert.equal(encoding,"base64");return original.from(data).toString(encoding);}})};
    let invite;const config={apiKey:"fake-api-key-for-unit-tests",databaseURL:"https://demo-test.firebaseio.com"};
    try{invite=makeInvite(config,"a".repeat(48),"b".repeat(48));}finally{global.Buffer=original;}
    assert.equal(parseInvite(invite).code,`${"a".repeat(48)}.${"b".repeat(48)}`);
    assert.ok(!/[+=/]/.test(invite));
});
test("expanded export merges zero volume and blocks without duplicates or stream-only mutes",()=>{
    const {discordExport}=require("../src/transfer.cjs");
    const C="333333333333333333",SELF="444444444444444444",STREAM="555555555555555555";
    const store={getState:()=>({settingsByContext:{default:{localMutes:{[A]:true},localVolumes:{[A]:0,[B]:0,[SELF]:0}},stream:{localMutes:{[STREAM]:true},localVolumes:{[STREAM]:0}}}}),isLocalMute:id=>id===A,getLocalVolume:id=>[A,B,SELF].includes(id)?0:100};
    const relationships={getBlockedIDs:()=>[B,C,SELF,C]};
    assert.deepEqual(discordExport(store,SELF,relationships).ids,[A]);
    const result=discordExport(store,SELF,relationships,{includeZeroVolume:true,includeBlocked:true});
    assert.deepEqual(result.ids,[A,B,C]);assert.deepEqual(result.counts,{muted:1,zero:2,blocked:2});
    assert.throws(()=>discordExport(store,SELF,{}, {includeBlocked:true}),/блокировок/);
});
test("database invite configures project without group access or personal credentials",()=>{
    const {makeDatabaseInvite}=require("../src/transfer.cjs");
    const config={apiKey:"fake-api-key-for-unit-tests",databaseURL:"https://demo-test.firebaseio.com",password:"private-password",idToken:"private-token",code:"private-group-code"};
    const invite=makeDatabaseInvite(config);
    assert.deepEqual(parseInvite(invite),{apiKey:config.apiKey,databaseURL:config.databaseURL});
    const decoded=JSON.parse(Buffer.from(invite.slice(6),"base64").toString());
    assert.deepEqual(Object.keys(decoded).sort(),["apiKey","databaseURL"]);
    const group=JSON.parse(Buffer.from(makeInvite(config,"a".repeat(48),"b".repeat(48)).slice(6),"base64").toString());
    assert.deepEqual(Object.keys(group).sort(),["apiKey","code","databaseURL"]);
    assert.throws(()=>parseInvite("rfdb1.not-json"));
});
