/**
 * Is APP_URL actually this server, as seen from the public internet?
 *
 * A syntactically valid https:// URL is not proof of reachability — NAT, a
 * shared-IP provider gateway (e.g. Traefik routing by registered hostname), or
 * a firewall can all accept the TCP connection and return a plausible-looking
 * response (even a 404) from something that is NOT this application. Hitting
 * our own /api/health and checking its exact, distinctive JSON shape tells
 * "reached us" apart from "reached someone else at that IP"; a generic 404
 * cannot fake it.
 *
 * Both channels depend on this and fail differently when it is wrong: Telegram
 * degrades to long-polling and keeps working, while Instagram — which Meta can
 * only deliver by push — goes completely silent with no error anywhere.
 */
export async function isPubliclyReachable(appUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: string; db?: string } | null;
    return typeof body?.status === 'string' && typeof body?.db === 'string';
  } catch {
    return false;
  }
}
