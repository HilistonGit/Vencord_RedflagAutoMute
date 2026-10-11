"use strict";
// Only synthetic accounts and disposable groups. Does not read personal Discord lists.
const fs=require("node:fs"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {FirebaseClient}=require("../src/firebase.cjs"),{transport}=require("../src/transport.cjs");
async function main(){
    if(process.argv[2]!=="--run")throw Error("Explicit --run required");
    const file=__dirname+"/../cloud-smoke.local.json",saved=JSON.parse(fs.readFileSync(file,"utf8"));
    const persist=()=>fs.writeFileSync(file,JSON.stringify(saved,null,2));
    const c=new FirebaseClient(saved.config,transport,saved.users.owner,s=>{saved.users.owner=s;persist();});
    const denied=fn=>assert.rejects(fn,e=>[401,403].includes(e.status));
    saved.quotaGroups||=[];persist();
    // Remove only test groups retained by an interrupted run.
    for(const id of [...saved.quotaGroups]){try{await c.deleteGroup(id);}catch(e){if(![401,403].includes(e.status))throw e;}}
    saved.quotaGroups=[];persist();
    try {
        const owned=await c.listGroups();
        const ownedSlots=await c.request(`ownerSlots/${c.session.uid}`)||{};
        for(let n=Object.keys(ownedSlots).length;n<5;n++){const id=await c.createGroup("QA disposable quota "+n);saved.quotaGroups.push(id);persist();}
        assert.ok(saved.quotaGroups.length);
        await assert.rejects(c.createGroup("QA sixth forbidden"),/5/);
        const id=saved.quotaGroups[0],uid=c.session.uid;
        const forged=crypto.randomBytes(24).toString("hex");
        const body={name:"QA forged",owner:uid,ownerSlot:"g5",createdAt:{".sv":"timestamp"},inviteSecret:crypto.randomBytes(24).toString("hex"),members:{[uid]:"owner"}};
        await denied(()=>c.request("","PATCH",{[`groups/${forged}`]:body,[`ownerSlots/${uid}/g5`]:forged}));
        delete body.ownerSlot;await denied(()=>c.request(`groups/${forged}`,"PUT",body));
        const slots=await c.request(`ownerSlots/${uid}`),[occupied,oldId]=Object.entries(slots)[0];
        await denied(()=>c.request(`ownerSlots/${uid}/${occupied}`,"DELETE"));
        body.ownerSlot=occupied;await denied(()=>c.request("","PATCH",{[`groups/${forged}`]:body,[`ownerSlots/${uid}/${occupied}`]:forged}));
        console.log("PASS: backend rejects sixth group, omitted quota and stolen/deleted owner slot.");
        const ids=Array.from({length:5000},(_,n)=>(111111111111111111n+BigInt(n)).toString());
        await c.writeCards(id,ids,"red");
        assert.equal(Object.keys((await c.readGroup(id)).cards).length,5000);
        const extra="999999999999999999",vote={type:"red",updatedAt:{".sv":"timestamp"}};
        await denied(()=>c.request(`groups/${id}/cards/${extra}/${uid}`,"PUT",vote));
        await denied(()=>c.request(`groups/${id}`,"PATCH",{[`cards/${extra}/${uid}`]:vote,[`targetSlots/${extra}`]:"s5000","slots/s5000":extra}));
        await denied(()=>c.request(`groups/${id}`,"PATCH",{[`cards/${extra}/${uid}`]:vote,[`targetSlots/${extra}`]:"s0000","slots/s0000":extra}));
        await denied(()=>c.request(`groups/${id}/slots/s0000`,"DELETE"));
        await denied(()=>c.request(`groups/${id}/targetSlots/${ids[0]}`,"DELETE"));
        await c.card(id,ids[0],null);await c.card(id,extra,"red");
        assert.equal(Object.keys((await c.readGroup(id)).cards).length,5000);
        console.log("PASS: 5000 imported; backend rejects 5001st, quota omission, invalid/reused slot and slot deletion; revoke frees capacity.");
        assert.ok(owned.length>=1);
    } finally {
        for(const id of [...saved.quotaGroups]){await c.deleteGroup(id);saved.quotaGroups=saved.quotaGroups.filter(g=>g!==id);persist();}
    }
    console.log("PASS: disposable quota groups removed.");
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
