<#
.SYNOPSIS
  claudex installer (Windows).

.DESCRIPTION
  Installs the `claudex` command, and optionally a `claude.cmd` shim that
  shadows the real CLI so existing commands gain failover without being retyped.
  The shim is opt-in: it puts claudex in front of every `claude` invocation on
  this machine, including the ones your editor makes.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -AsClaude
  .\install.ps1 -Uninstall
#>
param(
  [switch]$AsClaude,
  [switch]$Uninstall,
  [string]$BinDir = "$env:LOCALAPPDATA\claudex\bin"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Uninstall) {
  Remove-Item -Force -ErrorAction SilentlyContinue "$BinDir\claudex.cmd"
  $shim = "$BinDir\claude.cmd"
  if ((Test-Path $shim) -and (Select-String -Path $shim -Pattern 'CLAUDEX_SHIM' -Quiet)) {
    Remove-Item -Force $shim
    Write-Host "removed the claude shim"
  }
  Write-Host "removed $BinDir\claudex.cmd"
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node is required (>= 20)" }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { throw "node >= 20 is required (found $(& node -v))" }

Write-Host "building..."
Push-Location $root
try {
  & npm install --silent --no-audit --no-fund
  & npm run build --silent
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

@"
@echo off
rem CLAUDEX_SHIM
node "$root\bin\claudex.js" %*
"@ | Set-Content -Encoding ASCII "$BinDir\claudex.cmd"
Write-Host "installed $BinDir\claudex.cmd"

if ($AsClaude) {
  # Find the real claude, ignoring anything already inside our bin directory.
  $realClaude = (Get-Command claude -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and (Split-Path -Parent $_.Source) -ne $BinDir } |
    Select-Object -First 1).Source

  if (-not $realClaude) {
    Write-Warning "could not find the real claude binary outside $BinDir"
    Write-Warning "set claude_path in your claudex config before using the shim"
    $realClaude = ""
  } else {
    Write-Host "real claude: $realClaude"
  }

  @"
@echo off
rem CLAUDEX_SHIM
rem Shadows the real Claude CLI. claudex skips every executable carrying the
rem marker above when resolving the real binary, so this cannot recurse.
if "%CLAUDEX_CLAUDE_BIN%"=="" set CLAUDEX_CLAUDE_BIN=$realClaude
node "$root\bin\claudex.js" %*
"@ | Set-Content -Encoding ASCII "$BinDir\claude.cmd"
  Write-Host "installed $BinDir\claude.cmd (shim)"
  Write-Host ""
  Write-Host "Make sure $BinDir comes before the real claude on your PATH."
  Write-Host "Undo at any time with: .\install.ps1 -Uninstall"
}

if ($env:PATH -notlike "*$BinDir*") {
  Write-Host ""
  Write-Host "note: $BinDir is not on your PATH; add it with:"
  Write-Host "  setx PATH `"$BinDir;%PATH%`""
}

Write-Host ""
Write-Host "next: claudex init; claudex health"
