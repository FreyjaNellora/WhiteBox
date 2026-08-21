# Modifications to SearXNG (AGPL-3.0 §5(a) change notice)

This directory is a modified copy of **SearXNG** (https://github.com/searxng/searxng), which is
licensed under the **GNU Affero General Public License v3.0** (see `LICENSE`). Per AGPL-3.0 §5(a),
this file records that the work has been changed and the nature of the changes.

## Files we added (not part of upstream SearXNG)
- `my-settings.yml` — our settings overlay (`use_default_settings: true`): localhost bind, credibility
  `hostnames` rules, and the enabled academic / indie-web / people engine set.
- `run_engine.py` — thin launcher that starts `searx.webapp` with the web-server access log filtered
  (so query strings are never logged).
- `README-MYCELIUM.md`, `MODIFICATIONS.md` — this documentation.

## Upstream files changed
- None of the upstream `searx/` source files are modified; all customization is done through the
  overlay settings file above. If that changes, list the touched files and dates here.

## Not included from a full checkout
- `venv/` (local virtualenv), `.git/` history, `*.bak`, `__pycache__/`, and caches — omitted for size
  and privacy; recreate the venv per SETUP.md.

All upstream copyright notices and `AUTHORS.rst` are retained unchanged.

Modifications by the repository owner. Redistributed under the same AGPL-3.0 license.
