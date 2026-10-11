"use strict";
// Explicit opt-in: creates only synthetic test users/cards in the configured project.
// This is NOT part of npm test. Keep its local credentials out of version control.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { FirebaseClient } = require("../src/firebase.cjs");
const { transport } = require("../src/transport.cjs");
const { summarize } = require("../src/core.cjs");

async function main() {
    if (process.argv[2] !== "--run") throw Error("Use node scripts/cloud-smoke.cjs --run after configuring firebase.local.json");
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../firebase.local.json"), "utf8"));
    const localPath = path.join(__dirname, "../cloud-smoke.local.json");
    const saved = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, "utf8")) : { config, run: crypto.randomBytes(8).toString("hex"), users: {} };
    assert.deepEqual(saved.config, config, "Use a separate local test record when changing Firebase project");
    const persist = () => fs.writeFileSync(localPath, JSON.stringify(saved, null, 2));
    const clients = {};
    for (const name of ["owner", "member", "outsider"]) {
        const client = clients[name] = new FirebaseClient(config, transport, saved.users[name], session => { saved.users[name] = session; persist(); });
        if (!client.session) await client.signIn(`redflag-smoke-${saved.run}-${name}@example.com`, crypto.randomBytes(24).toString("hex"), true);
    }
    const { owner, member, outsider } = clients;
    if (!saved.group) { saved.group = await owner.createGroup(`QA smoke test ${saved.run}`); persist(); }
    const id = saved.group, target = "111111111111111111";
    const denied = async fn => assert.rejects(fn, e => [401, 403].includes(e.status));
    await denied(() => outsider.readGroup(id));
    await denied(() => outsider.request("groups"));
    await denied(() => outsider.card(id, target, "red"));
    const group = await owner.readGroup(id);
    const invite = `${id}.${group.inviteSecret}`;
    await member.joinGroup(invite);
    await owner.card(id, target, null); await member.card(id, target, null);
    await owner.card(id, target, "yellow");
    assert.equal(summarize(await member.readGroup(id))[target].type, "yellow");
    await member.card(id, target, "yellow");
    assert.equal(summarize(await owner.readGroup(id))[target].type, "red");
    await denied(() => member.request(`groups/${id}/cards/${target}/${owner.session.uid}`, "DELETE"));
    await denied(() => member.request(`groups/${id}/members/${owner.session.uid}`, "DELETE"));
    await denied(() => member.request(`groups/${id}/owner`, "PUT", member.session.uid));
    await owner.card(id, target, "red");
    await member.card(id, target, null);
    assert.equal(summarize(await member.readGroup(id))[target].type, "red");
    await owner.card(id, target, null);
    assert.equal(summarize(await member.readGroup(id))[target], undefined);
    await member.card(id, target, "red");
    await owner.removeMember(id, member.session.uid, true);
    await denied(() => member.readGroup(id));
    await denied(() => member.joinGroup(invite));
    assert.equal(summarize(await owner.readGroup(id))[target], undefined);
    const latest = await owner.readGroup(id);
    await member.joinGroup(`${id}.${latest.inviteSecret}`);
    await member.card(id, target, null);
    await member.removeMember(id, member.session.uid);
    assert.ok((await owner.listGroups([id])).includes(id), "legacy group migration");
    await denied(() => outsider.request(`userGroups/${owner.session.uid}`));
    await denied(() => outsider.indexGroup(id));
    if (!saved.discoveryGroup) { saved.discoveryGroup = await owner.createGroup("QA disposable discovery and deletion"); persist(); }
    const disposable = saved.discoveryGroup;
    const created = await owner.readGroup(disposable);
    await member.joinGroup(`${disposable}.${created.inviteSecret}`);
    const fresh = new FirebaseClient(config, transport, { ...member.session });
    assert.ok((await fresh.listGroups()).includes(disposable), "fresh device must discover membership without local IDs");
    await denied(() => member.request(`groups/${disposable}`, "DELETE"));
    await denied(() => outsider.request(`groups/${disposable}`, "DELETE"));
    await denied(() => outsider.request(`userGroups/${member.session.uid}/${disposable}`, "DELETE"));
    await owner.deleteGroup(disposable);
    assert.ok(!(await owner.listGroups()).includes(disposable));
    assert.ok(!(await fresh.listGroups()).includes(disposable));
    await denied(() => member.readGroup(disposable));
    delete saved.discoveryGroup; persist();
    assert.ok(!(await member.listGroups()).includes(id), "leaving removes membership index");
    console.log("PASS: private group index, legacy migration, fresh-device discovery, owner-only atomic deletion and index cleanup.");
    console.log("PASS: cloud auth, group isolation, own-vote writes, yellow escalation, revocation, invitation rotation and cleanup of cards.");
    console.log("Retained QA group and three synthetic Firebase accounts for reproducible tests. Credentials: cloud-smoke.local.json (gitignored).");
    fs.writeFileSync(path.join(__dirname, "../cloud-smoke-result.json"), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), projectDatabase: config.databaseURL, group: id }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
