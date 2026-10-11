'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),stage=path.join(root,'dist','release-package');
const files=['README.md','package.json','firebase.public.json','firebase.json','.gitignore','.gitattributes','Install.cmd','install.ps1','dist/RedflagAutoMute.plugin.js'];
for(const dir of ['src','scripts','test','firebase','docs']) {
  const walk=p=>{for(const e of fs.readdirSync(path.join(root,p),{withFileTypes:true})){const f=`${p}/${e.name}`;if(e.isDirectory())walk(f);else files.push(f);}};walk(dir);
}
const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'dist/RedflagAutoMute.plugin.js'))).digest('hex');
fs.writeFileSync(path.join(root,'SHA256SUMS.txt'),`${hash}  dist/RedflagAutoMute.plugin.js\n`);files.push('SHA256SUMS.txt');
if(path.dirname(stage)!==path.join(root,'dist'))throw Error('Invalid staging path');
fs.rmSync(stage,{recursive:true,force:true});
for(const f of files){const to=path.join(stage,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(root,f),to);}
if(process.platform!=='win32')throw Error('ZIP packaging requires PowerShell on Windows; staging directory is ready.');
const quote=s=>"'"+s.replace(/'/g,"''")+"'";
const zip=path.join(root,'dist/RedflagAutoMute-2.0.1.zip');
// PowerShell 7's inherited module path can hide Windows PowerShell 5 modules.
const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
const r=spawnSync('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; Compress-Archive -Path ${quote(stage+'/*')} -DestinationPath ${quote(zip)} -Force`],{stdio:'inherit',env});
if(r.status!==0)throw Error('ZIP creation failed');console.log('Packaged '+files.length+' public files: '+zip);
