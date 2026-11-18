. (Join-Path $PSScriptRoot 'support-console.ps1')
# Standalone diagnostic collection: works even if BetterDiscord never loaded the plugin.
function Get-RfamSupportReport([string]$PluginDirectory,[string]$DiscordRoot,[string]$BdRoot,[string]$Directory,[string]$Channel) {
    $plugin=Join-Path $PluginDirectory $RfamPlugin
    $health=Get-RfamHealth $DiscordRoot $BdRoot
    $signal=Get-RfamSignal $PluginDirectory $Channel
    $events=New-Object Collections.ArrayList
    $null=$events.Add(@{event='installer-support';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();installer=$RfamVersion;channel=$Channel;pluginExists=(Test-Path -LiteralPath $plugin);pluginVersion=[string](Get-RfamPluginVersion $plugin);pluginHash=$(if(Test-Path -LiteralPath $plugin){Get-RfamHash $plugin}else{''});betterDiscordHealthy=[bool]$health.Healthy;pluginEnabled=(Test-RfamPluginEnabled $BdRoot $Channel);heartbeatPresent=[bool]$signal})
    $state=Read-RfamState (Join-Path $Directory 'plugin-update\state.json')
    if($state.status -in @('updated','awaiting-startup','error','rolled-back','plugin-disabled','up-to-date','blocked-after-rollback','unknown-local-version','discord-updating')){$null=$events.Add(@{event='updater-status';status=$state.status})}
    $diagnostics=Read-RfamState (Join-Path $PluginDirectory 'RedflagAutoMuteDiagnostics.config.json')
    foreach($e in @($diagnostics.events | Select-Object -Last 15)) {
        if($e.event -notin @('start','runtime','settings-request','settings-mounted','settings-not-mounted','settings-render','settings-action')){continue}
        $item=@{event=$e.event}
        if($e.kind -in @('none','Error','TypeError','ReferenceError','RangeError','SyntaxError')){$item.kind=$e.kind}
        if([string]$e.frames -match '^(?:[0-9]{1,7}:[0-9]{1,7}(?:,|$)){0,6}$'){$item.frames=[string]$e.frames}
        foreach($key in @('plugin','betterdiscord','react','discord')){if([string]$e.$key -match '^\d{1,8}(\.\d{1,8}){1,3}$'){$item[$key]=[string]$e.$key}}
        $null=$events.Add($item)
    }
    $log=Get-RfamCapturedLog $Directory
    if($log){foreach($entry in @(Get-RfamConsoleEvents $log)){$null=$events.Add($entry)}}
    return @{schema=1;updatedAt=@{'.sv'='timestamp'};events=ConvertTo-Json -InputObject @($events) -Depth 5 -Compress}
}
function ConvertFrom-RfamSupportInvite([string]$Code) {
    if($Code.Length -gt 4096 -or $Code -notmatch '^(rfam1|rfdb1)\.([A-Za-z0-9_-]+)$'){throw 'Нужен код приглашения rfam1.… или rfdb1.…'}
    $base=$Matches[2].Replace('-','+').Replace('_','/');$base=$base.PadRight($base.Length+(4-$base.Length%4)%4,'=')
    $cfg=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base))|ConvertFrom-Json
    $url=[uri]$cfg.databaseURL
    if($url.Scheme -ne 'https' -or !$url.IsDefaultPort -or $url.UserInfo -or $url.Query -or $url.Fragment -or $url.AbsolutePath -ne '/' -or $url.DnsSafeHost -notmatch '^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.(firebaseio\.com|firebasedatabase\.app)$' -or [string]$cfg.apiKey -notmatch '^[A-Za-z0-9_-]{10,200}$'){throw 'Некорректный адрес Firebase в приглашении.'}
    return @{databaseURL=$url.GetLeftPart([UriPartial]::Authority);apiKey=[string]$cfg.apiKey}
}
function Get-RfamAnonymousSession($Config,[string]$Directory) {
    $folder=Join-Path $Directory 'support';New-Item -ItemType Directory -Path $folder -Force|Out-Null
    $file=Join-Path $folder 'anonymous.json';$saved=Read-RfamState $file
    if($saved.project -eq $Config.databaseURL -and $saved.refresh) {
        $secure=ConvertTo-SecureString $saved.refresh;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {$refresh=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secure.Dispose()}
        try {$auth=Invoke-RestMethod -Method Post -Uri ('https://securetoken.googleapis.com/v1/token?key='+$Config.apiKey) -ContentType 'application/x-www-form-urlencoded' -Body ('grant_type=refresh_token&refresh_token='+[Uri]::EscapeDataString($refresh)) -TimeoutSec 30}finally{$refresh=$null}
        $session=@{uid=$auth.user_id;token=$auth.id_token;refresh=$auth.refresh_token}
    } else {
        $auth=Invoke-RestMethod -Method Post -Uri ('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key='+$Config.apiKey) -ContentType 'application/json' -Body '{"returnSecureToken":true}' -TimeoutSec 30
        $session=@{uid=$auth.localId;token=$auth.idToken;refresh=$auth.refreshToken}
    }
    if($session.refresh){$secure=ConvertTo-SecureString $session.refresh -AsPlainText -Force;try{$protected=ConvertFrom-SecureString $secure}finally{$secure.Dispose()};Save-RfamJson @{project=$Config.databaseURL;refresh=$protected} $file}
    return $session
}
function Send-RfamSupportReport($Report,$Config,[string]$Directory) {
    if($Report.events.Length -gt 12000){throw 'Отчёт слишком большой.'}
    try {
        $auth=Get-RfamAnonymousSession $Config $Directory
        $target=$Config.databaseURL+'/diagnostics/'+[Uri]::EscapeDataString($auth.uid)+'.json?auth='+[Uri]::EscapeDataString($auth.token)
        $null=Invoke-RestMethod -Method Put -Uri $target -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Report|ConvertTo-Json -Depth 6 -Compress))) -TimeoutSec 30
    } catch {throw 'Не удалось отправить отчёт. Он сохранён локально. Проверьте сеть и включение Anonymous в Firebase. После недавней отправки подождите минуту.'}
    finally {$auth=$null;$target=$null}
}
function Get-RfamSupportTarget([string]$PluginDirectory,[string]$Directory) {
    $installed=Read-RfamState (Join-Path $PluginDirectory 'RedflagAutoMute.config.json')
    $cached=Read-RfamState (Join-Path $Directory 'support\target.json')
    foreach($candidate in @($cached,$installed.config)) {
        if(!$candidate.databaseURL -or !$candidate.apiKey){continue}
        try {
            $json=$candidate|ConvertTo-Json -Compress
            $code='rfdb1.'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')
            return ConvertFrom-RfamSupportInvite $code
        } catch {continue}
    }
    return $null
}
function Start-RfamSupport([string]$PluginDirectory,[string]$DiscordRoot,[string]$BdRoot,[string]$Directory,[string]$Channel) {
    Reset-RfamScreen 'Диагностика без регистрации'
    $folder=Join-Path $Directory 'support';New-Item -ItemType Directory -Path $folder -Force|Out-Null
    Write-RfamLine '1 — собрать и отправить отчёт; 2 — записать ошибку запуска Discord; Enter — отмена'
    $action=Read-RfamInput 'Выберите действие'
    if($action -notin @('1','2')){return}
    if($action -eq '2'){$null=Start-RfamConsoleCapture $DiscordRoot $BdRoot $Directory $Channel}
    $report=Get-RfamSupportReport $PluginDirectory $DiscordRoot $BdRoot $Directory $Channel
    $file=Join-Path $folder 'report.json';Save-RfamJson $report $file
    $events=@($report.events|ConvertFrom-Json);$captured=@($events|Where-Object {$_.event -eq 'console-error'})
    Write-RfamLine ('Строк консоли Redflag / BetterDiscord: '+$captured.Count)
    if(!$captured.Count){Write-RfamLine 'Ошибка не найдена в сохранённой консоли. Для ошибки до запуска плагина выберите режим 2 и воспроизведите её.' -ForegroundColor Yellow}
    $cfg=Get-RfamSupportTarget $PluginDirectory $Directory
    if(!$cfg){$cfg=ConvertFrom-RfamSupportInvite (Read-RfamInput 'Один раз вставьте приглашение: оно задаёт только адрес приёмника');Save-RfamJson $cfg (Join-Path $folder 'target.json')}
    Write-RfamLine ('Получатель: '+([uri]$cfg.databaseURL).DnsSafeHost)
    Write-RfamLine 'Отправляются состояние установки и очищенные строки ошибок. Полная консоль остаётся на компьютере.'
    Write-RfamLine "Отчёт для просмотра: $file"
    if((Read-RfamInput '1 — отправить без регистрации; Enter — оставить файл') -ne '1'){return}
    Write-RfamLine 'Отправка…' -ForegroundColor Cyan
    Send-RfamSupportReport $report $cfg $Directory
    Write-RfamLine 'Отчёт отправлен. Email и пароль не нужны.' -ForegroundColor Green
}
