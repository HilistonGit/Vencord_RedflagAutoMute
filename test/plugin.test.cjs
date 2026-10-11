const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Plugin = require("../src/plugin.cjs");
const { MuteController } = require("../src/core.cjs");
const SELF = "333333333333333333", A = "111111111111111111";
let currentId, muted, voiceMembers, voiceChannel;
beforeEach(() => {
    currentId = SELF; muted = new Set();
    voiceMembers = { [A]: {} }; voiceChannel = "channel";
    global.BdApi = {
        Data: { save() {}, load() {} }, UI: { showToast() {} },
        Webpack: { getStore: name => name === "SelectedChannelStore" ? {getVoiceChannelId:()=>voiceChannel} : name === "VoiceStateStore" ? {getVoiceStatesForChannel:()=>voiceMembers} : ({ getCurrentUser: () => ({ id: currentId }) }) }
    };
});
function setup(readGroup) {
    const p = new Plugin(); p.running = true; p.epoch = 1; p.versions = {}; p.accountId = SELF;
    p.account = { groups: [{ id: "group", name: "Friends", enabled: true }], overrides: {}, cache: {} };
    p.accounts = { [SELF]: p.account };
    p.client = { session: { uid: "alice" }, readGroup, listGroups: async()=>p.account.groups.map(g=>g.id), forgetGroup: async()=>{} };
    p.controller = new MuteController({ isMuted: id => muted.has(id), toggle: id => muted.has(id) ? muted.delete(id) : muted.add(id) });
    return p;
}
const snapshot = () => ({ members: { alice: "owner" }, cards: { [A]: { alice: { type: "red" } } } });
test("voice scope applies large database only to present users and preserves manual mutes",async()=>{
    const data=snapshot();
    for(let i=0;i<1000;i++)data.cards[String(555555555555555555n+BigInt(i))]={alice:{type:"red"}};
    const p=setup(async()=>data);await p.sync();assert.deepEqual([...muted],[A]);
    voiceMembers={};p.apply();assert.equal(muted.size,0);
    voiceMembers={[A]:{}};p.apply();assert.ok(muted.has(A));
    muted.delete(A);p.apply();assert.ok(muted.has(A));
    voiceChannel=null;p.apply();assert.equal(muted.size,0);
    muted.add(A);voiceChannel="channel";p.apply();voiceMembers={};p.apply();assert.ok(muted.has(A));
});
test("voice events reapply after dispatch and listeners are removed on stop",async()=>{
    const p=setup(async()=>snapshot());await p.sync();
    const listeners=new Set();const original=BdApi.Webpack.getStore;
    const store={getVoiceStatesForChannel:()=>voiceMembers,addChangeListener:fn=>listeners.add(fn),removeChangeListener:fn=>listeners.delete(fn)};
    BdApi.Webpack.getStore=name=>name==="VoiceStateStore"?store:original(name);
    p.setupVoiceWatchers();p.setupVoiceWatchers();assert.equal(listeners.size,1);
    muted.delete(A);for(const fn of listeners)fn();assert.equal(muted.size,0);
    await new Promise(r=>setTimeout(r,10));assert.ok(muted.has(A));
    for(const fn of listeners)fn();p.stop();assert.equal(listeners.size,0);
    await new Promise(r=>setTimeout(r,10));assert.equal(muted.size,0);
});
test("missing voice API never falls back to muting every database record",async()=>{
    const p=setup(async()=>snapshot());
    const original=BdApi.Webpack.getStore;
    BdApi.Webpack.getStore=name=>name==="VoiceStateStore"?{}:original(name);
    await p.sync();assert.equal(muted.size,0);
});
test("initial sync mutes, empty snapshot unmutes, without timestamp cursor", async () => {
    let data = snapshot(); const p = setup(async () => data);
    await p.sync(); assert.ok(muted.has(A));
    data = { members: { alice: "owner" } };
    await p.sync(); assert.equal(muted.size, 0);
});
test("offline preserves cache, permission revoked clears cache and owned mutes", async () => {
    let fail; const p = setup(async () => { if (fail) throw fail; return snapshot(); });
    await p.sync(); fail = new Error("offline"); await p.sync(); assert.ok(muted.has(A));
    fail.status = 401; await p.sync(); assert.equal(muted.size, 0); assert.equal(p.account.cache.group, undefined);
});
test("late response after stop cannot reapply mute or cache", async () => {
    let resolve; const p = setup(() => new Promise(r => { resolve = r; }));
    const pending = p.sync(); await new Promise(r=>setImmediate(r)); p.stop(); resolve(snapshot()); await pending;
    assert.equal(muted.size, 0); assert.equal(p.account.cache.group, undefined);
});
test("Discord account switch blocks old account mute application", () => {
    const p = setup(async () => snapshot()); p.account.cache.group = snapshot();
    currentId = "444444444444444444"; p.apply(); assert.equal(muted.size, 0);
});
test("new acknowledged write wins against an older in-flight poll", async () => {
    let resolve; let reads = 0;
    const p = setup(() => ++reads === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(snapshot()));
    p.client.card = async () => {};
    const pending = p.sync();
    await new Promise(r=>setImmediate(r));
    await p.setCard("group", A, "red");
    resolve({ members: { alice: "owner" } }); await pending;
    assert.ok(muted.has(A)); assert.ok(p.account.cache.group.cards[A]);
});
test("fresh device discovers groups; remote removal releases cached mute",async()=>{
    const p=setup(async()=>snapshot());p.account.groups=[];
    p.client.listGroups=async()=>["remote"];
    await p.sync();assert.equal(p.account.groups[0].id,"remote");assert.ok(muted.has(A));
    p.client.listGroups=async()=>[];await p.sync();assert.deepEqual(p.account.groups,[]);assert.equal(muted.size,0);
});
test("late group snapshot cannot resurrect a locally deleted group",async()=>{
    let resolve;const p=setup(()=>new Promise(r=>resolve=r));p.client.deleteGroup=async()=>{};
    const pending=p.sync();await new Promise(r=>setImmediate(r));
    await p.deleteGroup("group");resolve(snapshot());await pending;
    assert.deepEqual(p.account.groups,[]);assert.equal(p.account.cache.group,undefined);assert.equal(muted.size,0);
});
test("disabled groups do not apply cards; personal allow releases plugin's mute", async () => {
    const p = setup(async () => snapshot()); await p.sync();
    p.override(A, "allow"); assert.equal(muted.size, 0);
    p.override(A, null); assert.ok(muted.has(A));
    p.account.groups[0].enabled = false; p.apply(); assert.equal(muted.size, 0);
});
test("changing Firebase project clears the previous project's identity and group cache", () => {
    const p = setup(async () => snapshot());
    p.account.project = "https://old.firebaseio.com";
    p.account.session = { uid: "old-user", idToken: "old-token" };
    p.account.cache.group = snapshot();
    p.config = { databaseURL: "https://new.firebaseio.com", apiKey: "fake-api-key-for-unit-tests" };
    p.makeClient();
    assert.equal(p.client.session, null);
    assert.deepEqual(p.account.groups, []); assert.deepEqual(p.account.cache, {});
});
test('healthy events suppress polling; failed stream enables scheduled fallback',()=>{
 const p=setup(async()=>snapshot());let polls=0;let healthy=true;
 p.setupFeatures=()=>{};p.setupVoiceWatchers=()=>{};p.setupRealtime=()=>{};
 p.realtime={healthy:()=>healthy};p.sync=()=>{polls++;};p.nextSync=0;
 p.tick();assert.equal(polls,0);healthy=false;p.tick();assert.equal(polls,1);
 p.nextSync=Date.now()+5000;p.tick();assert.equal(polls,1);
});
test('event snapshot wins against a slower fallback HTTP response',async()=>{
 let resolve;const p=setup(()=>new Promise(r=>resolve=r));
 const pending=p.sync();await new Promise(setImmediate);
 p.versions.group=1;p.account.cache.group=snapshot();p.apply();
 resolve({members:{alice:'owner'}});await pending;
 assert.ok(muted.has(A));assert.ok(p.account.cache.group.cards[A]);
});
