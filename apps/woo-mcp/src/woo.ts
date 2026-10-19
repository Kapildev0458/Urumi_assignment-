// Minimal WooCommerce REST API v3 client. Requests go to the in-cluster WordPress Service but are
// signed against the store's public home URL, because that is what WooCommerce rebuilds when it
// verifies the signature.
import type { Config } from './config.js';
import { signOAuth1 } from './oauth.js';

export class WooError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class WooClient {
  private readonly signatureOrigin: string;
  private gmtOffset: { value: number; fetchedAt: number } | undefined;

  constructor(private readonly config: Config) {
    // The MCP server talks to WordPress directly over HTTP, so WordPress's is_ssl() is false and
    // WooCommerce signs with an http:// home URL even when the public site uses HTTPS.
    const origin = new URL(config.wooPublicUrl);
    origin.protocol = 'http:';
    this.signatureOrigin = origin.toString().replace(/\/+$/, '');
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, {}, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, {}, body);
  }

  /** The store's UTC offset in hours (WordPress gmt_offset), cached for 10 minutes. */
  async storeGmtOffset(): Promise<number> {
    if (this.gmtOffset && Date.now() - this.gmtOffset.fetchedAt < 600_000) {
      return this.gmtOffset.value;
    }
    const index = await this.fetchJson<{ gmt_offset?: number | string }>(
      `${this.config.wooUrl}/wp-json/`,
      { method: 'GET' },
    );
    const value = Number(index.gmt_offset ?? 0) || 0;
    this.gmtOffset = { value, fetchedAt: Date.now() };
    return value;
  }

  private async request<T>(method: string, path: string, query: Query, body?: unknown): Promise<T> {
    const route = `/wp-json/wc/v3/${path.replace(/^\/+/, '')}`;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params[key] = String(value);
    }
    const signed = signOAuth1({
      method,
      baseUrl: `${this.signatureOrigin}${route}`,
      params,
      consumerKey: this.config.consumerKey,
      consumerSecret: this.config.consumerSecret,
    });
    const url = `${this.config.wooUrl}${route}?${new URLSearchParams(signed).toString()}`;
    return this.fetchJson<T>(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.wooTimeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? `timed out after ${this.config.wooTimeoutMs} ms`
          : (err as Error).message;
      throw new WooError(`Store is unreachable: ${reason}`);
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new WooError(
        `Store returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
        response.status,
      );
    }
    if (!response.ok) {
      const err = (data ?? {}) as { message?: string; code?: string };
      throw new WooError(
        `WooCommerce error (HTTP ${response.status}): ${err.message ?? response.statusText}`,
        response.status,
        err.code,
      );
    }
    return data as T;
  }
}
