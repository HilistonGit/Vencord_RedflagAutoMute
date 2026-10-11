const { test } = require("node:test");
const assert = require("node:assert/strict");
const { desiredMutes, summarize, MuteController } = require("../src/core.cjs");
const A = "111111111111111111", B = "222222222222222222", SELF = "333333333333333333";
const group = cards => ({ members: { alice: "owner", bob: "invite" }, cards });

test("distinct yellow votes escalate; removed members do not vote", () => {
    const g = group({ [A]: { alice: { type: "yellow" }, bob: { type: "yellow" } } });
    assert.equal(summarize(g)[A].type, "red");
    delete g.members.bob;
    assert.equal(summarize(g)[A].type, "yellow");
    assert.equal(desiredMutes([g]).size, 0);
    assert.deepEqual([...desiredMutes([g], { includeYellow: true })], [A]);
});
test("one red applies on initial snapshot; personal exceptions win across groups", () => {
    const g = group({ [A]: { alice: { type: "red" } }, [SELF]: { alice: { type: "red" } } });
    assert.deepEqual([...desiredMutes([g], {}, SELF)], [A]);
    assert.deepEqual([...desiredMutes([g, g], { overrides: { [A]: "allow", [B]: "mute" } }, SELF)], [B]);
});
test("invalid Discord IDs are ignored", () => {
    assert.equal(desiredMutes([group({ bad: { alice: { type: "red" } } })]).size, 0);
});
test("mute ownership persists; existing manual mutes and volume are untouched", () => {
    const actual = new Set([B]); let persisted;
    const calls = [];
    const adapter = { isMuted: id => actual.has(id), toggle: id => { calls.push(id); actual.has(id) ? actual.delete(id) : actual.add(id); } };
    const c = new MuteController(adapter, [], ids => { persisted = ids; });
    c.reconcile(new Set([A, B]));
    c.reconcile(new Set([A, B]));
    assert.deepEqual(calls, [A]); assert.deepEqual(persisted, [A]);
    new MuteController(adapter, persisted).reconcile(new Set());
    assert.deepEqual([...actual], [B]);
});
test("card removal unmutes owned users; manual unmute does not toggle them back on removal", () => {
    const actual = new Set([A]); const calls = [];
    const c = new MuteController({ isMuted: id => actual.has(id), toggle: id => { calls.push(id); actual.delete(id); } }, [A, B]);
    c.reconcile(new Set()); assert.deepEqual(calls, [A]); assert.equal(c.owned.size, 0);
});
test("failed mute is not recorded as owned", () => {
    const c = new MuteController({ isMuted: () => false, toggle: () => { throw Error("not ready"); } });
    assert.throws(() => c.reconcile(new Set([A]))); assert.equal(c.owned.size, 0);
});
