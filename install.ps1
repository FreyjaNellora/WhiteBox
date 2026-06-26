# WhiteBox one-shot installer for Windows.
#
# What this does:
#   1. Checks for Node.js (installs nothing — points you to nodejs.org if missing).
#   2. Builds the CLI (`whitebox`).
#   3. Builds the MCP server.
#   4. Prints the next steps for the browser extension and MCP client config.
#
# Run from PowerShell in the repo root:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

function Section($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Ok($text)      { Write-Host "OK  $text" -ForegroundColor Green }
function Warn($text)    { Write-Host "!! $text" -ForegroundColor Yellow }
function Fail($text)    { Write-Host "XX $text" -ForegroundColor Red; exit 1 }

Write-Host "WhiteBox installer" -ForegroundColor White
Write-Host "Repo: $RepoRoot"

# 1. Node.js check
$nodeOk = $false
try {
  $nodeVersion = (node -v)
  $major = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
  if ($major -ge 18) {
    Ok "Node.js $nodeVersion detected"
    $nodeOk = $true
  } else {
    Fail "Node.js $nodeVersion is too old. Need 18+. Upgrade from https://nodejs.org and re-run."
  }
} catch {
  Fail "Node.js is not installed. Install Node.js 18+ from https://nodejs.org and re-run this script."
}

# 2. CLI build
Section "Building the CLI..."
Set-Location "$RepoRoot\whitebox-cli"
npm install --silent | Out-Null
npm run build --silent | Out-Null
Set-Location $RepoRoot
Ok "CLI built at: $RepoRoot\whitebox-cli\bin\whitebox.js"

# 3. MCP build
Section "Building the MCP server..."
Set-Location "$RepoRoot\whitebox-mcp"
npm install --silent | Out-Null
npm run build --silent | Out-Null
Set-Location $RepoRoot
Ok "MCP server built at: $RepoRoot\whitebox-mcp\dist\index.js"

# 4. Next-steps printout
$DefaultVault = Join-Path $env:USERPROFILE "whitebox-vault"

Section "Next steps"

Write-Host ""
Write-Host "Step A - Create your vault (or skip if you will use the extension wizard):"
Write-Host "    node `"$RepoRoot\whitebox-cli\bin\whitebox.js`" init `"$DefaultVault`""

Write-Host ""
Write-Host "Step B - Browser extension:"
Write-Host "    1. Open chrome://extensions in Chrome / Edge / Brave / Arc"
Write-Host "    2. Toggle 'Developer mode' (top right)"
Write-Host "    3. Click 'Load unpacked' and pick this folder:"
Write-Host "         $RepoRoot\whitebox-extension"
Write-Host "    4. Pin the WhiteBox icon to your toolbar"
Write-Host "    5. Click the icon, then 'Open setup...' and walk through the wizard"
Write-Host "       (the wizard creates the vault for you if you don't have one yet)"

Write-Host ""
Write-Host "Step C - Claude Desktop / Code / Cursor (MCP) - optional:"
Write-Host "    Add this to your MCP config:"
Write-Host "      Claude Desktop on Windows: %APPDATA%\Claude\claude_desktop_config.json"
Write-Host ""
$mcpEntry = @"
    {
      "mcpServers": {
        "whitebox": {
          "command": "node",
          "args": ["$($RepoRoot -replace '\\','\\\\')\\whitebox-mcp\\dist\\index.js"],
          "env": {
            "WHITEBOX_VAULT_ROOT": "$($DefaultVault -replace '\\','\\\\')"
          }
        }
      }
    }
"@
Write-Host $mcpEntry
Write-Host ""
Write-Host "    Then restart Claude Desktop. You should see seven WhiteBox tools."

Write-Host ""
Write-Host "Step D - Claude Code skill (optional):"
Write-Host "    Copy-Item -Recurse `"$RepoRoot\claude-code-skills\whitebox`" `"$env:USERPROFILE\.claude\skills\whitebox`""

Write-Host ""
Ok "Done. See INSTALL_FOR_FRIENDS.md for the friendliest version of these steps."
