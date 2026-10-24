import { type FailoverConfig, type HostConfig, type SiteConfig } from './config.js';
import { type Signing } from './signing.js';
/** The proxy reads each site's secret by name: `FALLBACK_SECRET_<ID>` or the site's `secretEnv`. */
export type ProxyEnv = Record<string, unknown>;
interface Route {
    site: SiteConfig;
    host: HostConfig;
    /** Only `worker` hosts: the signed hand-off to their origin. */
    signing?: Signing;
}
/** Public hostname → how to reach it. A site's test hostnames route as its first host. */
export declare function proxyRoutes(sites: readonly SiteConfig[]): (hostname: string) => Route | null;
/**
 * The reserve Worker: routed on the reserve zone, it serves every configured
 * public hostname from its target and returns the response as is.
 */
export declare function createFailoverProxy(config: FailoverConfig): {
    fetch(request: Request, env: ProxyEnv): Promise<Response>;
};
export {};
