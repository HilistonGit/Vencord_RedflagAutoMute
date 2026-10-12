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
$bdRoot=Join-Path $env:APPDATA 'BetterDiscord'
$customRoot=!!$DiscordRoot
if (!$DiscordRoot) { $DiscordRoot=Get-RfamDiscordRoot $Channel }
$source=Join-Path $PSScriptRoot "dist\$RfamPlugin"; $manifest=Join-Path $PSScriptRoot 'SHA256SUMS.txt'
function Show-RfamHeader {
    Write-Host ''
    Write-Host ' ============================================================' -ForegroundColor DarkCyan
    Write-Host "   REDFLAG AUTOMUTE $RfamVersion | Установка и восстановление" -ForegroundColor Cyan
    Write-Host ' ============================================================' -ForegroundColor DarkCyan
    $health=Get-RfamHealth $DiscordRoot $bdRoot
    Write-Host " Discord: $Channel | $DiscordRoot" -ForegroundColor Gray
    Write-Host (' BetterDiscord: '+$health.Reason) -ForegroundColor $(if($health.Healthy){'Green'}else{'Yellow'})
    Write-Host (' Плагин: '+$(if(Test-Path -LiteralPath (Join-Path $PluginDirectory $RfamPlugin)){'установлен'}else{'не установлен'}))
    try { $task=Get-RfamTask; Write-Host (' Автовосстановление: '+$(if($task -and $task.Enabled){'включено (проверка запуска каждые 2 минуты)'}else{'выключено'})) } catch { Write-Host ' Планировщик Windows недоступен' -ForegroundColor Yellow }
    Write-Host ''
}
function Show-RfamStatus {
    Show-RfamHeader
    $statusFile=Join-Path $MaintenanceDirectory 'status.json'
    if(Test-Path -LiteralPath $statusFile){$status=Get-Content -LiteralPath $statusFile -Raw|ConvertFrom-Json;Write-Host " Последняя проверка (UTC): $($status.checkedAt)";Write-Host " $($status.message)"}
    Write-Host " Файлы плагинов: $PluginDirectory"
    Write-Host " Состояние и журналы: $MaintenanceDirectory"
    Write-Host ' Проверяется наличие загрузчика; работоспособность интерфейса внутри Discord автоматически не проверяется.'
}
function Start-RfamInstallCore([bool]$Maintenance) {
    if($Maintenance -and $SkipBetterDiscord){throw 'Автовосстановление нельзя включить с -SkipBetterDiscord.'}
    Write-Host '[1/4] Проверка файлов релиза и контрольных сумм...' -ForegroundColor Cyan
    Assert-RfamPayload $source $manifest
    if(!$SkipBetterDiscord -and (Test-RfamDiscordRunning)) {
        $health=Get-RfamHealth $DiscordRoot $bdRoot
        if(!$health.Healthy){
            if($NonInteractive){throw 'Закройте Discord перед установкой BetterDiscord.'}
            Write-Host ' Полностью закройте Discord: правой кнопкой на значке в трее → Quit Discord.' -ForegroundColor Yellow
            Write-Host ' Затем нажмите Enter. Для отмены введите 0.'
            do {if((Read-Host ' Продолжить') -eq '0'){return};$running=Test-RfamDiscordRunning;if($running){Write-Host ' Discord всё ещё запущен. Проверьте значок в трее.' -ForegroundColor Yellow}} while($running)
        }
    }
    Write-Host '[2/4] Установка плагина и BetterDiscord через официальный CLI...' -ForegroundColor Cyan
    Write-Host ' Первая загрузка может занять несколько минут. Оставьте это окно открытым.'
    Install-RfamStack $source $manifest $PluginDirectory $DiscordRoot $bdRoot (Join-Path $MaintenanceDirectory 'cache') -SkipBetterDiscord:$SkipBetterDiscord
    if($SkipBetterDiscord){Write-Host '[3/4] Проверка BetterDiscord пропущена (-SkipBetterDiscord).' -ForegroundColor Yellow}else{Write-Host '[3/4] Проверка подключения к текущей версии Discord пройдена.' -ForegroundColor Green}
    if($Maintenance){
        Write-Host ' Перед нужным перезапуском: предупреждение на 60 секунд и возможность отложить на час.'
        Write-Host '[4/4] Включение фонового восстановления...' -ForegroundColor Cyan
        Enable-RfamMaintenance $PSScriptRoot $MaintenanceDirectory $PluginDirectory $DiscordRoot $bdRoot
        Write-Host ' Проверка запуска каждые 2 минуты. При сбое — поиск исправления BetterDiscord раз в 15 минут.'
    } else {Write-Host '[4/4] Установка завершена. Настройка фоновой задачи не изменена.'}
    Write-Host ''
    Write-Host ' ГОТОВО — запустите Discord и включите RedflagAutoMute в разделе Плагины.' -ForegroundColor Green
    Write-Host ' Шестерёнка → Подключение → У меня есть приглашение → вставить код друга.'
    Write-Host ' Для нового аккаунта: Нет аккаунта? Создать → email и отдельный пароль.'
    Write-Host ' Ваши настройки, группы и пароли сохранены.'
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
    if($Action -eq 'DisableMaintenance'){Disable-RfamMaintenance;Write-Host 'Фоновая задача удалена. Плагин и настройки сохранены.';exit 0}
    while($true){
        Show-RfamHeader
        Write-Host '  [1] Установить / восстановить + включить автовосстановление' -ForegroundColor White
        Write-Host '  [2] Установить / обновить только плагин и BetterDiscord'
        Write-Host '  [3] Диагностика и пути журналов'
        Write-Host '  [4] Отключить автовосстановление'
        Write-Host '  [5] Выбрать Discord: Stable / PTB / Canary'
        Write-Host '  [6] Включить / отключить автообновление плагина (раз в 6 часов)'
        Write-Host '  [0] Выход'
        Write-Host ''
        $choice=Read-Host ' Выберите пункт [1]'
        try {
            switch($choice){
                {$_ -in @('','1')} {Start-RfamInstall $true}
                '2' {Start-RfamInstall $false}
                '3' {Show-RfamStatus}
                '4' {Disable-RfamMaintenance;Write-Host ' Автовосстановление отключено. Плагин и настройки сохранены.' -ForegroundColor Green}
                '5' {if($customRoot){Write-Host 'Используется путь -DiscordRoot; для смены перезапустите без него.'}else{$new=Read-Host ' stable / ptb / canary';if($new -in @('stable','ptb','canary')){$Channel=$new;$DiscordRoot=Get-RfamDiscordRoot $Channel}else{Write-Host 'Неизвестный канал'}}}
                '6' {$file=Join-Path $MaintenanceDirectory 'maintenance.json';$cfg=Read-RfamState $file;if(!$cfg.version){throw 'Сначала включите фоновую задачу пунктом 1'};$cfg.autoUpdatePlugin=!($cfg.autoUpdatePlugin -eq $true);Save-RfamJson $cfg $file;Write-Host (' Автообновление плагина: '+$cfg.autoUpdatePlugin)}
                '0' {exit 0}
                default {Write-Host ' Выберите номер пункта.' -ForegroundColor Yellow}
            }
        } catch {Write-Host (' Ошибка: '+$_.Exception.Message) -ForegroundColor Red;Write-Host ' Можно исправить проблему и повторить установку в этом же окне.'}
        Read-Host ' Enter — вернуться в меню' | Out-Null
    }
} catch {Write-Host ('Ошибка: '+$_.Exception.Message) -ForegroundColor Red;exit 1}
