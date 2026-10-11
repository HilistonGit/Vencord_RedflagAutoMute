"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["README.md", "package.json", "firebase.public.json", "firebase.json", ".gitignore", ".gitattributes", "Install.cmd", "install.ps1", "dist/RedflagAutoMute.plugin.js"];
function walk(dir) {for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const file=`${dir}/${item.name}`;if(item.isDirectory())walk(file);else files.push(file);}}
for (const dir of ["src", "scripts", "test", "firebase", "docs"]) walk(dir);
const forbidden = [];
function collect(value, key = "") {
    if (typeof value === "string" && value.length > 12 && /token|password|secret|apiKey|databaseURL/i.test(key)) forbidden.push(value);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, k);
}
for (const file of fs.readdirSync(root).filter(f => f.endsWith(".local.json"))) collect(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
const issues = [];
for (const file of files) {
    const body = fs.readFileSync(path.join(root, file), "utf8");
    if (forbidden.some(secret => body.includes(secret))) issues.push(`${file}: contains local configuration or credential`);
    if (/AIza[0-9A-Za-z_-]{35}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(body)) issues.push(`${file}: credential pattern`);
}
if (issues.length) { console.error(issues.join("\n")); process.exitCode = 1; }
else console.log(`PASS: ${files.length} release files checked; no embedded project config, known local credentials, JWTs or private keys.`);
