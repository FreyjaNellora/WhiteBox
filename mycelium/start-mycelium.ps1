# Mycelium - one-click launcher (portable; paths derive from this file's location).
# Starts BOTH servers (SearXNG engine on :8888 + Mycelium face on :8890), query logging SILENCED,
# then opens the browser. Local + private; bound to 127.0.0.1.
# One-time setup (see README): create the venv at searxng\venv and install requirements,
# then set your own secret_key in searxng\my-settings.yml.
# Start:  right-click > Run with PowerShell.   Stop: close the two minimized windows.

$root = $PSScriptRoot
$repo = "$root\searxng"   # the customized SearXNG engine (subfolder)
$sov  = "$root"           # the face (server.py etc.) lives at this folder's root
$venv = "$repo\venv\Scripts\python.exe"
$env:SEARXNG_SETTINGS_PATH = "$repo\my-settings.yml"

if (-not (Test-Path $venv)) {
    Write-Host "  venv not found at $venv" -ForegroundColor Yellow
    Write-Host "  Run the one-time Setup in the README first (create searxng\venv + install requirements)." -ForegroundColor Yellow
    return
}

Write-Host ""
Write-Host "  Starting Mycelium (engine + face, logging silenced)..." -ForegroundColor Green

# 1) engine (SearXNG, 8888) - silenced wrapper
Start-Process -FilePath $venv -ArgumentList "`"$repo\run_engine.py`"" -WorkingDirectory $repo -WindowStyle Minimized
for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:8888/" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}

# 2) face (Mycelium UI + API, 8890)
Start-Process -FilePath $venv -ArgumentList "`"$sov\server.py`"" -WorkingDirectory $sov -WindowStyle Minimized
for ($i = 0; $i -lt 20; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:8890/" -UseBasicParsing -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}

# 3) catch up recent GDELT events in the background (rolling local mirror; auto-refreshes after)
Start-Process -FilePath $venv -ArgumentList "`"$sov\gdelt_ingest.py`" --hours 24" -WorkingDirectory $sov -WindowStyle Hidden

Start-Process "http://127.0.0.1:8890"
Write-Host ""
Write-Host "  Live:  http://127.0.0.1:8890  (Live Events tab reads your local GDELT mirror)" -ForegroundColor Green
Write-Host "  Phone (optional): expose :8890 over your OWN Tailscale tailnet, then browse to your tailnet URL." -ForegroundColor Green
Write-Host "  Wipe local history anytime: mycelium\wipe-history.ps1" -ForegroundColor DarkGray
Write-Host ""
