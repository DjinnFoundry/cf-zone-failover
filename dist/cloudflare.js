const API = 'https://api.cloudflare.com/client/v4';
export function cfApi(token, fetcher = fetch) {
    return async (method, path, body) => {
        const res = await fetcher(`${API}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        // Some DELETEs answer with an empty body on success.
        if (!text) {
            if (res.ok)
                return undefined;
            throw new Error(`${method} ${path}: HTTP ${res.status}`);
        }
        const json = JSON.parse(text);
        if (!res.ok || !json.success) {
            throw new Error(`${method} ${path}: ${json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`}`);
        }
        return json.result;
    };
}
