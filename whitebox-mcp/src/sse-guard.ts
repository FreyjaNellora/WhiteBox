/**
 * MEM-1: guards for the optional SSE/HTTP transport.
 *
 * The SSE transport exposes vault tools over HTTP. Without these it has no auth
 * and CORS `*`, so anyone who can reach the port (or a browser tricked via DNS
 * rebinding) can call vault tools. Three pure defenses, unit-tested here and
 * wired into the server in index.ts:
 *
 *   - refuseWideOpen — never serve the vault unauthenticated on a non-loopback
 *     interface (binding 0.0.0.0 without a token would expose it to the LAN).
 *   - buildAllowedHosts / isHostAllowed — Host-header allow-list. A browser
 *     DNS-rebound to this server keeps the attacker's Host header, which won't
 *     match, so it's rejected ("localhost is not a security boundary").
 *   - isAuthorized — optional bearer token (WHITEBOX_SSE_TOKEN) on every request.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/**
 * True when starting the SSE server would expose the vault unauthenticated on a
 * LAN-reachable interface. The caller should refuse to start in that case.
 */
export function refuseWideOpen(hostFlag: string, token: string | null): boolean {
  return !isLoopbackHost(hostFlag) && !token;
}

export function buildAllowedHosts(
  hostFlag: string,
  port: number,
  extra?: string | null,
): Set<string> {
  const hosts = [
    `${hostFlag}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    ...(extra || "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
  ];
  return new Set(hosts.map((h) => h.toLowerCase()));
}

export function isHostAllowed(
  hostHeader: string | undefined,
  allowed: Set<string>,
): boolean {
  if (!hostHeader) return false;
  return allowed.has(hostHeader.trim().toLowerCase());
}

/**
 * Constant-time-ish bearer-token check. When no token is configured the SSE
 * transport is in local/unauthenticated mode (only reachable from loopback,
 * enforced by refuseWideOpen) and this returns true.
 */
export function isAuthorized(
  authHeader: string | undefined,
  token: string | null,
): boolean {
  if (!token) return true;
  if (!authHeader) return false;
  const expected = `Bearer ${token}`;
  if (authHeader.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
