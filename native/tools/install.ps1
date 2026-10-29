# Puts the native program where Mer starts it from, with a desktop shortcut, as two copies like the web page's:
#   testing    updated with each change, to try things out          shortcut "SplashTank Testing"
#   published  updated only when Mer says a testing build is good   shortcut "SplashTank"
# Each copy is one file in its own folder (%LOCALAPPDATA%\SplashTank\<channel>) with channel.txt beside it; the window title says which
# copy it is and the commit it was built from.
#   powershell -ExecutionPolicy Bypass -File native/tools/install.ps1 -Channel testing
#   powershell -ExecutionPolicy Bypass -File native/tools/install.ps1 -Channel published
# -NoBuild copies target\release\splashtank.exe as it is. Publishing refuses changes that are not committed (-Force overrides).
param(
    [Parameter(Mandatory = $true)][ValidateSet('testing', 'published')][string]$Channel,
    [switch]$NoBuild,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$native = Split-Path -Parent $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
if ($Channel -eq 'published' -and -not $Force) {
    $changes = git -C $native status --porcelain --untracked-files=no -- .
    if ($changes) { throw "There are changes in native/ that are not committed. Commit them first, so the published copy is a known build (or pass -Force)." }
}
if (-not $NoBuild) {
    Push-Location $native
    try { cargo build --release -p splashtank; if ($LASTEXITCODE -ne 0) { throw 'The build failed.' } } finally { Pop-Location }
}
$exe = Join-Path $native 'target\release\splashtank.exe'
$dir = Join-Path $env:LOCALAPPDATA "SplashTank\$Channel"
New-Item -ItemType Directory -Force $dir | Out-Null
$dest = Join-Path $dir 'splashtank.exe'
try { Copy-Item $exe $dest -Force } catch { throw "Could not replace $dest. Close SplashTank$(if ($Channel -eq 'testing') { ' Testing' }) and try again." }
Set-Content -Path (Join-Path $dir 'channel.txt') -Value $Channel -Encoding ascii
$name = if ($Channel -eq 'testing') { 'SplashTank Testing' } else { 'SplashTank' }
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $dest
$s.WorkingDirectory = $dir
$s.Description = "SplashTank native program ($Channel copy)"
$s.Save()
$commit = git -C $native rev-parse --short HEAD
Write-Output "$name is now build $commit ($dest), shortcut $lnk"
