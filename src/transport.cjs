"use strict";

// BetterDiscord exposes a native fetch bridge; its HTTPS polyfill has no request().
// Node HTTPS remains available for the standalone cloud test runner.
function transport(url, options = {}) {
    if (globalThis.BdApi?.Net?.fetch) return nativeTransport(url, options);
    return new Promise((resolve, reject) => {
        const req = require("https").request(url, { method: options.method || "GET", headers: options.headers }, res => {
            let size = 0;
            const chunks = [];
            res.on("data", chunk => {
                size += chunk.length;
                if (size > 8 * 1024 * 1024) req.destroy(new Error("Ответ Firebase превышает 8 МБ"));
                else chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({ status: res.statusCode, json: async () => JSON.parse(text) });
            });
        });
        const deadline = setTimeout(() => req.destroy(new Error("Firebase: время ожидания истекло")), 15000);
        req.on("close", () => clearTimeout(deadline));
        req.on("error", reject);
        if (options.body !== undefined) req.write(options.body);
        req.end();
    });
}

async function nativeTransport(url, options) {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new Error("Firebase: время ожидания истекло")), 15000);
    try {
        const response = await BdApi.Net.fetch(url, { ...options, redirect: "error", maxRedirects: 0, timeout: 15000, signal: abort.signal });
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8 * 1024 * 1024) {
                abort.abort();
                await reader.cancel();
                throw new Error("Ответ Firebase превышает 8 МБ");
            }
            chunks.push(Buffer.from(value));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        return { status: response.status, json: async () => JSON.parse(body) };
    } finally { clearTimeout(deadline); }
}

module.exports = { transport };
