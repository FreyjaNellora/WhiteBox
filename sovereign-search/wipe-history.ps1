# Wipe local Sovereign Search history.
#
# "Sovereign" means the data is yours to erase. This clears EVERY on-disk store that is
# derived from what YOU searched / navigated:
#   * cache\events   - your live GDELT event-query cache (keyed by your query)
#   * cache\court    - your CourtListener query cache (keyed by your query)
#   * cache\navgraph - the link graph + the "vocabulary of associations" (graph.db). This is
#                      a record of the pages you navigated and the terms your walks learned,
#                      so a real "wipe history" MUST clear it too. Wiping resets learned assoc.
#   * quarantine\    - quote-miner output (pending + verified). These .md files are built directly
#                      from your queries and the pages fetched for them (verbatim quotes, source
#                      URLs, timestamps), so they count as search history. Move any you want to
#                      KEEP out of quarantine\ before wiping.
#   * *.log          - stray logs (query logging is already silenced, so normally none exist)
#
# NOT cleared by default: cache\gdelt (events.db) is a public-events MIRROR the background
# refresher pulls on a timer independent of your queries — it is not a record of what you
# searched. Pass -All to wipe that too for a full cold reset.
#
# Your BROWSER keeps its own history separately — clear that in the browser (or use a private tab).

param([switch]$All)

$sov = $PSScriptRoot   # this script lives in the sovereign-search folder

function Wipe-Dir($path) {
    if (Test-Path $path) {
        $c = (Get-ChildItem $path -File -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
        Remove-Item "$path\*" -Recurse -Force -ErrorAction SilentlyContinue
        return $c
    }
    return 0
}

$events = Wipe-Dir "$sov\cache\events"
$court  = Wipe-Dir "$sov\cache\court"
# navgraph: remove graph.db and its WAL/SHM sidecars (the walker recreates a fresh empty graph)
$nav = 0
if (Test-Path "$sov\cache\navgraph") {
    $nav = (Get-ChildItem "$sov\cache\navgraph" -File -ErrorAction SilentlyContinue | Measure-Object).Count
    # explicit SQLite files only (graph.db + WAL/SHM sidecars) — a bare graph.db* wildcard would also
    # eat user backups like graph.db.backup / graph.db.2026-07-15
    Remove-Item "$sov\cache\navgraph\graph.db","$sov\cache\navgraph\graph.db-wal","$sov\cache\navgraph\graph.db-shm" -Force -ErrorAction SilentlyContinue
}

# quarantine: quote-miner output derived directly from your queries -> wiped by default
$quar = (Wipe-Dir "$sov\quarantine\pending") + (Wipe-Dir "$sov\quarantine\verified")

$gdelt = 0
if ($All) {
    $gdelt = Wipe-Dir "$sov\cache\gdelt"
}

Get-ChildItem "$sov", "$sov\searxng" -Filter *.log -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  Wiped:" -ForegroundColor Green
Write-Host "    $events event-query cache file(s)"      -ForegroundColor Green
Write-Host "    $court court-query cache file(s)"        -ForegroundColor Green
Write-Host "    navgraph link graph + learned associations ($nav file(s))" -ForegroundColor Green
Write-Host "    $quar quote-miner quarantine file(s) (pending + verified)" -ForegroundColor Green
if ($All) {
    Write-Host "    $gdelt GDELT public-event mirror file(s)  (-All)" -ForegroundColor Green
} else {
    Write-Host "  Kept: cache\gdelt public-event mirror (not query history). Use -All to wipe it too." -ForegroundColor DarkGray
}
Write-Host "  Query logging is off, so nothing new is recorded." -ForegroundColor Green
Write-Host "  (Browser history is separate - clear it in your browser or use a private tab.)" -ForegroundColor DarkGray
Write-Host ""
