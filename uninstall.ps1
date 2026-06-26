# WhiteBox uninstaller for Windows.
#
# What this removes:
#   - Built CLI artifacts (whitebox-cli\dist, node_modules)
#   - Built MCP artifacts (whitebox-mcp\dist, node_modules)
#   - Optional: Claude Code skill at %USERPROFILE%\.claude\skills\whitebox
#
# What this does NOT remove (you keep these):
#   - Your vault folder anywhere on disk. WhiteBox never deletes user data.
#   - The repo itself. Delete manually if you want it gone.
#   - The browser extension. Open chrome://extensions and click Remove.
#   - The MCP server entry in Claude Desktop's config. We won't auto-edit
#     your JSON config (risk of corruption). Snippet to remove printed below.
#
# Run from PowerShell in the repo root:
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

function Section($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Ok($text)      { Write-Host "  OK $text" -ForegroundColor Green }
function Warn($text)    { Write-Host $text -ForegroundColor Yellow }

Write-Host "WhiteBox uninstaller" -ForegroundColor White
Write-Host "Repo: $RepoRoot"
Write-Host ""
Warn "Your vault folder will NOT be touched. Files stay yours."
Write-Host ""

$resp = Read-Host "Remove built CLI + MCP artifacts and node_modules? [y/N]"
if ($resp -match "^[Yy]$") {
  $paths = @(
    "$RepoRoot\whitebox-cli\dist",
    "$RepoRoot\whitebox-cli\node_modules",
    "$RepoRoot\whitebox-mcp\dist",
    "$RepoRoot\whitebox-mcp\node_modules"
  )
  foreach ($p in $paths) {
    if (Test-Path $p) {
      Remove-Item -Recurse -Force $p
      Ok "removed $p"
    }
  }
}

Write-Host ""
$resp = Read-Host "Remove Claude Code skill at ~\.claude\skills\whitebox? [y/N]"
if ($resp -match "^[Yy]$") {
  $skill = Join-Path $env:USERPROFILE ".claude\skills\whitebox"
  if (Test-Path $skill) {
    Remove-Item -Recurse -Force $skill
    Ok "removed $skill"
  } else {
    Write-Host "  (not present)"
  }
}

Section "Manual steps remaining:"

Write-Host ""
Warn "1. Browser extension"
Write-Host "    Open chrome://extensions, find WhiteBox, click Remove."
Write-Host "    For a complete reset before removal, click the WhiteBox icon and"
Write-Host "    'Reset extension state...' in the popup. Removes vault grant,"
Write-Host "    settings, passphrase, lock state — all without touching your vault."

Write-Host ""
Warn "2. Claude Desktop MCP config"
Write-Host "    Open: %APPDATA%\Claude\claude_desktop_config.json"
Write-Host "    Remove the 'whitebox' entry from the 'mcpServers' object. Restart Claude Desktop."

Write-Host ""
Warn "3. Your vault folder"
Write-Host "    Stays yours. WhiteBox never deletes it. To delete it:"
Write-Host "      Remove-Item -Recurse -Force <path-to-your-vault-folder>"
Write-Host "    Otherwise observations, audit log, and conversations stay intact."

Write-Host ""
Warn "4. The repo itself"
Write-Host "    Delete manually if you want it gone:"
Write-Host "      Remove-Item -Recurse -Force `"$RepoRoot`""

Write-Host ""
Ok "Done. See UNINSTALL.md for the full walkthrough."
