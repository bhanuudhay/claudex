<#
.SYNOPSIS
  claudex installer (Windows).

.DESCRIPTION
  Installs the `claudex` command, and optionally a `claude.cmd` shim that
  shadows the real CLI so existing commands gain failover without being retyped.

  The shim is written to its own directory, never next to the real binary: the
  real `claude` entry is often a link into a versioned install directory, and
  writing over it would destroy the CLI.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -AsClaude
  .\install.ps1 -Uninstall
#>
param(
  [switch]$AsClaude,
  [switch]$Uninstall,
  [string]$BinDir = "$env:LOCALAPPDATA\claudex\bin",
  [string]$ShimDir = "$env:LOCALAPPDATA\claudex\shim"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Remove-IfOurs {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $item = Get-Item $Path -Force
  if ($item.LinkType) {
    Write-Warning "refusing to remove $Path : it is a link, not a claudex shim"
    return
  }
  if (Select-String -Path $Path -Pattern 'CLAUDEX_SHIM' -Quiet) {
    Remove-Item -Force $Path
  } else {
    Write-Warning "refusing to remove $Path : not a claudex shim"
  }
}

if ($Uninstall) {
  Remove-IfOurs "$BinDir\claudex.cmd"
  Remove-IfOurs "$ShimDir\claude.cmd"
  Write-Host "uninstalled"
  Write-Host "remove $ShimDir from your PATH if you added it"
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node is required (>= 20)" }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { throw "node >= 20 is required (found $(& node -v))" }

if ($env:CLAUDEX_SKIP_BUILD -eq '1') {
  Write-Host "skipping build (CLAUDEX_SKIP_BUILD=1)"
} else {
  Write-Host "building..."
  Push-Location $root
  try {
    & npm install --silent --no-audit --no-fund
    & npm run build --silent
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# Remove first: the target may be a link, and redirection would write through it.
Remove-Item -Force -ErrorAction SilentlyContinue "$BinDir\claudex.cmd"
@"
@echo off
rem CLAUDEX_SHIM
node "$root\bin\claudex.js" %*
"@ | Set-Content -Encoding ASCII "$BinDir\claudex.cmd"
Write-Host "installed $BinDir\claudex.cmd"

if ($AsClaude) {
  # Resolve the real CLI before creating anything, ignoring our own shim dir,
  # and follow links so the recorded path cannot be re-shimmed later.
  $candidate = (Get-Command claude -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and (Split-Path -Parent $_.Source) -ne $ShimDir } |
    Select-Object -First 1).Source

  if (-not $candidate) {
    throw "could not find the real claude binary; install the Claude CLI first, or set claude_path in your claudex config"
  }
  $realClaude = & node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' $candidate

  if (Select-String -Path $realClaude -Pattern 'CLAUDEX_SHIM' -Quiet -ErrorAction SilentlyContinue) {
    throw "the claude on your PATH is already a claudex shim: $realClaude — run .\install.ps1 -Uninstall first"
  }
  & $realClaude --version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "found $realClaude but it did not run; refusing to shim a broken install"
  }
  Write-Host "real claude: $realClaude"

  New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
  Remove-Item -Force -ErrorAction SilentlyContinue "$ShimDir\claude.cmd"
  @"
@echo off
rem CLAUDEX_SHIM
rem Shadows the real Claude CLI. The real binary is recorded below, resolved at
rem install time, so resolution never has to search a PATH containing this shim.
if "%CLAUDEX_CLAUDE_BIN%"=="" set CLAUDEX_CLAUDE_BIN=$realClaude
node "$root\bin\claudex.js" %*
"@ | Set-Content -Encoding ASCII "$ShimDir\claude.cmd"
  Write-Host "installed $ShimDir\claude.cmd (shim)"
  Write-Host ""
  Write-Host "Add the shim directory to the FRONT of your PATH:"
  Write-Host "  setx PATH `"$ShimDir;%PATH%`""
  Write-Host "Undo at any time with: .\install.ps1 -Uninstall"
}

if ($env:PATH -notlike "*$BinDir*") {
  Write-Host ""
  Write-Host "note: $BinDir is not on your PATH; add it with:"
  Write-Host "  setx PATH `"$BinDir;%PATH%`""
}

Write-Host ""
Write-Host "next: claudex init; claudex health"
