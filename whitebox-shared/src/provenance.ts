/**
 * MEM-3: authoritative provenance for observations.
 *
 * An observation's `source` records which agent learned the fact; downstream
 * trust/ranking weights it. If the source were taken from the caller's argument
 * unchecked, one agent could forge another agent's provenance and poison the
 * shared memory (durable, cross-session). `resolveObservationSource` centralizes
 * the policy:
 *
 *   - When the MCP server is launched with a pinned identity (the
 *     `WHITEBOX_SOURCE` env, set by whoever spawns the agent), that identity is
 *     authoritative and the caller's `source` argument cannot override it.
 *   - Otherwise (local single-user use, no pinned identity) the caller's claim
 *     is used, prefixed `mcp:` so it is at least annotated as MCP-originated.
 */

function withMcpPrefix(source: string): string {
  const s = source.trim();
  return s.startsWith("mcp:") ? s : `mcp:${s}`;
}

export interface ResolvedSource {
  /** The source string to stamp on the observation. */
  stamped: string;
  /** True when a pinned server identity overrode a differing caller claim. */
  pinned: boolean;
}

/**
 * @param claimedSource    the `source` the caller supplied.
 * @param configuredSource the server-pinned identity (`WHITEBOX_SOURCE`), or
 *                         null/undefined/empty when none is configured.
 */
export function resolveObservationSource(
  claimedSource: string,
  configuredSource: string | null | undefined,
): ResolvedSource {
  const claimed = withMcpPrefix(claimedSource);
  if (configuredSource && configuredSource.trim().length > 0) {
    const pinnedSource = withMcpPrefix(configuredSource);
    return { stamped: pinnedSource, pinned: pinnedSource !== claimed };
  }
  return { stamped: claimed, pinned: false };
}
