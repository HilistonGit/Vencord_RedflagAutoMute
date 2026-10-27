const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
test('Windows installer preserves config, backs up plugin and rejects changed payload',{skip:process.platform!=='win32'},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rfam-installer-')),dist=path.join(temp,'dist'),plugins=path.join(temp,'BetterDiscord','plugins');
 fs.mkdirSync(dist);fs.mkdirSync(path.join(temp,'scripts'));for(const f of ['installer-core.ps1','installer-tui.ps1','recovery.ps1','plugin-update.ps1'])fs.copyFileSync(path.join(__dirname,'../scripts',f),path.join(temp,'scripts',f));fs.mkdirSync(plugins,{recursive:true});fs.copyFileSync(path.join(__dirname,'../install.ps1'),path.join(temp,'install.ps1'));
 const source='/** @name RedflagAutoMute */\nmodule.exports = {};';fs.writeFileSync(path.join(dist,'RedflagAutoMute.plugin.js'),source);
 fs.writeFileSync(path.join(temp,'SHA256SUMS.txt'),crypto.createHash('sha256').update(source).digest('hex')+'  dist/RedflagAutoMute.plugin.js\n');
 const config=path.join(plugins,'RedflagAutoMute.config.json');fs.writeFileSync(config,'{"keep":true}');fs.writeFileSync(path.join(plugins,'RedflagAutoMute.plugin.js'),'old');
 const run=()=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(temp,'install.ps1'),'-PluginDirectory',plugins,'-NonInteractive','-SkipBetterDiscord'],{encoding:'utf8'});
 try {
  const first=run();assert.equal(first.status,0,first.stdout+first.stderr);assert.equal(fs.readFileSync(config,'utf8'),'{"keep":true}');assert.equal(fs.readFileSync(path.join(plugins,'RedflagAutoMute.plugin.js'),'utf8'),source);
  assert.equal(fs.readdirSync(path.join(temp,'BetterDiscord','redflag-backups')).length,1);
  const second=run();assert.equal(second.status,0,second.stdout+second.stderr);assert.equal(fs.readdirSync(path.join(temp,'BetterDiscord','redflag-backups')).length,1);
  const tui=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(temp,'install.ps1'),'-PluginDirectory',plugins,'-SkipBetterDiscord','-MaintenanceDirectory',path.join(temp,'maintenance')],{encoding:'utf8',input:'2\n\n0\n',timeout:15000});assert.equal(tui.status,0,tui.stdout+tui.stderr);assert.match(tui.stdout,/REDFLAG AUTOMUTE 2\.0\.5/);assert.match(tui.stdout,/\[4\/4\]/);
  fs.appendFileSync(path.join(dist,'RedflagAutoMute.plugin.js'),'tampered');assert.equal(run().status,1);assert.equal(fs.readFileSync(path.join(plugins,'RedflagAutoMute.plugin.js'),'utf8'),source);
 } finally {if(path.dirname(temp)===path.resolve(os.tmpdir())&&path.basename(temp).startsWith('rfam-installer-'))fs.rmSync(temp,{recursive:true,force:true});}
});
