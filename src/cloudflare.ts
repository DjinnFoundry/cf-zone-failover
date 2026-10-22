const API = 'https://api.cloudflare.com/client/v4';

/** Minimal Cloudflare API client: returns `result` or throws with the errors. */
export type CfApi = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export function cfApi(token: string, fetcher: typeof fetch = fetch): CfApi {
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetcher(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // Some DELETEs answer with an empty body on success.
    if (!text) {
      if (res.ok) return undefined as T;
      throw new Error(`${method} ${path}: HTTP ${res.status}`);
    }
    const json = JSON.parse(text) as { success: boolean; result: T; errors?: { message: string }[] };
    if (!res.ok || !json.success) {
      throw new Error(`${method} ${path}: ${json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`}`);
    }
    return json.result;
  };
}
