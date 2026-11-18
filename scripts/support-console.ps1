function Get-RfamConsoleEvents([string]$File) {
    if(!(Test-Path -LiteralPath $File)){return @()}
    $stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $length=[Math]::Min($stream.Length,2097152);$null=$stream.Seek(-$length,[IO.SeekOrigin]::End)
        $bytes=New-Object byte[] $length;$read=$stream.Read($bytes,0,$bytes.Length)
        $lines=[Text.Encoding]::UTF8.GetString($bytes,0,$read) -split '[\r\n]+'
    } finally {$stream.Dispose()}
    $events=New-Object Collections.ArrayList;$context=0
    foreach($line in $lines) {
        $line=$line -replace '[, ]+source:.*$', ''
        if($line -match '(?i)RedflagAutoMute|\[BetterDiscord\]|\[PluginManager\]|\[Addon Settings\]'){$context=6}
        elseif($context -gt 0 -and $line -match '^\s*(at |(?:Type|Reference|Syntax|Range)?Error:)'){$context--}
        else{$context=0;continue}
        $clean=$line -replace '\x1b\[[0-9;]*[A-Za-z]',''
        $clean=$clean -replace '(?i)(?:https?|wss?)://[^\s"<>]+','[url]'
        $clean=$clean -replace '(?i)(?:[a-z]:[\\/]|/Users/|/home/)[^\r\n"<>]*?(?=RedflagAutoMute\.plugin\.js|betterdiscord\.asar|["<>]|$)','[path]/'
        $clean=$clean -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}','[email]'
        $clean=$clean -replace '(?i)(?:rfam1|rfdb1)\.[A-Za-z0-9_-]+','[invite]'
        $clean=$clean -replace '(?i)(["'']?(?:authorization|password|refresh_token|id_token|refreshToken|idToken|token|apiKey|secret)["'']?)\s*[=:]\s*["'']?[^\s,"'';]+','$1=[redacted]'
        $clean=$clean -replace '(?i)Bearer\s+\S+','Bearer [redacted]'
        $clean=$clean -replace '[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*','[redacted]'
        $clean=$clean -replace '\b\d{17,20}\b','[id]'
        $clean=$clean -replace '[\x00-\x1f\x7f]',' '
        if($clean.Length -gt 400){$clean=$clean.Substring(0,400)}
        $null=$events.Add(@{event='console-error';text=$clean})
    }
    return @($events|Select-Object -Last 12)
}
function Start-RfamConsoleCapture([string]$DiscordRoot,[string]$BdRoot,[string]$Directory,[string]$Channel) {
    if(Test-RfamDiscordRunning){throw 'Для записи ошибок запуска полностью закройте Discord (включая трей), затем повторите пункт 8. Текущий звонок автоматически не прерывается.'}
    if(Test-RfamUpdating $DiscordRoot){throw 'Дождитесь завершения обновления Discord.'}
    $health=Get-RfamHealth $DiscordRoot $BdRoot
    if(!$health.Resources){throw 'Discord не найден.'}
    $app=Split-Path -Parent $health.Resources
    $name=@{stable='Discord.exe';ptb='DiscordPTB.exe';canary='DiscordCanary.exe'}[$Channel]
    $exe=Join-Path $app $name
    if(!(Test-Path -LiteralPath $exe)){throw 'Исполняемый файл Discord не найден.'}
    $folder=Join-Path $Directory 'support';New-Item -ItemType Directory -Path $folder -Force|Out-Null
    $log=Join-Path $folder ('console-'+[guid]::NewGuid().ToString('N')+'.log')
    Save-RfamJson @{file=[IO.Path]::GetFileName($log)} (Join-Path $folder 'capture.json')
    Start-Process -FilePath $exe -WorkingDirectory $app -ArgumentList @('--enable-logging=file',('--log-file="'+$log+'"'),'--log-level=0') -WindowStyle Hidden | Out-Null
    Write-RfamLine 'Discord запущен с записью консоли. Повторите проблемное действие.' -ForegroundColor Cyan
    Write-RfamLine 'Исходная консоль хранится только локально. После проверки перезапустите Discord обычным способом, чтобы прекратить запись.'
    Read-RfamInput 'Enter — собрать записанную ошибку' | Out-Null
    return $log
}
function Get-RfamCapturedLog([string]$Directory) {
    $folder=Join-Path $Directory 'support';$capture=Read-RfamState (Join-Path $folder 'capture.json')
    if([string]$capture.file -match '^console-[a-f0-9]{32}\.log$'){return Join-Path $folder $capture.file}
    return $null
}
