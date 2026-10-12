# Startup recovery, rather than periodic upgrades of a working Discord session.
function Read-RfamState([string]$File) {
    $state=@{}
    if(Test-Path -LiteralPath $File){try{$value=Get-Content -LiteralPath $File -Raw|ConvertFrom-Json;foreach($p in $value.PSObject.Properties){$state[$p.Name]=$p.Value}}catch{}}
    return $state
}
function Save-RfamJson($Value,[string]$File) {
    $temp=$File+'.tmp';$Value|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $File -Force
}
function Get-RfamSession([string]$DiscordRoot) {
    $prefix=[IO.Path]::GetFullPath($DiscordRoot).TrimEnd('\')+'\'
    $matches=@(Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue|Where-Object {
        try{$_.Path -and $_.Path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)}catch{$false}
    }|Sort-Object StartTime)
    if(!$matches.Count){return $null}
    $p=$matches[0];$start=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
    return [pscustomobject]@{key=([string]$p.Id+':'+$start);startedAt=$start;resources=(Join-Path (Split-Path -Parent $p.Path) 'resources')}
}
function Get-RfamChannel([string]$Resources) {
    try{$channel=(Get-Content -LiteralPath (Join-Path $Resources 'build_info.json') -Raw|ConvertFrom-Json).releaseChannel;if($channel -in @('stable','ptb','canary')){return $channel}}catch{}
    if($Resources -match '(?i)DiscordCanary'){return 'canary'}
    if($Resources -match '(?i)DiscordPTB'){return 'ptb'}
    return 'stable'
}
function Get-RfamSignal([string]$PluginDirectory,[string]$Channel) {
    try{return Get-Content -LiteralPath (Join-Path $PluginDirectory "RedflagAutoMute.health.$Channel.json") -Raw|ConvertFrom-Json}catch{return $null}
}
function Test-RfamPluginEnabled([string]$BdRoot,[string]$Channel) {
    try{return (Get-Content -LiteralPath (Join-Path $BdRoot "data\$Channel\plugins.json") -Raw|ConvertFrom-Json).RedflagAutoMute -eq $true}catch{return $false}
}
function Get-RfamStartupDecision($Health,$Session,$Signal,[bool]$Enabled,[hashtable]$State,[long]$Now) {
    if(!$Health.Resources){return 'missing-discord'}
    if($Session -and $Session.resources -ne $Health.Resources){return 'next-launch'}
    if($Session -and $Signal -and $Signal.schema -eq 1 -and $Signal.state -eq 'running' -and
        $Signal.seenAt -ge $Session.startedAt -and $Signal.startedAt -ge $Session.startedAt -and
        $Signal.seenAt -le ($Now + 5000) -and $Now - $Signal.seenAt -lt 180000) {
        $State.discordResources=$Health.Resources;$State.healthySession=$Session.key;$State.pending=$false;$State.lastAttempt=''
        return 'healthy'
    }
    if($Session -and $State.healthySession -eq $Session.key){return 'session-unchanged'}
    if(!$Health.Healthy){$State.pending=$true;return 'recover'}
    if(!$Session){return 'idle'}
    if(!$Enabled){return 'plugin-disabled'}
    # Do not interrupt a session that previously ran the plugin successfully.
    if($State.healthySession -eq $Session.key){return 'session-unchanged'}
    if($Now - $Session.startedAt -lt 180000){return 'starting'}
    $State.pending=$true
    return 'recover'
}
function Get-RfamRemoteFile([string]$Url,[string]$Destination) {
    if($Url -notmatch '^https://'){throw 'Требуется HTTPS'}
    $curl=Join-Path $env:SystemRoot 'System32\curl.exe'
    if(Test-Path -LiteralPath $curl){
        if($Url.Contains('"') -or $Destination.Contains('"')){throw 'Недопустимые параметры загрузки'}
        $download=New-Object Diagnostics.Process
        $download.StartInfo.FileName=$curl
        $download.StartInfo.Arguments='--fail --location --silent --show-error --proto =https --proto-redir =https --connect-timeout 15 --max-time 120 --retry 1 --user-agent RedflagAutoMute-Maintenance --output "'+$Destination+'" "'+$Url+'"'
        $download.StartInfo.UseShellExecute=$false;$download.StartInfo.CreateNoWindow=$true
        $download.StartInfo.RedirectStandardError=$true;$download.StartInfo.RedirectStandardOutput=$true
        try {
            $null=$download.Start();$stderr=$download.StandardError.ReadToEndAsync();$stdout=$download.StandardOutput.ReadToEndAsync()
            $download.WaitForExit()
            if($download.ExitCode -ne 0){throw 'Официальный сервер обновлений недоступен; повторим позже'}
        } finally {$download.Dispose()}
    }else{Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $Url -OutFile $Destination}
}
function Get-RfamReleaseAsset([string]$Repository,[string]$Pattern,[string]$Directory) {
    if($Repository -notin @('BetterDiscord/BetterDiscord','BetterDiscord/cli')){throw 'Недопустимый источник обновления'}
    New-Item -ItemType Directory -Path $Directory -Force|Out-Null
    $metadata=Join-Path $Directory (($Repository.Replace('/','-'))+'-release.json')
    Get-RfamRemoteFile "https://api.github.com/repos/$Repository/releases/latest" $metadata
    $release=Get-Content -LiteralPath $metadata -Raw|ConvertFrom-Json
    if($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v?\d+\.\d+\.\d+$'){throw 'Неверные сведения об официальном стабильном релизе'}
    $assets=@($release.assets|Where-Object {$_.name -match $Pattern})
    if($assets.Count -ne 1 -or $assets[0].digest -notmatch '^sha256:[a-fA-F0-9]{64}$' -or
        !$assets[0].browser_download_url.StartsWith("https://github.com/$Repository/releases/download/",[StringComparison]::Ordinal)){throw 'Не удалось проверить источник или SHA-256 обновления'}
    return [pscustomobject]@{tag=$release.tag_name;url=$assets[0].browser_download_url;hash=$assets[0].digest.Substring(7).ToLowerInvariant()}
}
function Get-RfamLatestRuntime([string]$Directory) {return Get-RfamReleaseAsset 'BetterDiscord/BetterDiscord' '^betterdiscord\.asar$' $Directory}
function Confirm-RfamRestart([string]$Version) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form=New-Object Windows.Forms.Form
    $form.Text='RedflagAutoMute — восстановление Discord';$form.Width=570;$form.Height=245
    $form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false;$form.TopMost=$true
    $form.Font=New-Object Drawing.Font('Segoe UI',10)
    $label=New-Object Windows.Forms.Label;$label.SetBounds(20,20,520,100)
    $label.Text="После запуска Discord плагин не подтвердил работу или загрузчик был удалён обновлением. Доступен BetterDiscord $Version. Для восстановления Discord будет перезапущен; звонок прервётся."
    $count=New-Object Windows.Forms.Label;$count.SetBounds(20,117,520,25)
    $now=New-Object Windows.Forms.Button;$now.Text='Восстановить сейчас';$now.SetBounds(20,150,220,35);$now.DialogResult=[Windows.Forms.DialogResult]::OK
    $later=New-Object Windows.Forms.Button;$later.Text='Отложить на час';$later.SetBounds(270,150,250,35);$later.DialogResult=[Windows.Forms.DialogResult]::Cancel
    $form.Controls.AddRange(@($label,$count,$now,$later));$form.AcceptButton=$later;$form.CancelButton=$later
    $form.Tag=60;$count.Text='Автоматическое восстановление через 60 секунд.'
    $timer=New-Object Windows.Forms.Timer;$timer.Interval=1000
    $timer.Add_Tick({$form.Tag=[int]$form.Tag-1;$count.Text="Автоматическое восстановление через $($form.Tag) секунд.";if([int]$form.Tag -le 0){$form.DialogResult=[Windows.Forms.DialogResult]::OK;$form.Close()}}.GetNewClosure())
    try{$timer.Start();return $form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK}
    finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
}
function Invoke-RfamMaintenance([string]$Directory) {
    $config=Get-Content -LiteralPath (Join-Path $Directory 'maintenance.json') -Raw|ConvertFrom-Json
    $stateFile=Join-Path $Directory 'recovery-state.json';$state=Read-RfamState $stateFile
    $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $status=[ordered]@{checkedAt=[DateTime]::UtcNow.ToString('o');state='healthy';message='Восстановление не требуется'}
    try {
        $source=Join-Path $Directory "dist\$RfamPlugin";$manifest=Join-Path $Directory 'SHA256SUMS.txt'
        Assert-RfamPayload $source $manifest
        $health=Get-RfamHealth $config.discordRoot $config.bdRoot
        if($health.Conflict){throw $health.Reason}
        $session=Get-RfamSession $config.discordRoot
        $channel=Get-RfamChannel $health.Resources
        $signal=Get-RfamSignal $config.pluginDirectory $channel
        $enabled=Test-RfamPluginEnabled $config.bdRoot $channel
        if(Test-RfamUpdating $config.discordRoot){$decision='updating'}else{$decision=Get-RfamStartupDecision $health $session $signal $enabled $state $now}
        $status.state=$decision
        $messages=@{'healthy'='Плагин работает: обновления и перезапуск не нужны';'idle'='Discord закрыт; проверим запуск при следующем сеансе';'starting'='Даём Discord три минуты на запуск плагина';'plugin-disabled'='Плагин не включён пользователем; автоматический перезапуск не выполняется';'next-launch'='Работает предыдущая версия Discord; проверка новой при следующем запуске';'session-unchanged'='Этот сеанс уже работал; не перезапускаем его из-за отсутствующего сигнала';'missing-discord'='Discord не найден';'updating'='Discord ещё обновляется'}
        if($messages.ContainsKey($decision)){$status.message=$messages[$decision]}
        # Restoring a missing plugin never overwrites an existing/newer file or its settings.
        if($decision -in @('idle','healthy','starting','plugin-disabled','session-unchanged')) {
            $missing=!(Test-Path -LiteralPath (Join-Path $config.pluginDirectory $RfamPlugin))
            Install-RfamPlugin $source $manifest $config.pluginDirectory -MissingOnly
            if($missing){$status.message+='; отсутствующий файл плагина восстановлен'}
        }
        if($decision -eq 'recover') {
            if($state.deferUntil -and $now -lt [long]$state.deferUntil){$status.state='deferred';$status.message='Перезапуск отложен пользователем на час'}
            elseif($state.nextReleaseCheck -and $now -lt [long]$state.nextReleaseCheck){$status.state='waiting-release';$status.message='Ожидаем следующую проверку исправленной версии BetterDiscord'}
            else {
                $state.nextReleaseCheck=$now+900000
                $cache=Join-Path $Directory 'cache';$release=Get-RfamLatestRuntime $cache
                $runtime=Join-Path $config.bdRoot 'data\betterdiscord.asar'
                $currentHash=if(Test-Path -LiteralPath $runtime){Get-RfamHash $runtime}else{''}
                $attempt=$health.Resources+'|'+$release.hash
                if($state.lastAttempt -eq $attempt -or ($health.Healthy -and $currentHash -eq $release.hash)) {
                    $status.state='waiting-release';$status.message='Уже установлена последняя версия BetterDiscord или она уже проверена; ждём нового релиза без повторных перезапусков'
                } else {
                    # Fetch/verify the CLI before asking, so the countdown is not followed by a long CLI download.
                    $cli=Get-RfamCli $cache
                    $session=Get-RfamSession $config.discordRoot
                    $accepted=(!$session) -or (Confirm-RfamRestart $release.tag)
                    if(!$accepted){$state.deferUntil=$now+3600000;$status.state='deferred';$status.message='Перезапуск отложен на час'}
                    elseif(Test-RfamUpdating $config.discordRoot){$status.state='updating';$status.message='Discord начал обновляться; восстановление отложено'}
                    else {
                        # A newly opened Discord also needs its own warning.
                        $currentSession=Get-RfamSession $config.discordRoot
                        if($currentSession -and (!$session -or $currentSession.key -ne $session.key)){$state.deferUntil=$now+120000;$status.state='starting';$status.message='Discord был запущен; проверим новый сеанс'}
                        else {
                            $latestHealth=Get-RfamHealth $config.discordRoot $config.bdRoot
                            if($latestHealth.Conflict -or $latestHealth.Resources -ne $health.Resources){throw 'Установка Discord изменилась во время проверки; повторим позже'}
                            $finalSignal=Get-RfamSignal $config.pluginDirectory $channel
                            $finalDecision=Get-RfamStartupDecision $latestHealth $currentSession $finalSignal $enabled $state ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
                            if($finalDecision -in @('healthy','session-unchanged')){$status.state='healthy';$status.message='Плагин уже запустился; перезапуск отменён'}
                            else {
                            Install-RfamPlugin $source $manifest $config.pluginDirectory -MissingOnly
                            Invoke-RfamCli $cli $health.Resources $cache
                            if(!(Get-RfamHealth $config.discordRoot $config.bdRoot).Healthy){throw 'После восстановления загрузчик не прошёл проверку'}
                            if((Get-RfamHash $runtime) -ne $release.hash){$state.lastAttempt=$attempt;throw 'Установленная версия не совпала с проверенным релизом; автоматические перезапуски остановлены до нового релиза'}
                            $state.lastAttempt=$attempt;$state.deferUntil=0;$status.state='awaiting-startup';$status.message='BetterDiscord восстановлен; ожидаем сигнал успешного запуска плагина'
                            }
                        }
                    }
                }
            }
        }
    } catch {$status.state='error';$status.message=$_.Exception.Message}
    Save-RfamJson $state $stateFile
    Save-RfamJson $status (Join-Path $Directory 'status.json')
    Invoke-RfamPluginUpdate $Directory $config
    return [pscustomobject]$status
}
