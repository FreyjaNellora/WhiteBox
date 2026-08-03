# whitebox-shared

Core library for WhiteBox vault operations. **Zero external dependencies.**

This is the substrate the other surfaces build on — the [MCP server](../whitebox-mcp/),
the [CLI](../whitebox-cli/), and the [browser extension](../whitebox-extension/) all rely on it
rather than reimplementing vault logic.

At a capability level it provides:

- **Audit chain** — a tamper-evident, append-only record of vault reads and writes.
- **Scope enforcement** — asymmetric, per-source access grants over vault regions.
- **Merge / promotion** — weighted cross-source promotion and demotion of observations toward
  stable facts, and synthesis over them.
- **Search** — retrieval over active and passive memory.
- **Path security** — validation of all vault I/O against traversal and out-of-scope access.

For the data model these operate on, see the schema in [`spec/`](../spec/). For the security
properties behind these capabilities, see [`SECURITY.md`](../SECURITY.md) and
[`docs/threat-model.md`](../docs/threat-model.md).
