# Only stable, versioned GitHub releases; never execute downloaded installer scripts.
function Get-RfamPluginVersion([string]$File) {
    if(!(Test-Path -LiteralPath $File)){return $null}
    $text=Get-Content -LiteralPath $File -Raw
    if($text -match '@version\s+(\d+\.\d+\.\d+)\s'){return [version]$Matches[1]}
    return $null
}
function Get-RfamPluginRelease([string]$Directory) {
    $repo='HilistonGit/Vencord_RedflagAutoMute'
    $file=Join-Path $Directory 'release.json'
    Get-RfamRemoteFile "https://api.github.com/repos/$repo/releases/latest" $file
    $release=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
    if($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(\d+\.\d+\.\d+)$'){throw 'Invalid stable plugin release'}
    $version=[version]$Matches[1]
    $assets=@($release.assets|Where-Object {$_.name -eq 'RedflagAutoMute.plugin.js'})
    if($assets.Count -ne 1){throw 'Plugin asset missing or ambiguous'}
    $asset=$assets[0]
    if($asset.digest -notmatch '^sha256:[a-fA-F0-9]{64}$' -or $asset.size -gt 5242880 -or $asset.size -le 0 -or
       $asset.browser_download_url -ne "https://github.com/$repo/releases/download/$($release.tag_name)/RedflagAutoMute.plugin.js") {throw 'Invalid plugin asset source or digest'}
    return @{version=$version;hash=$asset.digest.Substring(7).ToLowerInvariant();url=$asset.browser_download_url}
}
function Invoke-RfamPluginUpdate([string]$Directory,$Config) {
    if($Config.autoUpdatePlugin -ne $true){return}
    $folder=Join-Path $Directory 'plugin-update';New-Item -ItemType Directory -Path $folder -Force|Out-Null
    $stateFile=Join-Path $folder 'state.json';$state=Read-RfamState $stateFile
    $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $file=Join-Path $Config.pluginDirectory $RfamPlugin
    try {
        if($state.pending) {
            $pending=$state.pending
            $current=Get-RfamPluginVersion $file
            if(!$current -or $current.ToString() -ne $pending.version -or (Get-RfamHash $file) -ne $pending.hash) {
                $state.pending=$null;$state.status='changed-externally';return
            }
            $session=Get-RfamSession $Config.discordRoot
            if(!$session){$state.status='awaiting-startup';return}
            $channel=Get-RfamChannel $session.resources
            if(!(Test-RfamPluginEnabled $Config.bdRoot $channel)){$state.status='plugin-disabled';return}
            $signal=Get-RfamSignal $Config.pluginDirectory $channel
            if($signal -and $signal.state -eq 'running' -and $signal.pluginVersion -eq $pending.version -and
                $signal.startedAt -ge $session.startedAt -and $signal.seenAt -ge $pending.at -and $now-$signal.seenAt -lt 180000) {
                $state.pending=$null;$state.status='updated';return
            }
            # Give a newly opened client and a hot reload three minutes each.
            if($now-[Math]::Max([long]$pending.at,[long]$session.startedAt) -lt 180000){return}
            $backup=Join-Path $folder 'previous.plugin.js'
            if((Get-RfamHash $backup) -ne $pending.previousHash){throw 'Rollback backup changed'}
            Copy-Item -LiteralPath $backup -Destination $file -Force
            $state.blockedVersion=$pending.version;$state.pending=$null;$state.status='rolled-back'
            return
        }
        if($state.nextCheck -and $now -lt [long]$state.nextCheck){return}
        $state.nextCheck=$now+21600000;$state.checkedAt=[DateTime]::UtcNow.ToString('o')
        $installed=Get-RfamPluginVersion $file
        if(!$installed){$state.status='unknown-local-version';return}
        $release=Get-RfamPluginRelease $folder
        if($release.version -le $installed){$state.status='up-to-date';return}
        if($release.version.ToString() -eq $state.blockedVersion){$state.status='blocked-after-rollback';return}
        $staged=Join-Path $folder 'download.plugin.js'
        Get-RfamRemoteFile $release.url $staged
        if((Get-RfamHash $staged) -ne $release.hash -or (Get-RfamPluginVersion $staged) -ne $release.version -or
           (Get-Content -LiteralPath $staged -Raw) -notmatch '@name\s+RedflagAutoMute\s'){throw 'Plugin verification failed'}
        # A manual update while downloading must win.
        if((Get-RfamPluginVersion $file) -ne $installed){$state.status='changed-externally';return}
        if(Test-RfamUpdating $Config.discordRoot){$state.nextCheck=$now+120000;$state.status='discord-updating';return}
        $backup=Join-Path $folder 'previous.plugin.js';Copy-Item -LiteralPath $file -Destination $backup -Force
        $state.pending=@{version=$release.version.ToString();hash=$release.hash;previousHash=(Get-RfamHash $backup);at=$now}
        $state.status='awaiting-startup';Save-RfamJson $state $stateFile
        try {Copy-Item -LiteralPath $staged -Destination $file -Force;if((Get-RfamHash $file) -ne $release.hash){throw 'Installed hash mismatch'}}
        catch {Copy-Item -LiteralPath $backup -Destination $file -Force;$state.pending=$null;throw}
    } catch {$state.status='error';$state.error=$_.Exception.Message}
    finally {Save-RfamJson $state $stateFile}
}
