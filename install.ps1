# Функция для вывода цветного текста
function Write-ColorOutput($ForegroundColor) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    if ($args) {
        Write-Output $args
    }
    $host.UI.RawUI.ForegroundColor = $fc
}

# Проверка прав администратора
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-ColorOutput Red "Этот скрипт требует прав администратора!"
    Write-ColorOutput Red "Пожалуйста, запустите PowerShell от имени администратора и попробуйте снова."
    exit 1
}

# Создаем временную директорию для загрузки плагина
$tempDir = Join-Path $env:TEMP "RedflagAutoMute_Install"
if (Test-Path $tempDir) {
    Remove-Item -Path $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

# Установка Git через winget
Write-ColorOutput Green "Установка Git..."
winget install --id Git.Git -e --source winget

# Установка Node.js через winget
Write-ColorOutput Green "Установка Node.js..."
winget install --id OpenJS.NodeJS -e --source winget

# Обновление переменных окружения
Write-ColorOutput Green "Обновление переменных окружения..."
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Установка pnpm через PowerShell
Write-ColorOutput Green "Установка pnpm..."
iwr https://get.pnpm.io/install.ps1 -useb | iex

# Создаем второй скрипт для продолжения установки
$secondScript = @'
# Функция для вывода цветного текста
function Write-ColorOutput($ForegroundColor) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    if ($args) {
        Write-Output $args
    }
    $host.UI.RawUI.ForegroundColor = $fc
}

$tempDir = Join-Path $env:TEMP "RedflagAutoMute_Install"

# Загрузка плагина из GitHub
Write-ColorOutput Green "Загрузка плагина RedflagAutoMute..."
Set-Location $tempDir
git clone https://github.com/HilistonGit/Vencord_RedflagAutoMute.git
if (-not $?) {
    Write-ColorOutput Red "Ошибка при загрузке плагина!"
    exit 1
}

# Клонирование Vencord
Write-ColorOutput Green "Клонирование репозитория Vencord..."
$vencordPath = "$env:USERPROFILE\Documents\Vencord"
if (Test-Path $vencordPath) {
    Remove-Item -Path $vencordPath -Recurse -Force
}
git clone https://github.com/Vendicated/Vencord.git $vencordPath

# Копирование файлов плагина с сохранением структуры
Write-ColorOutput Green "Установка плагина RedflagAutoMute..."
$pluginPath = "$vencordPath\src\userplugins\RedflagAutoMute"
New-Item -ItemType Directory -Path $pluginPath -Force | Out-Null
Copy-Item "$tempDir\Vencord_RedflagAutoMute\src\userplugins\RedflagAutoMute\*" -Destination $pluginPath -Recurse -Force

# Установка зависимостей Vencord
Set-Location $vencordPath
Write-ColorOutput Green "Установка зависимостей Vencord..."
pnpm install

# Установка Firebase
Write-ColorOutput Green "Установка Firebase..."
pnpm add -w firebase

# Сборка Vencord
Write-ColorOutput Green "Сборка Vencord..."
pnpm build

Write-ColorOutput Green "Установка Vencord..."
pnpm inject

# Очистка временных файлов
Remove-Item -Path $tempDir -Recurse -Force

# Перезапуск Discord
Write-ColorOutput Green "Перезапуск Discord..."
Get-Process Discord -ErrorAction SilentlyContinue | Stop-Process
Start-Process "$env:LOCALAPPDATA\Discord\Update.exe" -ArgumentList "--processStart Discord.exe"

Write-ColorOutput Green "`nУстановка завершена!"
Write-ColorOutput Yellow "`nДля настройки плагина:"
Write-ColorOutput White "1. Откройте настройки Discord (Ctrl + ,)"
Write-ColorOutput White "2. Перейдите в раздел Vencord -> Plugins"
Write-ColorOutput White "3. Найдите RedflagAutoMute в списке плагинов"
Write-ColorOutput White "4. Введите URL базы данных Firebase и ключ API"
Write-ColorOutput White "5. Нажмите Save Settings"

Write-ColorOutput Green "`nПриятного использования!"
pause
'@

# Сохраняем второй скрипт во временный файл
$secondScriptPath = Join-Path $tempDir "continue_install.ps1"
Set-Content -Path $secondScriptPath -Value $secondScript

# Запускаем второй скрипт в новом процессе PowerShell
Write-ColorOutput Green "`nЗапуск второй части установки..."
Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$secondScriptPath`"" -Wait 