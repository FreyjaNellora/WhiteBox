#!/usr/bin/env bash
#
# WhiteBox uninstaller for macOS / Linux.
#
# What this removes:
#   - Built CLI artifacts (whitebox-cli/dist, node_modules)
#   - Built MCP artifacts (whitebox-mcp/dist, node_modules)
#   - Optional: Claude Code skill at ~/.claude/skills/whitebox
#
# What this does NOT remove (you keep these):
#   - Your vault folder anywhere on disk. WhiteBox never deletes user data.
#     If you want to delete it, do so manually: rm -rf <your-vault-path>
#   - The repo itself (this folder). Delete it manually if you want.
#   - The browser extension. Open chrome://extensions and click Remove.
#   - The MCP server entry in Claude Desktop's config. We won't auto-edit
#     your JSON config (risk of corrupting it). Snippet to remove printed below.
#
# Run from the repo root: bash uninstall.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

echo -e "${BOLD}WhiteBox uninstaller${RESET}"
echo "Repo: $REPO_ROOT"
echo
echo -e "${YELLOW}Your vault folder will NOT be touched. Files stay yours.${RESET}"
echo

read -r -p "Remove built CLI + MCP artifacts and node_modules? [y/N] " resp
if [[ "$resp" =~ ^[Yy]$ ]]; then
  if [ -d "$REPO_ROOT/whitebox-cli/dist" ]; then
    rm -rf "$REPO_ROOT/whitebox-cli/dist"
    echo -e "  ${GREEN}✓${RESET} removed whitebox-cli/dist"
  fi
  if [ -d "$REPO_ROOT/whitebox-cli/node_modules" ]; then
    rm -rf "$REPO_ROOT/whitebox-cli/node_modules"
    echo -e "  ${GREEN}✓${RESET} removed whitebox-cli/node_modules"
  fi
  if [ -d "$REPO_ROOT/whitebox-mcp/dist" ]; then
    rm -rf "$REPO_ROOT/whitebox-mcp/dist"
    echo -e "  ${GREEN}✓${RESET} removed whitebox-mcp/dist"
  fi
  if [ -d "$REPO_ROOT/whitebox-mcp/node_modules" ]; then
    rm -rf "$REPO_ROOT/whitebox-mcp/node_modules"
    echo -e "  ${GREEN}✓${RESET} removed whitebox-mcp/node_modules"
  fi
fi

echo
read -r -p "Remove Claude Code skill at ~/.claude/skills/whitebox? [y/N] " resp
if [[ "$resp" =~ ^[Yy]$ ]]; then
  if [ -d "$HOME/.claude/skills/whitebox" ]; then
    rm -rf "$HOME/.claude/skills/whitebox"
    echo -e "  ${GREEN}✓${RESET} removed ~/.claude/skills/whitebox"
  else
    echo "  (~/.claude/skills/whitebox not present — nothing to remove)"
  fi
fi

echo
echo -e "${BOLD}Manual steps remaining:${RESET}"
echo
echo -e "${YELLOW}1. Browser extension${RESET}"
echo "    Open chrome://extensions, find WhiteBox, click Remove."
echo "    For a complete reset before removal, click the WhiteBox icon →"
echo "    'Reset extension state…' in the popup. Removes vault grant,"
echo "    settings, passphrase, lock state — all without touching your vault."
echo
echo -e "${YELLOW}2. Claude Desktop MCP config${RESET}"
echo "    Open your config file:"
echo "      macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "      Linux:   ~/.config/Claude/claude_desktop_config.json"
echo "    Remove the 'whitebox' entry from the 'mcpServers' object. Restart Claude Desktop."
echo
echo -e "${YELLOW}3. Your vault folder${RESET}"
echo "    Stays yours. WhiteBox never deletes it. If you want to delete it:"
echo "      rm -rf <path-to-your-vault-folder>"
echo "    Otherwise, your observations, audit log, and conversations stay"
echo "    intact and openable in any text editor."
echo
echo -e "${YELLOW}4. The repo itself${RESET}"
echo "    Delete this folder manually if you want it gone:"
echo "      rm -rf $REPO_ROOT"
echo
echo -e "${GREEN}${BOLD}Done.${RESET} See UNINSTALL.md for the full walkthrough."
