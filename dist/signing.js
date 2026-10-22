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
const notFound = () => new Response('Not Found', { status: 404 });
/** Constant-time comparison for strings of the same length. */
function sameSecret(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
export function createSigning(config) {
    const { originHost, publicHosts, testHostPattern } = config;
    if (publicHosts.length === 0)
        throw new Error('createSigning: publicHosts is empty');
    const prefix = config.headerPrefix ?? 'x-zone-failover';
    const headers = {
        secret: `${prefix}-fallback-secret`,
        publicHost: `${prefix}-public-host`,
        clientIp: `${prefix}-client-ip`,
    };
    const publicHostFor = (host) => {
        if (publicHosts.includes(host))
            return host;
        return testHostPattern?.test(host) ? publicHosts[0] : null;
    };
    function toFallbackOrigin(request, secret) {
        const url = new URL(request.url);
        const publicHost = publicHostFor(url.hostname);
        if (!publicHost)
            return null;
        const forwarded = new Headers(request.headers);
        forwarded.set(headers.secret, secret);
        forwarded.set(headers.publicHost, publicHost);
        const clientIp = request.headers.get('cf-connecting-ip');
        if (clientIp)
            forwarded.set(headers.clientIp, clientIp);
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
        const init = {
            method: request.method,
            headers: forwarded,
            body: hasBody ? request.body : undefined,
            // Redirects go back to the visitor untouched.
            redirect: 'manual',
            duplex: hasBody ? 'half' : undefined,
        };
        return new Request(`https://${originHost}${url.pathname}${url.search}`, init);
    }
    function fromFallbackProxy(request, secret) {
        const url = new URL(request.url);
        if (url.hostname !== originHost)
            return null;
        const signature = request.headers.get(headers.secret);
        const publicHost = request.headers.get(headers.publicHost);
        if (!secret || !signature || !sameSecret(signature, secret))
            return notFound();
        if (!publicHost || !publicHosts.includes(publicHost))
            return notFound();
        const rewritten = new Headers(request.headers);
        const clientIp = rewritten.get(headers.clientIp);
        for (const header of Object.values(headers))
            rewritten.delete(header);
        if (clientIp)
            rewritten.set('cf-connecting-ip', clientIp);
        // Frameworks build the URL from Host. Left as the origin's, every
        // middleware rewrite looks external and the Worker fetches itself over the
        // internet (OpenNext: 404 served as 200 on Next 15, 522 on Next 16).
        rewritten.set('host', publicHost);
        url.hostname = publicHost;
        const init = {
            method: request.method,
            headers: rewritten,
            body: request.body,
            redirect: request.redirect,
            duplex: request.body ? 'half' : undefined,
        };
        return new Request(url, init);
    }
    return { headers, toFallbackOrigin, fromFallbackProxy };
}
