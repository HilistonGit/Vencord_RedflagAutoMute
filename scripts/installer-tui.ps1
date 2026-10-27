# Fixed viewport renderer. No external dependencies; redirected runs retain plain output.
$script:RfamTui=$null
function Initialize-RfamTui([bool]$Enabled) {
    if(!$Enabled -or [Console]::IsOutputRedirected -or [Console]::IsInputRedirected){return}
    try {
        $script:RfamTui=@{Lines=(New-Object Collections.ArrayList);Prompt='';Input='';Title='Главное меню';Cursor=[Console]::CursorVisible;Foreground=[Console]::ForegroundColor;Background=[Console]::BackgroundColor;Width=0;Height=0;Previous=@()}
        [Console]::CursorVisible=$false
        [Console]::BackgroundColor=[ConsoleColor]::Black
        [Console]::Clear()
    } catch {$script:RfamTui=$null}
}
function Get-RfamFrame([int]$Width,[int]$Height,[string]$Title,$Lines,[string]$Prompt,[string]$InputText) {
    # Leave the last column and last row unused: writing there can scroll conhost.
    $width=[Math]::Max(1,$Width-1);$height=[Math]::Max(1,$Height-1)
    $rows=New-Object Collections.ArrayList
    $null=$rows.Add(@{Text="  REDFLAG AUTOMUTE $RfamVersion  /  $Title";Color='Cyan'})
    $null=$rows.Add(@{Text=('─'*$width);Color='DarkCyan'})
    $body=New-Object Collections.ArrayList
    foreach($line in $Lines){
        $clean=[regex]::Replace([string]$line.Text,'[\x00-\x1f\x7f]',' ')
        if(!$clean.Length){$null=$body.Add(@{Text='';Color=$line.Color})}
        for($offset=0;$offset -lt $clean.Length;$offset+=$width){$null=$body.Add(@{Text=$clean.Substring($offset,[Math]::Min($width,$clean.Length-$offset));Color=$line.Color})}
    }
    $slots=[Math]::Max(0,$height-4)
    foreach($line in @($body | Select-Object -Last $slots)){if($slots -gt 0){$null=$rows.Add($line)}}
    while($rows.Count -lt $height-2){$null=$rows.Add(@{Text='';Color='Gray'})}
    $null=$rows.Add(@{Text=('─'*$width);Color='DarkCyan'})
    $null=$rows.Add(@{Text=$(if($Prompt){" $Prompt > $InputText"}else{' Выполняется…  •  Не закрывайте окно'});Color='White'})
    return @($rows | Select-Object -First $height | ForEach-Object {
        $text=[regex]::Replace([string]$_.Text,'[\x00-\x1f\x7f]',' ')
        if($text.Length -gt $width){$text=$text.Substring(0,$width)}
        @{Text=$text.PadRight($width);Color=$_.Color}
    })
}
function Update-RfamScreen {
    if(!$script:RfamTui){return}
    try {
        $width=[Console]::WindowWidth;$height=[Console]::WindowHeight
        if($width -ne $script:RfamTui.Width -or $height -ne $script:RfamTui.Height){[Console]::Clear();$script:RfamTui.Width=$width;$script:RfamTui.Height=$height;$script:RfamTui.Previous=@()}
        $rows=Get-RfamFrame $width $height $script:RfamTui.Title $script:RfamTui.Lines $script:RfamTui.Prompt $script:RfamTui.Input
        for($i=0;$i -lt $rows.Count;$i++){
            if($i -lt $script:RfamTui.Previous.Count -and $rows[$i].Text -eq $script:RfamTui.Previous[$i].Text -and $rows[$i].Color -eq $script:RfamTui.Previous[$i].Color){continue}
            [Console]::SetCursorPosition([Console]::WindowLeft,[Console]::WindowTop+$i)
            [Console]::ForegroundColor=[ConsoleColor]$rows[$i].Color
            [Console]::Write($rows[$i].Text)
        }
        $script:RfamTui.Previous=$rows
    } catch { $script:RfamTui.Previous=@() # Resizing can temporarily invalidate cursor coordinates; retry on next frame.
    }
}
function Reset-RfamScreen([string]$Title) {
    if($script:RfamTui){$script:RfamTui.Lines.Clear();$script:RfamTui.Title=$Title;$script:RfamTui.Prompt='';$script:RfamTui.Input='';Update-RfamScreen}
}
function Write-RfamLine([string]$Text='', [ConsoleColor]$ForegroundColor='Gray') {
    if(!$script:RfamTui){Write-Host $Text -ForegroundColor $ForegroundColor;return}
    $null=$script:RfamTui.Lines.Add(@{Text=$Text;Color=[string]$ForegroundColor})
    if($script:RfamTui.Lines.Count -gt 200){$script:RfamTui.Lines.RemoveAt(0)}
    Update-RfamScreen
}
function Read-RfamInput([string]$Prompt) {
    if(!$script:RfamTui){return Read-Host $Prompt}
    $script:RfamTui.Prompt=$Prompt;$script:RfamTui.Input=''
    try {
        while($true){
            Update-RfamScreen
            if(![Console]::KeyAvailable){Start-Sleep -Milliseconds 100;continue}
            $key=[Console]::ReadKey($true)
            if($key.Key -eq 'Enter'){return $script:RfamTui.Input}
            if($key.Key -eq 'Backspace'){
                if($script:RfamTui.Input.Length){$script:RfamTui.Input=$script:RfamTui.Input.Substring(0,$script:RfamTui.Input.Length-1)}
            } elseif(![char]::IsControl($key.KeyChar) -and $script:RfamTui.Input.Length -lt 80){$script:RfamTui.Input+=$key.KeyChar}
        }
    } finally {$script:RfamTui.Prompt='';$script:RfamTui.Input=''}
}
function Close-RfamTui {
    if(!$script:RfamTui){return}
    try {[Console]::ForegroundColor=$script:RfamTui.Foreground;[Console]::BackgroundColor=$script:RfamTui.Background;[Console]::CursorVisible=$script:RfamTui.Cursor;[Console]::Clear()} finally {$script:RfamTui=$null}
}
