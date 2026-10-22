import type { Signing } from './signing.js';
export interface ProxyEnv {
    /** Shared with the origin Worker(s). */
    FALLBACK_PROXY_SECRET?: string;
}
/**
 * The reserve Worker: routed on the reserve zone, it forwards every request for
 * one of our hostnames to the origin, signed, and returns the response as is.
 */
export declare function createFallbackProxy(signing: Signing): {
    fetch(request: Request, env: ProxyEnv): Promise<Response>;
};
