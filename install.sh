#!/usr/bin/env bash
#
# WhiteBox one-shot installer for macOS / Linux.
#
# What this does:
#   1. Checks for Node.js (installs nothing — points you to nodejs.org if missing).
#   2. Builds the CLI (`whitebox`).
#   3. Builds the MCP server.
#   4. Prints the next steps for the browser extension and MCP client config.
#
# What this does NOT do:
#   - Install Node.js (we don't want to mess with your system package manager).
#   - Edit your Claude Desktop config automatically (too much variance per OS;
#     we print exactly what to paste).
#   - Install the browser extension (Chrome's developer-mode flow is manual
#     because no Chrome Web Store listing yet).
#
# Run from the repo root: bash install.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

echo -e "${BOLD}WhiteBox installer${RESET}"
echo "Repo: $REPO_ROOT"
echo

# 1. Node.js check
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Node.js is not installed.${RESET}"
  echo "Install Node.js 18+ from https://nodejs.org and re-run this script."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${RED}Node.js $NODE_MAJOR is too old.${RESET} Need 18+. Upgrade from https://nodejs.org and re-run."
  exit 1
fi

echo -e "${GREEN}✓${RESET} Node.js $(node -v) detected"
echo

# 2. CLI build
echo -e "${BOLD}Building the CLI…${RESET}"
cd "$REPO_ROOT/whitebox-cli"
npm install --silent
npm run build --silent
cd "$REPO_ROOT"
echo -e "${GREEN}✓${RESET} CLI built at: $REPO_ROOT/whitebox-cli/bin/whitebox.js"
echo

# 3. MCP build
echo -e "${BOLD}Building the MCP server…${RESET}"
cd "$REPO_ROOT/whitebox-mcp"
npm install --silent
npm run build --silent
cd "$REPO_ROOT"
echo -e "${GREEN}✓${RESET} MCP server built at: $REPO_ROOT/whitebox-mcp/dist/index.js"
echo

# 4. Detect a sensible default vault path
DEFAULT_VAULT="$HOME/whitebox-vault"
echo -e "${BOLD}Next steps${RESET}"
echo
echo -e "${YELLOW}Step A — Create your vault (or skip if you'll use the extension wizard):${RESET}"
echo "    node $REPO_ROOT/whitebox-cli/bin/whitebox.js init $DEFAULT_VAULT"
echo
echo -e "${YELLOW}Step B — Browser extension:${RESET}"
echo "    1. Open chrome://extensions in Chrome / Edge / Brave / Arc"
echo "    2. Toggle 'Developer mode' (top right)"
echo "    3. Click 'Load unpacked' and pick this folder:"
echo "         $REPO_ROOT/whitebox-extension"
echo "    4. Pin the WhiteBox icon to your toolbar"
echo "    5. Click the icon → 'Open setup…' and walk through the wizard"
echo "       (the wizard creates the vault for you if you don't have one yet)"
echo
echo -e "${YELLOW}Step C — Claude Desktop / Code / Cursor (MCP) — optional:${RESET}"
echo "    Add this to your MCP config (Claude Desktop:"
echo "    ~/Library/Application Support/Claude/claude_desktop_config.json on macOS,"
echo "    %APPDATA%\\Claude\\claude_desktop_config.json on Windows):"
echo
cat <<EOF
    {
      "mcpServers": {
        "whitebox": {
          "command": "node",
          "args": ["$REPO_ROOT/whitebox-mcp/dist/index.js"],
          "env": {
            "WHITEBOX_VAULT_ROOT": "$DEFAULT_VAULT"
          }
        }
      }
    }
EOF
echo
echo "    Then restart Claude Desktop. You should see seven WhiteBox tools."
echo
echo -e "${YELLOW}Step D — Claude Code skill (optional):${RESET}"
echo "    mkdir -p ~/.claude/skills && cp -r $REPO_ROOT/claude-code-skills/whitebox ~/.claude/skills/"
echo
echo -e "${GREEN}${BOLD}Done.${RESET} See INSTALL_FOR_FRIENDS.md for the friendliest version of these steps."
