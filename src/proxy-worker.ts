import type { Signing } from './signing.js';

export interface ProxyEnv {
  /** Shared with the origin Worker(s). */
  FALLBACK_PROXY_SECRET?: string;
}

/**
 * The reserve Worker: routed on the reserve zone, it forwards every request for
 * one of our hostnames to the origin, signed, and returns the response as is.
 */
export function createFallbackProxy(signing: Signing) {
  return {
    async fetch(request: Request, env: ProxyEnv): Promise<Response> {
      if (!env.FALLBACK_PROXY_SECRET) {
        console.error('[cf-zone-failover] FALLBACK_PROXY_SECRET is not set');
        return new Response('Server misconfigured', { status: 500 });
      }
      const origin = signing.toFallbackOrigin(request, env.FALLBACK_PROXY_SECRET);
      if (!origin) return new Response('Not Found', { status: 404 });
      return fetch(origin);
    },
  };
}
