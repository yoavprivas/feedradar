import { createHash } from "node:crypto";

export type FeedData = { articles: Record<string, any>[]; total: number };
export interface RedisStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
export class UpstashRedis implements RedisStore {
  private origin: string;
  constructor(
    endpoint: string,
    private token: string,
    private timeoutMs = 500,
    private request: typeof fetch = fetch,
  ) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("Invalid UPSTASH_REDIS_REST_URL");
    }
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".upstash.io") ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Invalid UPSTASH_REDIS_REST_URL (HTTPS Upstash origin required)",
      );
    if (token.length < 16 || /\s/.test(token))
      throw new Error("Invalid UPSTASH_REDIS_REST_TOKEN");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 2000)
      throw new Error("Invalid Redis timeout");
    this.origin = url.origin;
  }
  private async command(command: (string | number)[]) {
    const response = await this.request(this.origin, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error("REDIS_UNAVAILABLE");
    const body = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      "error" in body ||
      !("result" in body)
    )
      throw new Error("REDIS_UNAVAILABLE");
    return body.result;
  }
  async get(key: string) {
    const value = await this.command(["GET", key]);
    if (value !== null && typeof value !== "string")
      throw new Error("REDIS_INVALID_RESPONSE");
    return value as string | null;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if ((await this.command(["SET", key, value, "EX", ttlSeconds])) !== "OK")
      throw new Error("REDIS_UNAVAILABLE");
  }
}

export function datasetNamespace(namespace: string, databaseUrl: string) {
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(namespace))
    throw new Error("Invalid CACHE_NAMESPACE");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Invalid database URL for cache namespace");
  }
  url.password = "";
  // Bind to database, role and connection options; never put credentials in keys/logs.
  return `${namespace}:admin:${createHash("sha256").update(url.href).digest("hex").slice(0, 24)}`;
}
type CacheEvent = {
  event: string;
  limit: number;
  offset: number;
  revision: string;
  reason?: string;
};
function validFeed(value: unknown, limit: number): value is FeedData {
  if (!value || typeof value !== "object") return false;
  const v = value as FeedData;
  return (
    Number.isInteger(v.total) &&
    v.total >= 0 &&
    Array.isArray(v.articles) &&
    v.articles.length <= limit &&
    v.articles.every(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.title === "string" &&
        typeof a.url === "string" &&
        /^https?:\/\//.test(a.url) &&
        typeof a.source_name === "string" &&
        typeof a.source_id === "string" &&
        (a.published_at === null || typeof a.published_at === "string"),
    )
  );
}
export class FeedCache {
  private blockedUntil = 0;
  private active = new Map<string, Promise<FeedData>>();
  constructor(
    private redis: RedisStore,
    private namespace: string,
    private ttlSeconds = 60,
    private log: (event: CacheEvent) => void = (event) =>
      console.log(JSON.stringify(event)),
    private clock = Date.now,
  ) {
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(namespace))
      throw new Error("Invalid cache namespace");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 300)
      throw new Error("Invalid cache TTL");
  }
  async read(
    revision: string,
    limit: number,
    offset: number,
    load: () => Promise<FeedData>,
  ): Promise<FeedData> {
    const fields = { limit, offset, revision };
    if (!/^\d{1,32}$/.test(revision) || offset > 500) {
      this.log({ event: "cache_bypass", ...fields, reason: "uncached_page" });
      return load();
    }
    const key = `${this.namespace}:feed:${revision}:${limit}:${offset}`;
    const pending = this.active.get(key);
    if (pending) {
      this.log({ event: "cache_coalesced", ...fields });
      return pending;
    }
    const result = this.readPage(key, fields, load);
    this.active.set(key, result);
    try {
      return await result;
    } finally {
      this.active.delete(key);
    }
  }
  private async readPage(
    key: string,
    fields: Omit<CacheEvent, "event">,
    load: () => Promise<FeedData>,
  ) {
    if (this.clock() < this.blockedUntil) {
      this.log({ event: "cache_bypass", ...fields, reason: "circuit_open" });
      return load();
    }
    try {
      const raw = await this.redis.get(key);
      let cached: unknown;
      if (raw !== null && raw.length <= 524288) {
        try {
          cached = JSON.parse(raw);
        } catch {}
      }
      if (validFeed(cached, fields.limit)) {
        this.log({ event: "cache_hit", ...fields });
        return cached;
      }
      this.log({
        event: "cache_miss",
        ...fields,
        reason: raw === null ? "absent" : "invalid_value",
      });
    } catch {
      this.blockedUntil = this.clock() + 5000;
      this.log({ event: "cache_error", ...fields, reason: "read_failed" });
    }
    const data = await load();
    if (this.clock() >= this.blockedUntil) {
      const value = JSON.stringify(data);
      if (Buffer.byteLength(value, "utf8") <= 524288) {
        try {
          await this.redis.set(key, value, this.ttlSeconds);
        } catch {
          this.blockedUntil = this.clock() + 5000;
          this.log({ event: "cache_error", ...fields, reason: "write_failed" });
        }
      }
    }
    return data;
  }
}
