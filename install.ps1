[CmdletBinding()]
param(
    [string]$PluginDirectory = (Join-Path $env:APPDATA 'BetterDiscord\plugins'),
    [switch]$NonInteractive,
    [switch]$SkipBetterDiscord
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$releaseBase = 'https://github.com/HilistonGit/Vencord_RedflagAutoMute/releases/download/v2.0.0'
$pluginName = 'RedflagAutoMute.plugin.js'
$source = Join-Path $PSScriptRoot ('dist\' + $pluginName)
$manifest = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('RedflagAutoMute-' + [Guid]::NewGuid().ToString('N'))
function Get-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Assert-PluginHash([string]$File, [string]$ManifestFile) {
    $line = @(Get-Content -LiteralPath $ManifestFile | Where-Object { $_ -match '^[a-fA-F0-9]{64}\s+(dist/)?RedflagAutoMute\.plugin\.js$' })
    if ($line.Count -ne 1) { throw 'Не найдена однозначная контрольная сумма плагина.' }
    $expected = ($line[0] -split '\s+')[0]
    if ((Get-Sha256 $File) -ne $expected) { throw 'Контрольная сумма не совпадает. Скачайте релиз заново.' }
    if ((Get-Content -LiteralPath $File -Raw) -notmatch '@name RedflagAutoMute') { throw 'Неверный файл плагина.' }
}
try {
    Write-Host 'RedflagAutoMute 2.0.0 — установка для Windows' -ForegroundColor Cyan
    if (!(Test-Path -LiteralPath $source) -or !(Test-Path -LiteralPath $manifest)) {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $source = Join-Path $tempRoot $pluginName
        $manifest = Join-Path $tempRoot 'SHA256SUMS.txt'
        Write-Host 'Скачиваем плагин из официального релиза проекта...'
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$pluginName" -OutFile $source
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/SHA256SUMS.txt" -OutFile $manifest
    }
    Assert-PluginHash $source $manifest
    $bdRoot = Join-Path $env:APPDATA 'BetterDiscord'
    if (!$SkipBetterDiscord -and !(Test-Path -LiteralPath (Join-Path $bdRoot 'data\betterdiscord.asar'))) {
        if ($NonInteractive) { throw 'Сначала установите BetterDiscord: https://betterdiscord.app/' }
        Write-Host 'BetterDiscord не найден. Его официальный установщик потребует вашего участия и может перезапустить Discord.'
        $answer = Read-Host 'Открыть официальный установщик BetterDiscord? [y/N]'
        if ($answer -notmatch '^(y|yes|д|да)$') { throw 'Установите BetterDiscord и запустите этот скрипт снова.' }
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/BetterDiscord/Installer/releases/latest' -Headers @{ 'User-Agent'='RedflagAutoMute-Installer' }
        $asset = @($release.assets | Where-Object { $_.name -eq 'BetterDiscord-Installer-Windows.exe' })
        if ($asset.Count -ne 1 -or $asset[0].browser_download_url -notlike 'https://github.com/BetterDiscord/Installer/releases/download/*') { throw 'Не найден официальный установщик. Откройте https://betterdiscord.app/' }
        $digest = [string]$asset[0].digest
        if ($digest -notmatch '^sha256:[a-fA-F0-9]{64}$') { throw 'GitHub не предоставил контрольную сумму установщика. Установите BetterDiscord вручную с https://betterdiscord.app/' }
        $installer = Join-Path $tempRoot 'BetterDiscord-Installer-Windows.exe'
        Invoke-WebRequest -UseBasicParsing -Uri $asset[0].browser_download_url -OutFile $installer
        if ((Get-Sha256 $installer) -ne $digest.Substring(7)) { throw 'Неверная контрольная сумма установщика BetterDiscord.' }
        Start-Process -FilePath $installer -Wait -WindowStyle Normal
        if (!(Test-Path -LiteralPath (Join-Path $bdRoot 'data\betterdiscord.asar'))) { throw 'Завершите установку BetterDiscord и повторите запуск.' }
    }
    New-Item -ItemType Directory -Path $PluginDirectory -Force | Out-Null
    $destination = Join-Path $PluginDirectory $pluginName
    if ((Test-Path -LiteralPath $destination) -and (Get-Sha256 $destination) -ne (Get-Sha256 $source)) {
        $backup = Join-Path (Split-Path -Parent $PluginDirectory) 'redflag-backups'
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Copy-Item -LiteralPath $destination -Destination (Join-Path $backup ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.js.bak'))
        Write-Host "Предыдущий файл сохранён: $backup"
    }
    $staged = Join-Path $PluginDirectory ('redflag-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    Copy-Item -LiteralPath $source -Destination $staged
    Assert-PluginHash $staged $manifest
    Move-Item -LiteralPath $staged -Destination $destination -Force
    Write-Host 'Готово. Настройки и аккаунты сохранены.' -ForegroundColor Green
    Write-Host '1. Discord → Настройки → BetterDiscord → Плагины → включите RedflagAutoMute.'
    Write-Host '2. Шестерёнка плагина → Подключение → У меня есть приглашение.'
    Write-Host '3. Вставьте код друга. Создайте свой аккаунт плагина или войдите.'
    Write-Host 'Пароль Discord или Google не нужен. Discord не перезапускается этим скриптом.'
} catch {
    Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
