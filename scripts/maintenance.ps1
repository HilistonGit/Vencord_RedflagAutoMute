$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'installer-core.ps1')
$directory=Split-Path -Parent $PSScriptRoot
$mutex=New-Object Threading.Mutex($false,('Local\'+(Get-RfamTaskName)))
$locked=$false
try { try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }; if ($locked) { $result=Invoke-RfamMaintenance $directory; if($result.state -eq 'error'){exit 1} } }
finally { if($locked){$mutex.ReleaseMutex()};$mutex.Dispose() }
