# Shared installer and maintenance logic. Windows PowerShell 5.1.
$RfamVersion = '2.0.4'
$RfamPlugin = 'RedflagAutoMute.plugin.js'
function Get-RfamHash([string]$File) {
    $stream = [IO.File]::OpenRead($File); $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Assert-RfamPayload([string]$Source, [string]$Manifest) {
    $lines = @(Get-Content -LiteralPath $Manifest | Where-Object { $_ -match '^[a-fA-F0-9]{64}\s+(dist/)?RedflagAutoMute\.plugin\.js$' })
    if ($lines.Count -ne 1 -or (Get-RfamHash $Source) -ne ($lines[0] -split '\s+')[0]) { throw 'Контрольная сумма плагина не совпадает. Распакуйте релиз заново.' }
    if ((Get-Content -LiteralPath $Source -Raw) -notmatch '@name RedflagAutoMute') { throw 'Неверный файл плагина.' }
}
function Get-RfamDiscordRoot([string]$Channel) {
    $name = @{stable='Discord'; ptb='DiscordPTB'; canary='DiscordCanary'}[$Channel]
    $local = Join-Path $env:LOCALAPPDATA $name
    $shared = Join-Path (Join-Path $env:PROGRAMDATA $env:USERNAME) $name
    if (Test-Path -LiteralPath $local) { return $local }
    if (Test-Path -LiteralPath $shared) { return $shared }
    return $local
}
function Get-RfamHealth([string]$DiscordRoot, [string]$BdRoot) {
    $result = [pscustomobject]@{ Healthy=$false; Resources=$null; Reason='Discord не найден'; Conflict=$false }
    if (!(Test-Path -LiteralPath $DiscordRoot -PathType Container)) { return $result }
    $versions = @(Get-ChildItem -LiteralPath $DiscordRoot -Directory | Where-Object { $_.Name -match '^app-\d+(\.\d+){1,3}$' } | Sort-Object { [version]($_.Name.Substring(4)) } -Descending)
    if (!$versions.Count) { return $result }
    $resources = Join-Path $versions[0].FullName 'resources'; $result.Resources = $resources
    $original = Join-Path $resources 'app.asar'; $saved = Join-Path $resources 'betterdiscord.app.asar'
    $loader = Join-Path $resources 'app\index.js'; $package = Join-Path $resources 'app\package.json'
    $result.Reason = 'Discord обновляется или использует неподдерживаемую структуру'
    if (!(Test-Path -LiteralPath $original) -and !(Test-Path -LiteralPath $saved)) { return $result }
    if (Test-Path -LiteralPath (Join-Path $resources 'app')) {
        if (!(Test-Path -LiteralPath $loader)) { $result.Conflict=$true; $result.Reason='Неизвестный загрузчик Discord'; return $result }
        $body = Get-Content -LiteralPath $loader -Raw
        if ($body -notmatch 'betterdiscord\.asar' -or $body -match '(?i)vencord|replugged') { $result.Conflict=$true; $result.Reason='Обнаружена другая модификация: сначала удалите её'; return $result }
    }
    $result.Reason = 'BetterDiscord нужно установить / восстановить'
    $runtime = Join-Path $BdRoot 'data\betterdiscord.asar'
    $validPackage = $false
    if (Test-Path -LiteralPath $package) { try { $main = (Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).main; $validPackage = $main -in @('./index.js','index.js') } catch {} }
    if ((Test-Path -LiteralPath $runtime) -and (Get-Item -LiteralPath $runtime).Length -gt 0 -and
        (Test-Path -LiteralPath $saved) -and (Get-Item -LiteralPath $saved).Length -gt 0 -and
        !(Test-Path -LiteralPath $original) -and (Test-Path -LiteralPath $loader) -and $validPackage) {
        $result.Healthy=$true; $result.Reason='BetterDiscord подключён к текущей версии Discord'
    }
    return $result
}
function Test-RfamDiscordRunning {
    return @((Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue)).Count -gt 0
}
function Test-RfamUpdating([string]$DiscordRoot) {
    foreach ($process in @(Get-Process -Name Update -ErrorAction SilentlyContinue)) {
        try { if (!$process.Path -or $process.Path.StartsWith($DiscordRoot, [StringComparison]::OrdinalIgnoreCase)) { return $true } } catch { return $true }
    }
    return $false
}
function Install-RfamPlugin([string]$Source,[string]$Manifest,[string]$PluginDirectory,[switch]$MissingOnly) {
    Assert-RfamPayload $Source $Manifest
    New-Item -ItemType Directory -Path $PluginDirectory -Force | Out-Null
    $destination = Join-Path $PluginDirectory $RfamPlugin
    if (Test-Path -LiteralPath $destination) {
        if ($MissingOnly -or (Get-RfamHash $destination) -eq (Get-RfamHash $Source)) { return }
        $backup = Join-Path (Split-Path -Parent $PluginDirectory) 'redflag-backups'
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $destination -Destination (Join-Path $backup ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N')+'.js.bak'))
    }
    $staged = Join-Path $PluginDirectory ('redflag-'+[guid]::NewGuid().ToString('N')+'.tmp')
    try { Copy-Item -LiteralPath $Source -Destination $staged; Assert-RfamPayload $staged $Manifest; Copy-Item -LiteralPath $staged -Destination $destination -Force; Assert-RfamPayload $destination $Manifest }
    finally { if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force } }
}
function Get-RfamCli([string]$CacheDirectory) {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = if ($architecture -eq 'ARM64') { 'arm64' } elseif ($architecture -eq 'AMD64') { 'amd64' } else { throw 'Автоустановка поддерживает Windows x64 и ARM64. Установите BetterDiscord вручную.' }
    $release=Get-RfamReleaseAsset 'BetterDiscord/cli' ("^bdcli_[0-9.]+_windows_"+$arch+'\.zip$') $CacheDirectory
    $zip=Join-Path $CacheDirectory ('bdcli-'+$release.hash+'.zip')
    if(!(Test-Path -LiteralPath $zip) -or (Get-RfamHash $zip) -ne $release.hash){Get-RfamRemoteFile $release.url $zip}
    if((Get-RfamHash $zip) -ne $release.hash){throw 'Контрольная сумма официального BetterDiscord CLI не совпадает.'}
    # Extract only the executable, ignoring archive paths. Revalidate the archive before every execution.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $entries = @($archive.Entries | Where-Object { $_.Name -eq 'bdcli.exe' })
        if ($entries.Count -ne 1) { throw 'В архиве отсутствует bdcli.exe' }
        $exe = Join-Path $CacheDirectory 'bdcli.exe'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],$exe,$true)
    } finally { $archive.Dispose() }
    return $exe
}
function Invoke-RfamCli([string]$Exe,[string]$Resources,[string]$LogDirectory) {
    if ($Resources.Contains('"')) { throw 'Недопустимый путь Discord' }
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    $stdout = Join-Path $LogDirectory 'betterdiscord.stdout.log'; $stderr = Join-Path $LogDirectory 'betterdiscord.stderr.log'
    $process=New-Object Diagnostics.Process
    $process.StartInfo.FileName=$Exe
    $process.StartInfo.Arguments='--silent install --path "'+$Resources+'"'
    $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardOutput=$true; $process.StartInfo.RedirectStandardError=$true
    try {
        if(!$process.Start()){throw 'Не удалось запустить BetterDiscord CLI'}
        $outputTask=$process.StandardOutput.ReadToEndAsync();$errorTask=$process.StandardError.ReadToEndAsync()
        if(!$process.WaitForExit(300000)){throw 'BetterDiscord CLI ещё работает. Подождите завершения перед повторной установкой.'}
        $process.WaitForExit()
        [IO.File]::WriteAllText($stdout,$outputTask.Result);[IO.File]::WriteAllText($stderr,$errorTask.Result)
        if($process.ExitCode -ne 0){throw "BetterDiscord CLI завершился с кодом $($process.ExitCode). Подробности: $stderr"}
    } finally {$process.Dispose()}
}
function Install-RfamStack([string]$Source,[string]$Manifest,[string]$PluginDirectory,[string]$DiscordRoot,[string]$BdRoot,[string]$CacheDirectory,[switch]$SkipBetterDiscord,[switch]$MissingOnly) {
    Assert-RfamPayload $Source $Manifest
    if (Get-Process -Name bdcli -ErrorAction SilentlyContinue) { throw 'Другая операция BetterDiscord CLI ещё выполняется. Повторите позже.' }
    if (!$SkipBetterDiscord) {
        $health = Get-RfamHealth $DiscordRoot $BdRoot
        if ($health.Conflict) { throw $health.Reason }
        if (!$health.Resources -or (!(Test-Path -LiteralPath (Join-Path $health.Resources 'app.asar')) -and !(Test-Path -LiteralPath (Join-Path $health.Resources 'betterdiscord.app.asar')))) { throw $health.Reason }
    }
    # Stage the plugin BEFORE BetterDiscord starts/restarts Discord; no GUI-close dependency.
    Install-RfamPlugin $Source $Manifest $PluginDirectory -MissingOnly:$MissingOnly
    if (!$SkipBetterDiscord -and !$health.Healthy) {
        if (Test-RfamDiscordRunning) { throw 'Плагин установлен. Полностью закройте Discord (включая значок в трее) и выберите установку ещё раз.' }
        if (Test-RfamUpdating $DiscordRoot) { throw 'Discord обновляется. Дождитесь завершения и повторите установку.' }
        $cli = Get-RfamCli $CacheDirectory
        if (Test-RfamDiscordRunning) { throw 'Discord был запущен. Закройте его перед восстановлением.' }
        Invoke-RfamCli $cli $health.Resources $CacheDirectory
        $health = Get-RfamHealth $DiscordRoot $BdRoot
        if (!$health.Healthy) { throw "BetterDiscord CLI завершился, но проверка не пройдена: $($health.Reason)" }
    }
    if (!(Test-Path -LiteralPath (Join-Path $PluginDirectory $RfamPlugin))) { throw 'Файл плагина не установлен' }
}
function Get-RfamTaskName { return 'RedflagAutoMute-Maintenance-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Get-RfamTask {
    $service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
    try { return $service.GetFolder('\').GetTask((Get-RfamTaskName)) } catch { return $null }
}
function Disable-RfamMaintenance {
    $service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
    if (Get-RfamTask) { $service.GetFolder('\').DeleteTask((Get-RfamTaskName),0) }
}
function Register-RfamTask([string]$Directory) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $service = New-Object -ComObject 'Schedule.Service'; $service.Connect(); $task = $service.NewTask(0)
    $task.RegistrationInfo.Description = 'RedflagAutoMute: проверка запуска Discord каждые 2 минуты; при сбое проверка исправленных релизов BetterDiscord и восстановление с предупреждением.'
    $task.Principal.UserId=$sid; $task.Principal.LogonType=3; $task.Principal.RunLevel=0
    $task.Settings.Enabled=$true; $task.Settings.Hidden=$true; $task.Settings.StartWhenAvailable=$true
    $task.Settings.DisallowStartIfOnBatteries=$false; $task.Settings.StopIfGoingOnBatteries=$false
    $task.Settings.MultipleInstances=2; $task.Settings.ExecutionTimeLimit='PT10M'
    $trigger=$task.Triggers.Create(1); $trigger.StartBoundary=(Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss'); $trigger.Repetition.Interval='PT2M'; $trigger.Enabled=$true
    $login=$task.Triggers.Create(9); $login.UserId=$sid; $login.Enabled=$true; $login.Delay='PT1M'
    $action=$task.Actions.Create(0); $action.Path=Join-Path $Directory 'scripts\maintenance-launcher.exe'
    $action.Arguments=''
    $action.WorkingDirectory=$Directory
    $service.GetFolder('\').RegisterTaskDefinition((Get-RfamTaskName),$task,6,$sid,$null,3) | Out-Null
}
function Enable-RfamMaintenance([string]$PackageRoot,[string]$Directory,[string]$PluginDirectory,[string]$DiscordRoot,[string]$BdRoot) {
    New-Item -ItemType Directory -Path (Join-Path $Directory 'scripts') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $Directory 'dist') -Force | Out-Null
    foreach ($file in @('install.ps1','SHA256SUMS.txt','scripts\installer-core.ps1','scripts\maintenance.ps1','scripts\maintenance-launcher.cs','scripts\recovery.ps1','scripts\plugin-update.ps1','dist\RedflagAutoMute.plugin.js')) {
        $from=Join-Path $PackageRoot $file; $to=Join-Path $Directory $file
        if ([IO.Path]::GetFullPath($from) -ne [IO.Path]::GetFullPath($to)) { Copy-Item -LiteralPath $from -Destination $to -Force }
    }
    @{autoUpdatePlugin=$true;version=$RfamVersion;pluginDirectory=$PluginDirectory;discordRoot=$DiscordRoot;bdRoot=$BdRoot} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'maintenance.json') -Encoding UTF8
    $launcher=Join-Path $Directory 'scripts\maintenance-launcher.exe'
    $compiled=Join-Path $Directory ('scripts\launcher-'+[guid]::NewGuid().ToString('N')+'.exe')
    try {
        Add-Type -Path (Join-Path $Directory 'scripts\maintenance-launcher.cs') -OutputAssembly $compiled -OutputType WindowsApplication
        Copy-Item -LiteralPath $compiled -Destination $launcher -Force
    } finally {if(Test-Path -LiteralPath $compiled){Remove-Item -LiteralPath $compiled -Force}}
    Register-RfamTask $Directory
}
. (Join-Path $PSScriptRoot 'recovery.ps1')

. (Join-Path $PSScriptRoot 'plugin-update.ps1')
