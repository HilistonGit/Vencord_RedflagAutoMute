"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { VideoController, NoteController, editNote, databaseFlags, BAN_NOTE, WARN_NOTE } = require("../src/features.cjs");
const A = "111111111111111111", B = "222222222222222222";

test("video restores previous auto state and preserves pre-existing manual disable", () => {
    const states = { [A]: "AUTO_ENABLED", [B]: "DISABLED" };
    const video = new VideoController({ state: id => states[id], disabled: id => states[id] === "DISABLED", set: (id, state) => states[id] = state });
    video.reconcile(new Set([A, B])); assert.equal(states[A], "DISABLED"); assert.deepEqual(video.owned, { [A]: "AUTO_ENABLED" });
    video.reconcile(new Set()); assert.equal(states[A], "AUTO_ENABLED"); assert.equal(states[B], "DISABLED");
});
test("video cleanup does not override a subsequent manual enable", () => {
    let state = "NONE";
    const video = new VideoController({ state: () => state, disabled: () => state === "DISABLED", set: (_, next) => state = next });
    video.reconcile(new Set([A])); state = "MANUAL_ENABLED"; video.reconcile(new Set()); assert.equal(state, "MANUAL_ENABLED");
});
test("notes preserve existing text, replace only their suffix, and respect the length limit", () => {
    const original = "My personal note\nWith another line  ";
    const marked = editNote(original, null, BAN_NOTE).text;
    assert.equal(editNote(marked, BAN_NOTE, null).text, original);
    assert.equal(editNote(marked, BAN_NOTE, WARN_NOTE).text, `${original}\n${WARN_NOTE}`);
    assert.equal(editNote(marked, null, BAN_NOTE).text, marked);
    assert.equal(editNote("x".repeat(256), null, BAN_NOTE).skipped, true);
    assert.equal(editNote(`${BAN_NOTE}\nUser moved it`, BAN_NOTE, null).skipped, true);
});
test("notes use latest desired state after a delayed read; revocation preserves fresh user edits", async () => {
    let note = "personal", resolve;
    const notes = new NoteController({ read: () => new Promise(r => resolve = r), write: async (_, text) => note = text });
    const pending = notes.reconcile({[A]:BAN_NOTE}, 100);
    await notes.reconcile({}, 101); resolve(note); await pending;
    assert.equal(note, "personal");
    notes.adapter.read = async () => note;
    await notes.reconcile({[A]:BAN_NOTE}, 2200); assert.equal(note, `personal\n${BAN_NOTE}`);
    note = `personal edited\n${BAN_NOTE}`;
    await notes.reconcile({}, 4300); assert.equal(note, "personal edited"); assert.deepEqual(notes.owned, {});
});
test("failed note writes do not lose the previous marker or duplicate on retry", async () => {
    let note = `personal\n${WARN_NOTE}`, fail = true;
    const notes = new NoteController({read: async () => note, write: async (_, text) => {if(fail) throw new Error("offline"); note=text;}}, {[A]:WARN_NOTE});
    await notes.reconcile({[A]:BAN_NOTE}, 100); assert.equal(notes.owned[A], WARN_NOTE);
    fail = false; await notes.reconcile({[A]:BAN_NOTE}, 30200);
    assert.equal(note, `personal\n${BAN_NOTE}`);
});
test("account invalidation prevents note writes after a pending read", async () => {
    let valid = true, resolve, writes = 0;
    const notes = new NoteController({read: () => new Promise(r => resolve=r), write:async()=>writes++}, {}, ()=>{}, ()=>valid);
    const pending=notes.reconcile({[A]:BAN_NOTE}); valid=false; resolve(""); await pending; assert.equal(writes,0);
});
test("yellow votes are counted inside each group, database flags do not inherit personal mute", () => {
    const group = who => ({members:{[who]:true}, cards:{[A]:{[who]:{type:"yellow"}}}});
    let flags=databaseFlags([group("one"),group("two")], {overrides:{[B]:"mute"}});
    assert.equal(flags.blocked.size,0); assert.match(flags.notes[A], /Предупреждение/); assert.equal(flags.notes[B],undefined);
    flags=databaseFlags([group("one")], {includeYellow:true}); assert.ok(flags.blocked.has(A)); assert.match(flags.notes[A], /БАН/);
});
test("database note identifies the group and the vote that reaches the ban threshold", () => {
    const first=Date.UTC(2026,0,1), second=Date.UTC(2026,0,2), third=Date.UTC(2026,0,3);
    const group={id:"group-a",members:{one:true,two:true},cards:{[A]:{one:{type:"yellow",updatedAt:first},two:{type:"yellow",updatedAt:second},removed:{type:"red",updatedAt:first}}}};
    let flags=databaseFlags([group],{});
    assert.match(flags.notes[A],new RegExp(`ID: group-a/${A}`));
    assert.match(flags.notes[A],/Забанен: 2026-01-02 00:00 UTC/);
    const other={id:"group-b",members:{one:true},cards:{[A]:{one:{type:"red",updatedAt:third}}}};
    assert.equal(databaseFlags([other,group],{}).notes[A],flags.notes[A]);
    delete group.cards[A].two;
    assert.match(databaseFlags([group,other],{}).notes[A],/ID: group-b\//);
    assert.match(databaseFlags([group],{includeYellow:true}).notes[A],/Забанен: 2026-01-01/);
    assert.equal(databaseFlags([group],{},A).notes[A],undefined);
});
test('large note queues finish new records before rechecking old ones',async()=>{
 const ids=Array.from({length:255},(_,i)=>String(111111111111111111n+BigInt(i)));const writes=new Set();
 const desired=Object.fromEntries(ids.map(id=>[id,BAN_NOTE]));
 const notes=new NoteController({read:async()=>'',write:async id=>writes.add(id)});
 for(let i=0;i<260;i++)await notes.reconcile(desired,100+i*2000);
 assert.equal(writes.size,255);
});
test('new card takes priority over initial backlog and failed notes do not block others',async()=>{
 const reads=[];const notes=new NoteController({read:async id=>{reads.push(id);if(id===A)throw Error('unavailable');return '';},write:async()=>{}});
 await notes.reconcile({[A]:BAN_NOTE},100);
 await notes.reconcile({[A]:BAN_NOTE,[B]:BAN_NOTE},2200);
 assert.equal(reads.at(-1),B);assert.equal(notes.owned[B],BAN_NOTE);
});


test("highlights repair React hover class replacement and replaced tiles without a timer; stop disconnects", () => {
    const {Highlights}=require('../src/features.cjs');let observer, nodes=[];
    class Observer {
        constructor(callback){this.callback=callback;observer=this;this.active=false;}
        observe(){this.active=true;}
        disconnect(){this.active=false;}
        emit(record){if(this.active)this.callback([record]);}
    }
    const tile=id=>{const classes=new Set();return {id,getAttribute:()=>null,matches:()=>true,classList:{contains:c=>classes.has(c),add:c=>{assert.equal(observer.active,false,'self mutations observed');classes.add(c);},remove:c=>classes.delete(c)}}};
    const doc={body:{},defaultView:{MutationObserver:Observer},querySelectorAll:()=>nodes};
    const highlights=new Highlights({ReactUtils:{getInternalInstance:e=>({memoizedProps:{userId:e.id}})}},doc);
    const first=tile(A);nodes=[first];highlights.update(new Set([A]));assert.ok(first.classList.contains('rfam-blocked'));
    first.classList.remove('rfam-blocked');observer.emit({type:'attributes',target:first});assert.ok(first.classList.contains('rfam-blocked'));
    const replacement=tile(A);nodes=[replacement];observer.emit({type:'childList',target:doc.body});assert.ok(replacement.classList.contains('rfam-blocked'));assert.ok(!first.classList.contains('rfam-blocked'));
    replacement.id=B;observer.emit({type:'attributes',target:replacement});assert.ok(!replacement.classList.contains('rfam-blocked'));
    highlights.stop();assert.equal(observer.active,false);replacement.id=A;observer.emit({type:'childList',target:doc.body});assert.ok(!replacement.classList.contains('rfam-blocked'));
});
