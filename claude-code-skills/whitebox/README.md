# WhiteBox Claude Code skill

This folder packages WhiteBox as a Claude Code skill. Drop it into your `~/.claude/skills/` directory (or wherever your Claude Code installation reads skills from) and Claude Code will know how to use the WhiteBox MCP tools.

## Install

```sh
# Adjust paths to your platform
mkdir -p ~/.claude/skills
cp -r claude-code-skills/whitebox ~/.claude/skills/
```

You also need the `whitebox-mcp` MCP server installed and registered in your Claude Code config. See the project README for that setup.

## What this skill does

The `skill.md` in this folder teaches Claude Code:

- When to use the WhiteBox tools (session start, named-entity recognition, durable preference detection)
- The full tool surface (`bootstrap`, `read_file`, `list_files`, `grep`, `append_observation`, `propose_stable_edit`, `list_conflicts`)
- The self-automation pattern — agent owns its own context loop, pulls what it needs
- The discipline rules from `AGENTS.md` (verbatim bodies, anti-characterization, idle-stability)
- The five-grade confidence scale and the autonomous-save acknowledgment format

It's designed to be lightweight — readable in one pass, no hidden state. If your project has a `.claude/CLAUDE.md`, you can also reference this skill from there.

## Status

Pre-alpha. The skill format may evolve as Claude Code's skill system matures. For now it's a single markdown file with frontmatter; that may grow to include example transcripts, tool-use traces, or evaluation harnesses over time.
