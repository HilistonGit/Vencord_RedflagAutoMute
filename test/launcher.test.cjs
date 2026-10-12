const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('maintenance launcher uses GUI subsystem and preserves PowerShell exit status',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rfam-launcher-'));
 try {
  fs.copyFileSync(path.join(__dirname,'../scripts/maintenance-launcher.cs'),path.join(dir,'launcher.cs'));
  fs.writeFileSync(path.join(dir,'maintenance.ps1'),'exit 23');
  fs.writeFileSync(path.join(dir,'build.ps1'),"$ErrorActionPreference='Stop'\nAdd-Type -Path (Join-Path $PSScriptRoot 'launcher.cs') -OutputAssembly (Join-Path $PSScriptRoot 'launcher.exe') -OutputType WindowsApplication");
  const build=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dir,'build.ps1')],{encoding:'utf8',windowsHide:true});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const exe=path.join(dir,'launcher.exe'),bytes=fs.readFileSync(exe),pe=bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(pe+24+68),2,'Windows GUI subsystem, not console');
  const run=spawnSync(exe,[],{windowsHide:true,timeout:15000});assert.equal(run.status,23,run.error?.message);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
