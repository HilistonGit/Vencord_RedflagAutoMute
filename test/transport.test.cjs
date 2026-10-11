"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transport } = require("../src/transport.cjs");

test("BetterDiscord transport uses native fetch with body, status and redirect protection", async () => {
    globalThis.BdApi = { Net: { fetch: async (url, init) => {
        assert.equal(url, "https://example.test/auth");
        assert.equal(init.method, "POST");
        assert.equal(init.body, "{}");
        assert.equal(init.redirect, "error");
        assert.equal(init.maxRedirects, 0);
        assert.equal(init.timeout, 15000);
        assert.ok(init.signal instanceof AbortSignal);
        return new Response('{"error":"denied"}', { status: 403 });
    } } };
    try {
        const result = await transport("https://example.test/auth", { method: "POST", body: "{}" });
        assert.equal(result.status, 403);
        assert.deepEqual(await result.json(), { error: "denied" });
    } finally { delete globalThis.BdApi; }
});

test("BetterDiscord transport rejects oversized responses and network failures", async () => {
    globalThis.BdApi = { Net: { fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) } };
    try {
        await assert.rejects(transport("https://example.test/"), /8 МБ/);
        BdApi.Net.fetch = async () => { throw new Error("offline"); };
        await assert.rejects(transport("https://example.test/"), /offline/);
    } finally { delete globalThis.BdApi; }
});
