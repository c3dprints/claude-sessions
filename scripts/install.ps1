# Installs (or repairs) Claude Sessions for this Windows user.
#   - clones the repo to %LOCALAPPDATA%\ClaudeSessions\app and checks out the newest release tag
#   - restarts the server if it is running
#   - puts a "Claude Sessions" shortcut on the Desktop
param([string]$Repo = 'https://github.com/c3dprints/claude-sessions.git')
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'ClaudeSessions'
$app = Join-Path $root 'app'
New-Item -ItemType Directory -Force $root | Out-Null

if (-not (Test-Path (Join-Path $app '.git'))) {
  git clone --quiet $Repo $app
  if ($LASTEXITCODE) { throw 'git clone failed' }
}
git -C $app fetch --tags --force --quiet origin
if ($LASTEXITCODE) { throw 'git fetch failed' }
$tag = git -C $app tag -l 'v*' | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
  Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
if (-not $tag) { throw 'the repo has no release tags yet' }
git -C $app checkout --quiet "refs/tags/$tag"
if ($LASTEXITCODE) { throw "checkout of $tag failed" }
Write-Host "Installed $tag in $app"

# Stop a running copy so the launcher starts the new code.
$serverJs = Join-Path $app 'server.js'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverJs) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$desktop = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Claude Sessions.lnk'))
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + (Join-Path $app 'scripts\launch.vbs') + '"'
$s.WorkingDirectory = $app
$s.IconLocation = Join-Path $app 'public\icon.ico'
$s.Description = 'Claude Sessions dashboard'
$s.Save()
Write-Host "Desktop shortcut: $desktop\Claude Sessions.lnk"

Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $app 'scripts\launch.vbs') + '"')
