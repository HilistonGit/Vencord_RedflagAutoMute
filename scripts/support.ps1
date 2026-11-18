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
function Send-RfamSupportReport($Report,$Config,[string]$Email,[string]$Password,[bool]$Register) {
    if($Report.events.Length -gt 12000){throw 'Отчёт слишком большой.'}
    $method=if($Register){'signUp'}else{'signInWithPassword'}
    try {
        $body=@{email=$Email;password=$Password;returnSecureToken=$true}|ConvertTo-Json -Compress
        $auth=Invoke-RestMethod -Method Post -Uri ("https://identitytoolkit.googleapis.com/v1/accounts:"+$method+'?key='+$Config.apiKey) -ContentType 'application/json' -Body $body -TimeoutSec 30
        $target=$Config.databaseURL+'/diagnostics/'+[Uri]::EscapeDataString($auth.localId)+'.json?auth='+[Uri]::EscapeDataString($auth.idToken)
        $null=Invoke-RestMethod -Method Put -Uri $target -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Report|ConvertTo-Json -Depth 6 -Compress))) -TimeoutSec 30
    } catch {throw 'Не удалось отправить отчёт. Проверьте сеть, приглашение и аккаунт. Если email уже зарегистрирован, выберите вход. После недавней отправки подождите минуту.'}
    finally {$Password=$null;$body=$null;$auth=$null;$target=$null}
}
function Start-RfamSupport([string]$PluginDirectory,[string]$DiscordRoot,[string]$BdRoot,[string]$Directory,[string]$Channel) {
    Reset-RfamScreen 'Диагностика'
    $report=Get-RfamSupportReport $PluginDirectory $DiscordRoot $BdRoot $Directory $Channel
    $folder=Join-Path $Directory 'support';New-Item -ItemType Directory -Path $folder -Force|Out-Null
    $file=Join-Path $folder 'report.json';Save-RfamJson $report $file
    Write-RfamLine 'Отчёт собран без запуска плагина.' -ForegroundColor Green
    Write-RfamLine 'Внутри: версия и хеш плагина, состояние установки, безопасные технические события.'
    Write-RfamLine 'Паролей, токенов, переписки и содержимого групп в отчёте нет.'
    Write-RfamLine "Копия: $file"
    Write-RfamLine 'Если ошибка возникла до загрузки плагина: откройте консоль Discord (Ctrl+Shift+I → Console) и найдите RedflagAutoMute / PluginManager. Если сочетание отключено, включите DevTools в настройках BetterDiscord.'
    if((Read-RfamInput '1 — отправить в Firebase, Enter — оставить файл') -ne '1'){return}
    $cfg=ConvertFrom-RfamSupportInvite (Read-RfamInput 'Приглашение к базе или группе')
    Write-RfamLine ('Получатель: владелец '+([uri]$cfg.databaseURL).DnsSafeHost)
    Write-RfamLine 'Отчёт будет связан с вашим Firebase-аккаунтом. Приглашение не вступает в группу.'
    if((Read-RfamInput '1 — разрешить отправку этого отчёта, Enter — отмена') -ne '1'){return}
    $mode=Read-RfamInput '1 — войти в аккаунт плагина, 2 — создать новый, Enter — отмена'
    if($mode -notin @('1','2')){return}
    $register=$mode -eq '2'
    $email=Read-RfamInput 'Email аккаунта плагина'
    if($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$'){throw 'Проверьте email.'}
    $password=Read-RfamInput 'Отдельный пароль плагина (не Discord / Google)' -Secret
    try {
        if($password.Length -lt 6){throw 'Пароль должен содержать минимум 6 символов.'}
        if($register){$repeat=Read-RfamInput 'Повторите пароль' -Secret;if($password -cne $repeat){throw 'Пароли не совпадают.'};$repeat=$null}
        Write-RfamLine 'Отправка…' -ForegroundColor Cyan
        Send-RfamSupportReport $report $cfg $email $password $register
        Write-RfamLine 'Отчёт отправлен владельцу базы. Пароль и сессия на диск не сохранялись.' -ForegroundColor Green
    } finally {$password=$null;$repeat=$null}
}
