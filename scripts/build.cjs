"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["core", "transfer", "firebase", "transport", "realtime", "health", "features", "settings", "plugin"];
const publicConfig = JSON.parse(fs.readFileSync(path.join(root, "firebase.public.json"), "utf8"));
if (Object.values(publicConfig).some(Boolean)) throw new Error("Public builds must have empty Firebase configuration. Use firebase.local.json and plugin settings.");
const header = `/**
 * @name RedflagAutoMute
 * @author RedflagAutoMute contributors
 * @version 2.0.4
 * @description Муть токсичных людей вместе с друзьями.
 */\n`;
const modules = files.map(name => `${JSON.stringify(`./${name}.cjs`)}: (module, exports, require) => {\n${fs.readFileSync(path.join(root, "src", `${name}.cjs`), "utf8").replace(/\r\n/g, "\n")}\n}`).concat([
    `"../firebase.public.json": module => { module.exports = ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, "firebase.public.json"), "utf8")))}; }`
]).join(",\n");
const bundle = `${header}"use strict";\nmodule.exports = (() => {\nconst modules = {${modules}};\nconst cache = {};\nfunction load(id) {\nif (!modules[id]) return require(id);\nif (!cache[id]) { const m = cache[id] = { exports: {} }; modules[id](m, m.exports, load); }\nreturn cache[id].exports;\n}\nreturn load("./plugin.cjs");\n})();\n`;
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "RedflagAutoMute.plugin.js"), bundle);
console.log("Built dist/RedflagAutoMute.plugin.js");
