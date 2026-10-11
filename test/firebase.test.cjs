const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FirebaseClient, validateConfig } = require("../src/firebase.cjs");
const { parseInvite } = require("../src/plugin.cjs");
const config = { apiKey: "fake-api-key-for-unit-tests", databaseURL: "https://demo-test-default-rtdb.europe-west1.firebasedatabase.app" };
const session = () => ({ uid: "alice", idToken: "test-id-token", refreshToken: "test-refresh", expiresAt: Date.now() + 3600000 });
const response = (data, status = 200) => ({ status, json: async () => data });
test("only official HTTPS database origins accepted", () => {
    assert.equal(validateConfig(config).databaseURL, config.databaseURL);
    for (const url of ["http://test.firebaseio.com", "https://evil.example", "https://test.firebaseio.com.evil.example", "https://x@y.firebaseio.com", "https://x.firebaseio.com/path", "https://x.firebaseio.com/?q=1"]) {
        assert.throws(() => validateConfig({ ...config, databaseURL: url }));
    }
});
test("invitation includes public config and random group capability, never user token", () => {
    const data = { ...config, code: `${"a".repeat(48)}.${"b".repeat(48)}` };
    const code = "rfam1." + Buffer.from(JSON.stringify(data)).toString("base64url");
    assert.deepEqual(parseInvite(code), data);
    assert.throws(() => parseInvite("rfam1.invalid"));
});
test("password login stores Firebase ID and refresh tokens", async () => {
    let saved;
    const c = new FirebaseClient(config, async (url, options) => {
        assert.match(url, /accounts:signInWithPassword/);
        assert.equal(JSON.parse(options.body).password, "password");
        return response({ localId: "alice", idToken: "id", refreshToken: "refresh", expiresIn: "3600" });
    }, null, value => { saved = value; });
    await c.signIn("a@example.test", "password");
    assert.equal(saved.uid, "alice"); assert.equal(saved.refreshToken, "refresh"); assert.equal(saved.password, undefined);
});
test("concurrent expired requests share a refresh, use ID token not API key", async () => {
    let refreshes = 0, writes = 0;
    const c = new FirebaseClient(config, async (url, options) => {
        if (url.includes("securetoken")) {
            refreshes++;
            await new Promise(r => setImmediate(r));
            assert.match(options.body, /grant_type=refresh_token/);
            return response({ user_id: "alice", id_token: "new-token", refresh_token: "new-refresh", expires_in: "3600" });
        }
        assert.match(url, /auth=new-token$/); writes++; return response(null);
    }, { ...session(), expiresAt: 0 });
    await Promise.all([c.readGroup("one"), c.readGroup("two")]);
    assert.equal(refreshes, 1); assert.equal(writes, 2);
});
test("writes are scoped to authenticated author's vote; deletes propagate", async () => {
    const calls = [];
    const c = new FirebaseClient(config, async (url, options) => { calls.push({ url, ...options }); return response(null); }, session());
    c.readGroup=async()=>({members:{alice:"owner"},cards:{}});
    await c.card("group", "111111111111111111", "yellow");
    await c.card("group", "111111111111111111", null);
    assert.match(calls[0].url, /groups\/group.json/);
    assert.equal(JSON.parse(calls[0].body)["cards/111111111111111111/alice"].updatedAt[".sv"], "timestamp");
    assert.equal(JSON.parse(calls[1].body)["cards/111111111111111111/alice"], null);
    await assert.rejects(c.card("../escape", "111111111111111111", "red"));
});
test("create group includes owner membership and unpredictable invitation", async () => {
    let body;
    const c = new FirebaseClient(config, async (_, options) => { if(options.method==="GET")return response({}); body = JSON.parse(options.body); return response(null); }, session());
    c.listGroups=async()=>[];
    const id = await c.createGroup("Friends");
    assert.match(id, /^[a-f0-9]{48}$/); assert.equal(body[`groups/${id}`].members.alice, "owner");
    assert.match(body[`groups/${id}`].inviteSecret, /^[a-f0-9]{48}$/);
    assert.equal(body[`userGroups/alice/${id}`],true);
});
test("owner removal atomically rotates invitation", async () => {
    let request;
    const c = new FirebaseClient(config, async (_, options) => { request = options; return response(null); }, session());
    await c.removeMember("group", "bob", true);
    assert.equal(request.method, "PATCH");
    const body = JSON.parse(request.body);
    assert.equal(body["groups/group/members/bob"], null); assert.match(body["groups/group/inviteSecret"], /^[a-f0-9]{48}$/);
    assert.equal(body["userGroups/bob/group"],null);
});
test("Firebase rejection surfaces to caller instead of pretending success", async () => {
    const c = new FirebaseClient(config, async () => response({ error: "Permission denied" }, 401), session());
    await assert.rejects(c.readGroup("private"), e => e.status === 401 && /Permission/.test(e.message));
});
test("join capability writes self membership; existing owner can recover group", async () => {
    let calls = 0;
    const c = new FirebaseClient(config, async (_, options) => {
        calls++;
        if (calls === 1) return response({ error: "Permission denied" }, 401);
        assert.equal(options.method, "PATCH"); const body=JSON.parse(options.body); assert.equal(body[`groups/${"a".repeat(48)}/members/alice`], "b".repeat(48)); assert.equal(body[`userGroups/alice/${"a".repeat(48)}`],true); return response(null);
    }, session());
    const code = `${"a".repeat(48)}.${"b".repeat(48)}`;
    assert.equal(await c.joinGroup(code), "a".repeat(48)); assert.equal(calls, 2);
    const owner = new FirebaseClient(config, async () => response({ owner: "alice" }), session());
    assert.equal(await owner.joinGroup(code), "a".repeat(48));
});
test("discovery reads private index and migrates only accessible legacy groups", async()=>{
    const calls=[];
    const c=new FirebaseClient(config,async(url,options)=>{
        const path=new URL(url).pathname;calls.push({path,...options});
        if(path==="/userGroups/alice.json")return response({remote:true});
        if(path==="/groups/legacy.json")return response({members:{alice:"owner"}});
        if(path==="/groups/revoked.json")return response({error:"Permission denied"},401);
        return response(null);
    },session());
    assert.deepEqual(await c.listGroups(["legacy","revoked"]),["remote","legacy"]);
    assert.ok(calls.some(c=>c.path==="/userGroups/alice/legacy.json"&&c.method==="PUT"));
    assert.ok(!calls.some(c=>c.path==="/groups.json"));
});
test("owner deletion removes group and every member index atomically",async()=>{
    let changes;
    const c=new FirebaseClient(config,async(url,options)=>{
        if(options.method==="GET")return response({owner:"alice",members:{alice:"owner",bob:"member"}});
        assert.equal(options.method,"PATCH");changes=JSON.parse(options.body);return response(null);
    },session());
    await c.deleteGroup("group");
    assert.deepEqual(changes,{"groups/group":null,"userGroups/alice/group":null,"userGroups/bob/group":null});
    c.session.uid="bob";await assert.rejects(c.deleteGroup("group"),/владелец/);
});
test("overlapping imports merge authors, reuse slots and repeated import preserves timestamps",async()=>{
    const A="111111111111111111",B="222222222222222222";
    const group={members:{alice:"owner",bob:"member"},cards:{[A]:{bob:{type:"red",updatedAt:42}}},slots:{s0000:A},targetSlots:{[A]:"s0000"}};
    const c=new FirebaseClient(config,async()=>{throw Error("unexpected transport");},session());
    c.readGroup=async()=>structuredClone(group);
    let writes=0;
    c.request=async(path,method,changes)=>{
        assert.equal(method,"PATCH");writes++;
        for(const [path,value] of Object.entries(changes)) {
            const keys=path.split("/");let obj=group;
            for(const key of keys.slice(0,-1))obj=obj[key]||=( {} );
            obj[keys.at(-1)]=value?.updatedAt?{...value,updatedAt:99}:value;
        }
    };
    await c.writeCards("group",[A,A,B]);
    assert.equal(Object.keys(group.cards).length,2);assert.equal(Object.keys(group.slots).length,2);
    assert.deepEqual(group.cards[A].bob,{type:"red",updatedAt:42});assert.equal(group.cards[A].alice.updatedAt,99);
    await c.writeCards("group",[B,A]);assert.equal(writes,1);
    c.session.uid="bob";await c.writeCards("group",[A,B]);
    assert.equal(Object.keys(group.cards).length,2);assert.equal(Object.keys(group.slots).length,2);
    assert.equal(group.cards[A].bob.updatedAt,42);assert.equal(group.cards[B].alice.updatedAt,99);assert.equal(group.cards[B].bob.type,"red");
});
