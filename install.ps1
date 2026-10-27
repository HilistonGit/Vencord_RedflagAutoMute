[CmdletBinding()]
param(
    [string]$PluginDirectory = (Join-Path $env:APPDATA 'BetterDiscord\plugins'),
    [ValidateSet('stable','ptb','canary')][string]$Channel='stable',
    [string]$DiscordRoot,
    [string]$MaintenanceDirectory=(Join-Path $env:LOCALAPPDATA 'RedflagAutoMute\maintenance'),
    [ValidateSet('Menu','Install','Status','DisableMaintenance')][string]$Action='Menu',
    [switch]$EnableMaintenance,
    [switch]$NonInteractive,
    [switch]$SkipBetterDiscord
)
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'scripts\installer-core.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-tui.ps1')
Initialize-RfamTui (!$NonInteractive -and $Action -eq 'Menu')
$bdRoot=Join-Path $env:APPDATA 'BetterDiscord'
$customRoot=!!$DiscordRoot
if (!$DiscordRoot) { $DiscordRoot=Get-RfamDiscordRoot $Channel }
$source=Join-Path $PSScriptRoot "dist\$RfamPlugin"; $manifest=Join-Path $PSScriptRoot 'SHA256SUMS.txt'
function Show-RfamHeader {
    Reset-RfamScreen 'Главное меню'
    if(!$script:RfamTui){Write-RfamLine " REDFLAG AUTOMUTE $RfamVersion | Установка и восстановление" -ForegroundColor Cyan}
    $health=Get-RfamHealth $DiscordRoot $bdRoot
    Write-RfamLine " Discord: $Channel | $DiscordRoot" -ForegroundColor Gray
    Write-RfamLine (' BetterDiscord: '+$health.Reason) -ForegroundColor $(if($health.Healthy){'Green'}else{'Yellow'})
    Write-RfamLine (' Плагин: '+$(if(Test-Path -LiteralPath (Join-Path $PluginDirectory $RfamPlugin)){'установлен'}else{'не установлен'}))
    try { $task=Get-RfamTask; Write-RfamLine (' Автовосстановление: '+$(if($task -and $task.Enabled){'включено (проверка запуска каждые 2 минуты)'}else{'выключено'})) } catch { Write-RfamLine ' Планировщик Windows недоступен' -ForegroundColor Yellow }
    Write-RfamLine ''
}
function Show-RfamStatus {
    Show-RfamHeader
    if($script:RfamTui){$script:RfamTui.Title='Диагностика'}
    $statusFile=Join-Path $MaintenanceDirectory 'status.json'
    if(Test-Path -LiteralPath $statusFile){$status=Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json;Write-RfamLine " Последняя проверка (UTC): $($status.checkedAt)";Write-RfamLine " $($status.message)"}
    Write-RfamLine " Файлы плагинов: $PluginDirectory"
    Write-RfamLine " Состояние и журналы: $MaintenanceDirectory"
    Write-RfamLine ' Проверяется наличие загрузчика; работоспособность интерфейса внутри Discord автоматически не проверяется.'
}
function Start-RfamInstallCore([bool]$Maintenance) {
    Reset-RfamScreen 'Установка'
    if($Maintenance -and $SkipBetterDiscord){throw 'Автовосстановление нельзя включить с -SkipBetterDiscord.'}
    Write-RfamLine '[1/4] Проверка файлов релиза и контрольных сумм...' -ForegroundColor Cyan
    Assert-RfamPayload $source $manifest
    if(!$SkipBetterDiscord -and (Test-RfamDiscordRunning)) {
        $health=Get-RfamHealth $DiscordRoot $bdRoot
        if(!$health.Healthy){
            if($NonInteractive){throw 'Закройте Discord перед установкой BetterDiscord.'}
            Write-RfamLine ' Полностью закройте Discord: правой кнопкой на значке в трее → Quit Discord.' -ForegroundColor Yellow
            Write-RfamLine ' Затем нажмите Enter. Для отмены введите 0.'
            do {if((Read-RfamInput ' Продолжить') -eq '0'){return};$running=Test-RfamDiscordRunning;if($running){Write-RfamLine ' Discord всё ещё запущен. Проверьте значок в трее.' -ForegroundColor Yellow}} while($running)
        }
    }
    Write-RfamLine '[2/4] Установка плагина и BetterDiscord через официальный CLI...' -ForegroundColor Cyan
    Write-RfamLine ' Первая загрузка может занять несколько минут. Оставьте это окно открытым.'
    Install-RfamStack $source $manifest $PluginDirectory $DiscordRoot $bdRoot (Join-Path $MaintenanceDirectory 'cache') -SkipBetterDiscord:$SkipBetterDiscord
    if($SkipBetterDiscord){Write-RfamLine '[3/4] Проверка BetterDiscord пропущена (-SkipBetterDiscord).' -ForegroundColor Yellow}else{Write-RfamLine '[3/4] Проверка подключения к текущей версии Discord пройдена.' -ForegroundColor Green}
    if($Maintenance){
        Write-RfamLine ' Перед нужным перезапуском: предупреждение на 60 секунд и возможность отложить на час.'
        Write-RfamLine '[4/4] Включение фонового восстановления...' -ForegroundColor Cyan
        Enable-RfamMaintenance $PSScriptRoot $MaintenanceDirectory $PluginDirectory $DiscordRoot $bdRoot
        Write-RfamLine ' Проверка запуска каждые 2 минуты. При сбое — поиск исправления BetterDiscord раз в 15 минут.'
    } else {Write-RfamLine '[4/4] Установка завершена. Настройка фоновой задачи не изменена.'}
    Write-RfamLine ''
    Write-RfamLine ' ГОТОВО — запустите Discord и включите RedflagAutoMute в разделе Плагины.' -ForegroundColor Green
    Write-RfamLine ' Шестерёнка → Подключение → У меня есть приглашение → вставить код друга.'
    Write-RfamLine ' Для нового аккаунта: Нет аккаунта? Создать → email и отдельный пароль.'
    Write-RfamLine ' Ваши настройки, группы и пароли сохранены.'
}
function Start-RfamInstall([bool]$Maintenance) {
    $mutex=New-Object Threading.Mutex($false,('Local\'+(Get-RfamTaskName)))
    $locked=$false
    try {
        try {$locked=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$locked=$true}
        if(!$locked){throw 'Другая установка или фоновая проверка уже выполняется. Повторите позже.'}
        Start-RfamInstallCore $Maintenance
    } finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
}
try {
    if($NonInteractive -and $Action -eq 'Menu'){$Action='Install'}
    if($Action -eq 'Install'){Start-RfamInstall ([bool]$EnableMaintenance);exit 0}
    if($Action -eq 'Status'){Show-RfamStatus;exit 0}
    if($Action -eq 'DisableMaintenance'){Disable-RfamMaintenance;Write-RfamLine 'Фоновая задача удалена. Плагин и настройки сохранены.';exit 0}
    while($true){
        Show-RfamHeader
        Write-RfamLine '  [1] Установить / восстановить + включить автовосстановление' -ForegroundColor White
        Write-RfamLine '  [2] Установить / обновить только плагин и BetterDiscord'
        Write-RfamLine '  [3] Диагностика и пути журналов'
        Write-RfamLine '  [4] Отключить автовосстановление'
        Write-RfamLine '  [5] Выбрать Discord: Stable / PTB / Canary'
        Write-RfamLine '  [6] Включить / отключить автообновление плагина (раз в 6 часов)'
        Write-RfamLine '  [0] Выход'
        Write-RfamLine ''
        $choice=Read-RfamInput ' Выберите пункт [1]'
        try {
            switch($choice){
                {$_ -in @('','1')} {Start-RfamInstall $true}
                '2' {Start-RfamInstall $false}
                '3' {Show-RfamStatus}
                '4' {Disable-RfamMaintenance;Write-RfamLine ' Автовосстановление отключено. Плагин и настройки сохранены.' -ForegroundColor Green}
                '5' {if($customRoot){Write-RfamLine 'Используется путь -DiscordRoot; для смены перезапустите без него.'}else{$new=Read-RfamInput ' stable / ptb / canary';if($new -in @('stable','ptb','canary')){$Channel=$new;$DiscordRoot=Get-RfamDiscordRoot $Channel}else{Write-RfamLine 'Неизвестный канал'}}}
                '6' {$file=Join-Path $MaintenanceDirectory 'maintenance.json';$cfg=Read-RfamState $file;if(!$cfg.version){throw 'Сначала включите фоновую задачу пунктом 1'};$cfg.autoUpdatePlugin=!($cfg.autoUpdatePlugin -eq $true);Save-RfamJson $cfg $file;Write-RfamLine (' Автообновление плагина: '+$cfg.autoUpdatePlugin)}
                '0' {exit 0}
                default {Write-RfamLine ' Выберите номер пункта.' -ForegroundColor Yellow}
            }
        } catch {Write-RfamLine (' Ошибка: '+$_.Exception.Message) -ForegroundColor Red;Write-RfamLine ' Можно исправить проблему и повторить установку в этом же окне.'}
        Read-RfamInput ' Enter — вернуться в меню' | Out-Null
    }
} catch {Write-RfamLine ('Ошибка: '+$_.Exception.Message) -ForegroundColor Red;if($script:RfamTui){Read-RfamInput 'Enter — выход' | Out-Null};exit 1} finally {Close-RfamTui}
