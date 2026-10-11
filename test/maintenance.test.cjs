const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const core=path.resolve(__dirname,'../scripts/installer-core.ps1').replaceAll("'","''");
function run(body){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rfam-core-'));try{const file=path.join(dir,'test.ps1');fs.writeFileSync(file,'\ufeff'+`$ErrorActionPreference='Stop'\n. '${core}'\n$root=$PSScriptRoot\nfunction Check($condition,$message){if(!$condition){throw $message}}\n`+body);const env={...process.env};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',env});assert.equal(r.status,0,r.stdout+r.stderr);}finally{if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('rfam-core-'))fs.rmSync(dir,{recursive:true,force:true});}}
const setup=`
$discord=Join-Path $root 'Discord';$bd=Join-Path $root 'BetterDiscord';$plugins=Join-Path $bd 'plugins';$resources=Join-Path $discord 'app-1.0.1/resources'
New-Item -ItemType Directory -Path $resources,(Join-Path $bd 'data'),$plugins -Force|Out-Null
Set-Content -LiteralPath (Join-Path $resources 'app.asar') -Value 'original'
$source=Join-Path $root 'RedflagAutoMute.plugin.js';$manifest=Join-Path $root 'SHA256SUMS.txt'
Set-Content -LiteralPath $source -Value '/** @name RedflagAutoMute */'
Set-Content -LiteralPath $manifest -Value ((Get-RfamHash $source)+'  dist/RedflagAutoMute.plugin.js')
function Test-RfamDiscordRunning {return $false}
function Test-RfamUpdating {return $false}
function Get-RfamCli {return 'fake.exe'}
function Invoke-RfamCli($exe,$res,$logs){
 Check (Test-Path -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js')) 'Plugin must be installed before CLI'
 Move-Item -LiteralPath (Join-Path $res 'app.asar') -Destination (Join-Path $res 'betterdiscord.app.asar') -Force
 New-Item -ItemType Directory -Path (Join-Path $res 'app') -Force|Out-Null
 Set-Content -LiteralPath (Join-Path $res 'app/index.js') -Value 'require("betterdiscord.asar")'
 Set-Content -LiteralPath (Join-Path $res 'app/package.json') -Value '{"main":"./index.js"}'
 Set-Content -LiteralPath (Join-Path $bd 'data/betterdiscord.asar') -Value 'runtime'
}
`;
test('installer continues through CLI, verifies latest injection and preserves settings',{skip:process.platform!=='win32'},()=>run(setup+`
Set-Content -LiteralPath (Join-Path $plugins 'RedflagAutoMute.config.json') -Value 'private-settings'
Install-RfamStack $source $manifest $plugins $discord $bd $root
Check (Get-RfamHealth $discord $bd).Healthy 'Installation did not complete'
Check ((Get-Content -LiteralPath (Join-Path $plugins 'RedflagAutoMute.config.json')) -eq 'private-settings') 'Settings changed'
$new=Join-Path $discord 'app-1.0.2/resources';New-Item -ItemType Directory -Path $new -Force|Out-Null
Set-Content -LiteralPath (Join-Path $new 'app.asar') -Value 'updated'
Check (!(Get-RfamHealth $discord $bd).Healthy) 'Old runtime falsely counts as installed in new Discord'
Install-RfamStack $source $manifest $plugins $discord $bd $root
Check (Get-RfamHealth $discord $bd).Healthy 'Repair did not reconnect latest version'
`));
test('installer rejects false CLI success, conflicts, and active Discord',{skip:process.platform!=='win32'},()=>run(setup+`
function Invoke-RfamCli { }
$failed=$false;try{Install-RfamStack $source $manifest $plugins $discord $bd $root}catch{$failed=$true};Check $failed 'False success accepted'
function Test-RfamDiscordRunning {return $true}
function Get-RfamCli {throw 'MUST NOT DOWNLOAD'}
$failed=$false;try{Install-RfamStack $source $manifest $plugins $discord $bd $root}catch{$failed=$_.Exception.Message -notmatch 'MUST NOT DOWNLOAD'};Check $failed 'Active Discord not deferred'
New-Item -ItemType Directory -Path (Join-Path $resources 'app') -Force|Out-Null
Set-Content -LiteralPath (Join-Path $resources 'app/index.js') -Value 'require("Vencord")'
Check (Get-RfamHealth $discord $bd).Conflict 'Other mod not detected'
`));
test('maintenance repairs only missing files, defers active client and never downgrades plugin',{skip:process.platform!=='win32'},()=>run(setup+`
$runtime=Join-Path $root 'maintenance';New-Item -ItemType Directory -Path (Join-Path $runtime 'dist') -Force|Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $runtime 'dist/RedflagAutoMute.plugin.js')
Copy-Item -LiteralPath $manifest -Destination (Join-Path $runtime 'SHA256SUMS.txt')
@{discordRoot=$discord;bdRoot=$bd;pluginDirectory=$plugins}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $runtime 'maintenance.json')
Check ((Invoke-RfamMaintenance $runtime).state -eq 'repaired') 'Cold repair failed'
Check ((Invoke-RfamMaintenance $runtime).state -eq 'healthy') 'Healthy install rewritten'
Set-Content -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js') -Value 'newer plugin'
Check ((Invoke-RfamMaintenance $runtime).state -eq 'healthy') 'Newer plugin overwritten'
$new=Join-Path $discord 'app-1.0.2/resources';New-Item -ItemType Directory -Path $new -Force|Out-Null;Set-Content -LiteralPath (Join-Path $new 'app.asar') -Value 'updated'
Check ((Invoke-RfamMaintenance $runtime).state -eq 'repaired') 'Updated Discord not repaired'
Check ((Get-Content -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js')) -eq 'newer plugin') 'Repair downgraded plugin'
Remove-Item -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js')
function Test-RfamDiscordRunning {return $true}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'deferred') 'Running Discord not deferred'
Check (!(Test-Path -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js'))) 'Deferred run wrote files'
function Test-RfamDiscordRunning {return $false}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'repaired') 'Missing plugin not restored'
`));
test('native CLI runner captures real process exit codes and output',{skip:process.platform!=='win32'},()=>run(`
$ok=Join-Path $root 'ok.exe';$bad=Join-Path $root 'bad.exe'
Add-Type -TypeDefinition 'public class Good { public static int Main(string[] args) { System.Console.WriteLine("cli-ok"); return 0; } }' -OutputAssembly $ok -OutputType ConsoleApplication
Add-Type -TypeDefinition 'public class Bad { public static int Main(string[] args) { System.Console.Error.WriteLine("cli-error"); return 7; } }' -OutputAssembly $bad -OutputType ConsoleApplication
Invoke-RfamCli $ok $root $root
Check ((Get-Content -LiteralPath (Join-Path $root 'betterdiscord.stdout.log')) -eq 'cli-ok') 'CLI stdout was not collected'
$failed=$false;try{Invoke-RfamCli $bad $root $root}catch{$failed=$_.Exception.Message -match '7'};Check $failed 'Nonzero exit code was not preserved'
`));
