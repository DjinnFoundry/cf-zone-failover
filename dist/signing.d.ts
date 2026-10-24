/**
 * Signed hand-off between the reserve proxy and the origin.
 *
 * While the primary zone's IPs are blocked, the public hostnames point at a
 * Cloudflare for SaaS custom hostname on a reserve zone (other IPs). The
 * reserve Worker forwards every request to the origin through `originHost`, a
 * Custom Domain of the main Worker in the primary zone. It cannot use the
 * public hostname itself: during a block that name resolves to the reserve and
 * the request would loop.
 *
 * The proxy signs the request with a shared secret and passes the public host
 * and the visitor's IP. The origin checks the signature and rewrites the
 * request as if it had arrived at its public host, so absolute redirects,
 * cookies and per-IP rate limits keep working and the app never knows.
 *
 * No dependencies: every Worker that imports this bundles it its own way.
 */
export interface SigningConfig {
    /** Custom Domain of the main Worker that the reserve forwards to, e.g. `origin.example.com`. */
    originHost: string;
    /** Public hostnames the reserve may serve. The first one is the default. */
    publicHosts: readonly string[];
    /**
     * Extra hostnames served as `publicHosts[0]`, such as a permanent health
     * check on the reserve (`reserve-check.example.com`).
     */
    testHostPattern?: RegExp;
    /** Prefix of the hand-off headers. Default `x-zone-failover`. */
    headerPrefix?: string;
}
export interface FallbackHeaders {
    secret: string;
    publicHost: string;
    clientIp: string;
}
export interface Signing {
    headers: FallbackHeaders;
    /** On the reserve: the signed request for the origin, or `null` if the host is not ours. */
    toFallbackOrigin(request: Request, secret: string): Request | null;
    /**
     * On the origin: `null` if the request did not come through `originHost`;
     * the request rewritten to its public host if the signature is good; a 404
     * otherwise, so the app is never served under a name only the reserve uses.
     */
    fromFallbackProxy(request: Request, secret: string | undefined): Request | Response | null;
}
/** `duplex` is required by undici (tests) for streamed bodies; Workers ignores it. */
export type StreamingRequestInit = RequestInit & {
    duplex?: 'half';
};
export declare function createSigning(config: SigningConfig): Signing;
