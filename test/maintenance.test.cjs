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
test('native CLI runner captures real process exit codes and output',{skip:process.platform!=='win32'},()=>run(`
$ok=Join-Path $root 'ok.exe';$bad=Join-Path $root 'bad.exe'
Add-Type -TypeDefinition 'public class Good { public static int Main(string[] args) { System.Console.WriteLine("cli-ok"); return 0; } }' -OutputAssembly $ok -OutputType ConsoleApplication
Add-Type -TypeDefinition 'public class Bad { public static int Main(string[] args) { System.Console.Error.WriteLine("cli-error"); return 7; } }' -OutputAssembly $bad -OutputType ConsoleApplication
Invoke-RfamCli $ok $root $root
Check ((Get-Content -LiteralPath (Join-Path $root 'betterdiscord.stdout.log')) -eq 'cli-ok') 'CLI stdout was not collected'
$failed=$false;try{Invoke-RfamCli $bad $root $root}catch{$failed=$_.Exception.Message -match '7'};Check $failed 'Nonzero exit code was not preserved'
`));
test('startup decision never interrupts a proven working session, waits for load and respects disabled plugin',{skip:process.platform!=='win32'},()=>run(`
$health=[pscustomobject]@{Healthy=$true;Resources='discord/app-2/resources'}
$session=[pscustomobject]@{key='new';startedAt=1000;resources=$health.Resources};$state=@{}
$signal=[pscustomobject]@{schema=1;state='running';startedAt=2000;seenAt=200000}
Check ((Get-RfamStartupDecision $health $session $signal $true $state 200001) -eq 'healthy') 'Fresh signal not accepted'
Check ((Get-RfamStartupDecision $health $session $null $true $state 900000) -eq 'session-unchanged') 'Working session interrupted'
$session.key='next';$session.startedAt=899000
Check ((Get-RfamStartupDecision $health $session $null $true $state 900000) -eq 'starting') 'Startup grace absent'
$session.startedAt=500000
Check ((Get-RfamStartupDecision $health $session $signal $true $state 900000) -eq 'recover') 'Old session signal falsely accepted'
Check ((Get-RfamStartupDecision $health $session $null $false $state 900000) -eq 'plugin-disabled') 'Disabled plugin treated as broken'
$session.resources='discord/app-1/resources'
Check ((Get-RfamStartupDecision $health $session $null $true $state 900000) -eq 'next-launch') 'Old working version restarted for staged update'
`));
const recoverySetup=setup+`
$runtime=Join-Path $root 'maintenance';New-Item -ItemType Directory -Path (Join-Path $runtime 'dist') -Force|Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $runtime 'dist/RedflagAutoMute.plugin.js')
Copy-Item -LiteralPath $manifest -Destination (Join-Path $runtime 'SHA256SUMS.txt')
@{discordRoot=$discord;bdRoot=$bd;pluginDirectory=$plugins}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $runtime 'maintenance.json')
$expected=Join-Path $root 'expected.asar';Set-Content -LiteralPath $expected -Value 'runtime'
function Get-RfamLatestRuntime {return [pscustomobject]@{tag='v1.0.0';hash=(Get-RfamHash $expected)}}
function Get-RfamSession {return $null}
function Get-RfamSignal {return $null}
function Test-RfamPluginEnabled {return $true}
`;
test('startup recovery repairs injection once, retains newer plugin and waits for launch',{skip:process.platform!=='win32'},()=>run(recoverySetup+`
Check ((Invoke-RfamMaintenance $runtime).state -eq 'awaiting-startup') 'Initial repair failed'
Set-Content -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js') -Value 'newer'
function Get-RfamLatestRuntime {throw 'Working idle install must not check upgrades'}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'idle') 'Closed healthy client not left alone'
Check ((Get-Content -LiteralPath (Join-Path $plugins 'RedflagAutoMute.plugin.js')) -eq 'newer') 'Newer plugin overwritten'
`));
test('startup failure waits for newer release, supports postponement, then verifies recovery signal',{skip:process.platform!=='win32'},()=>run(recoverySetup+`
Install-RfamStack $source $manifest $plugins $discord $bd $root
$session=[pscustomobject]@{key='one';startedAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-600000);resources=$resources}
function Get-RfamSession {return $session}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'waiting-release') 'Latest runtime pointlessly reinstalled'
Set-Content -LiteralPath $expected -Value 'runtime-new'
$stateFile=Join-Path $runtime 'recovery-state.json'
$state=Read-RfamState $stateFile;$state.nextReleaseCheck=0;Save-RfamJson $state $stateFile
function Confirm-RfamRestart {return $false}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'deferred') 'Postponement ignored'
function Confirm-RfamRestart {throw 'Prompt repeated during postponement'}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'deferred') 'Persisted postponement ignored'
$state=Read-RfamState $stateFile;$state.nextReleaseCheck=0;$state.deferUntil=0;Save-RfamJson $state $stateFile
function Confirm-RfamRestart {return $true}
function Invoke-RfamCli {Copy-Item -LiteralPath $expected -Destination (Join-Path $bd 'data/betterdiscord.asar') -Force}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'awaiting-startup') 'New release not applied'
$state=Read-RfamState $stateFile;$state.nextReleaseCheck=0;Save-RfamJson $state $stateFile
function Confirm-RfamRestart {throw 'Same release must not trigger repeated restart'}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'waiting-release') 'Failed release repeated'
function Get-RfamSignal {return [pscustomobject]@{schema=1;state='running';startedAt=$session.startedAt+1;seenAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}}
function Get-RfamLatestRuntime {throw 'Healthy active session should not check for updates'}
Check ((Invoke-RfamMaintenance $runtime).state -eq 'healthy') 'Recovered plugin not recognized'
`));
