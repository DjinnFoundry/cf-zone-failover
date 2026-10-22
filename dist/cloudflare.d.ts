/** Minimal Cloudflare API client: returns `result` or throws with the errors. */
export type CfApi = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
export declare function cfApi(token: string, fetcher?: typeof fetch): CfApi;
