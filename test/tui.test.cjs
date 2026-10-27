const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
test('TUI frame stays inside viewport and retains newest output after overflow and resize',{skip:process.platform!=='win32'},()=>{
 const file=path.resolve(__dirname,'../scripts/installer-tui.ps1').replaceAll("'","''");
 const script=`$ErrorActionPreference='Stop';. '${file}';$RfamVersion='test';$lines=@();1..100|ForEach-Object {$lines+=@{Text=('line '+$_+' '+('x'*160));Color='Gray'}};foreach($size in @(@(80,25),@(40,12),@(10,5),@(1,1))){$rows=@(Get-RfamFrame $size[0] $size[1] 'Menu' $lines 'Choice' '2');if($rows.Count -gt [Math]::Max(1,$size[1]-1)){throw 'Frame overflow'};foreach($row in $rows){if($row.Text.Length -gt [Math]::Max(1,$size[0]-1)){throw 'Width overflow'};if($row.Text -match '[\\r\\n]'){throw 'Newline scroll'}}};$rows=@(Get-RfamFrame 80 25 'Menu' $lines 'Choice' '2');if(($rows.Text -join '') -notmatch 'line 100'){throw 'Latest output missing'};if($rows[-1].Text -notmatch 'Choice > 2'){throw 'Input is not pinned'};Initialize-RfamTui $true;if($script:RfamTui){throw 'Redirected output must remain plain'};Write-RfamLine 'plain-output'`;
 const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/plain-output/);
});
