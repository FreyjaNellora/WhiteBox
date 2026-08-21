# Setup — Mycelium

A customized **SearXNG** JSON engine (`searxng/`, port 8888) behind a small Flask **face**
(`server.py`, port 8890) that adds the credibility ranking, live-events, and quote-miner UI. Both
bind to `127.0.0.1` only.

*(For the companion microphone, see [`../companion-mic/README.md`](../companion-mic/README.md).)*

### Prerequisites
- Python 3.10+ and `git`.
- Windows gets a one-click launcher; Linux/macOS run the two processes directly.

### 1. Get the code
```
git clone <this-repo-url>
cd <repo>/mycelium
```

### 2. Create the SearXNG virtualenv and install deps
```
cd searxng
python -m venv venv
# Windows:
venv\Scripts\pip install -e .     &&  venv\Scripts\pip install httpx flask
# Linux/macOS:
venv/bin/pip install -e .         &&  venv/bin/pip install httpx flask
cd ..
```
(SearXNG pulls in Flask; the face additionally needs `httpx`. If a module turns up missing on first
run, `pip install` it into the same venv.)

### 3. Set your own secret_key  (REQUIRED)
Open `searxng/my-settings.yml` and replace the `secret_key` placeholder with a random value from:
```
python -c "import secrets; print(secrets.token_hex(32))"
```
This signs local session data — keep it private, don't reuse anyone else's.

### 4. Run it
- **Windows:** right-click `start-mycelium.ps1` (in this folder) → *Run with PowerShell*. It
  starts both servers (logging silenced) and opens the browser.
- **Linux/macOS / manual:** from this `mycelium/` folder, in two terminals —
  ```
  SEARXNG_SETTINGS_PATH=$PWD/searxng/my-settings.yml  searxng/venv/bin/python searxng/run_engine.py
  searxng/venv/bin/python server.py
  ```
Then open <http://127.0.0.1:8890>.

### 5. (Optional) Reach it from your phone
Mycelium is **not** exposed to the internet for you. To use it away from your desk, put the
PC and phone on **your own** [Tailscale](https://tailscale.com) tailnet and browse to the PC's
tailnet address on port 8890. Before exposing it beyond localhost, set an auth token first:
```
setx MYCELIUM_AUTH_TOKEN "<a-long-random-string>"     # Windows (open a new shell after)
export MYCELIUM_AUTH_TOKEN="<a-long-random-string>"   # Linux/macOS
```
The UI sends it via the `X-Mycelium-Token` header (read from the `#token=` URL fragment, so it
never lands in server logs).

### Erase history
`wipe-history.ps1` clears every on-disk trace derived from your queries (caches, the navigation
graph, the quote-miner quarantine). Add `-All` to also drop the public GDELT events mirror.
