import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import robotsParser from "robots-parser";
import { AppError } from "./types.ts";
import { setTimeout as delay } from "node:timers/promises";

export const USER_AGENT = "FeedRadar/1.0 (+local personal feed reader)";
export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function normalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(
      input.trim().match(/^[a-z][\w+.-]*:/i)
        ? input.trim()
        : `https://${input.trim()}`,
    );
  } catch {
    throw new AppError("INVALID_URL");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw new AppError("INVALID_URL");
  if (!u.hostname.includes(".") && !u.hostname.includes(":"))
    throw new AppError("UNSAFE_URL");
  u.hash = "";
  return u.href;
}
export function articleUrl(input: unknown, base: string): string | null {
  try {
    if (typeof input !== "string" || !input.trim()) return null;
    const u = new URL(input, base);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
      return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch {
    return null;
  }
}
export type Page = {
  url: string;
  text: string;
  contentType: string;
  status: number;
  location?: string;
};
export type Transport = (url: string, signal?: AbortSignal) => Promise<Page>;

/** Resolve and validate every redirect; pin the selected public address to the socket. */
export function createTransport(timeout = 12000): Transport {
  return async function fetchPublic(
    input: string,
    signal?: AbortSignal,
  ): Promise<Page> {
    signal?.throwIfAborted();
    let target = normalizeUrl(input);
    const deadline = Date.now() + timeout;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const url = new URL(target);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError("TIMEOUT");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await Promise.race([
        dns.lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new AppError("TIMEOUT")),
            remaining,
          );
          timer.unref();
        }),
      ]).catch(() => {
        throw new AppError("NETWORK_ERROR");
      });
      if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        throw new AppError("UNSAFE_URL");
      const address = addresses.find((a) => a.family === 4) ?? addresses[0];
      const response = await new Promise<Page & { location?: string }>(
        (resolve, reject) => {
          const req = (url.protocol === "https:" ? https : http).get(
            url,
            {
              signal,
              agent: false,
              headers: {
                "User-Agent": USER_AGENT,
                Accept:
                  "application/rss+xml, application/atom+xml, application/feed+json, application/json, text/html, */*;q=0.2",
                "Accept-Encoding": "identity",
              },
              lookup: ((
                _h: string,
                options: { all?: boolean },
                callback: Function,
              ) =>
                options.all
                  ? callback(null, [address])
                  : callback(null, address.address, address.family)) as any,
            },
            (res) => {
              const status = res.statusCode ?? 0;
              if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                resolve({
                  status,
                  url: target,
                  text: "",
                  contentType: "",
                  location: res.headers.location,
                });
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              if (Number(res.headers["content-length"] ?? 0) > 2_000_000) {
                req.destroy(new AppError("RESPONSE_TOO_LARGE"));
                return;
              }
              res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 2_000_000)
                  req.destroy(new AppError("RESPONSE_TOO_LARGE"));
                else chunks.push(chunk);
              });
              res.on("error", reject);
              res.on("end", () => {
                const contentType = String(res.headers["content-type"] ?? "");
                const charset =
                  contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ??
                  "utf-8";
                let text: string;
                try {
                  text = new TextDecoder(charset).decode(Buffer.concat(chunks));
                } catch {
                  text = Buffer.concat(chunks).toString("utf8");
                }
                resolve({ status, text, contentType, url: target });
              });
            },
          );
          const timer = setTimeout(
            () => req.destroy(new AppError("TIMEOUT")),
            Math.max(1, deadline - Date.now()),
          );
          req.on("close", () => clearTimeout(timer));
          req.on("error", (e) =>
            reject(e instanceof AppError ? e : new AppError("NETWORK_ERROR")),
          );
        },
      );
      // Return redirects to CollectorHttp so robots can be checked BEFORE the next request.
      if (response.location) return response;
      return response;
    }
    throw new AppError("TOO_MANY_REDIRECTS");
  };
}

/** Respect robots for feeds, API and HTML, with fail-closed network/5xx behavior. */
export class CollectorHttp {
  private robots = new Map<string, { text: string; until: number }>();
  private lastRequest = new Map<string, number>();
  constructor(
    private transport: Transport,
    private delayMs = 350,
  ) {}
  private async raw(url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const origin = new URL(url).origin;
    const wait =
      this.delayMs - (Date.now() - (this.lastRequest.get(origin) ?? 0));
    if (wait > 0) await delay(wait, undefined, { signal });
    this.lastRequest.set(origin, Date.now());
    return this.transport(url, signal);
  }
  private async allowed(url: string, signal?: AbortSignal) {
    const origin = new URL(url).origin;
    let rules = this.robots.get(origin);
    if (!rules || rules.until < Date.now()) {
      let page = await this.raw(`${origin}/robots.txt`, signal);
      for (let hop = 0; page.location && hop < 5; hop++)
        page = await this.raw(
          normalizeUrl(new URL(page.location, page.url).href),
          signal,
        );
      if (page.location) throw new AppError("TOO_MANY_REDIRECTS");
      if (page.status === 401 || page.status === 403)
        throw new AppError("ROBOTS_DENIED");
      if (page.status >= 500 || page.status === 429)
        throw new AppError("SOURCE_UNAVAILABLE");
      if (page.status !== 200 && page.status !== 404 && page.status !== 410)
        throw new AppError("SOURCE_UNAVAILABLE");
      rules = {
        text: page.status === 200 ? page.text : "",
        until: Date.now() + 3600000,
      };
      this.robots.set(origin, rules);
    }
    const parser = robotsParser(`${origin}/robots.txt`, rules.text);
    if (parser.isAllowed(url, "FeedRadar") === false)
      throw new AppError("ROBOTS_DENIED");
    const crawlDelay = parser.getCrawlDelay("FeedRadar");
    if (crawlDelay && crawlDelay > 0) {
      if (crawlDelay > 30) throw new AppError("ROBOTS_DENIED");
      const wait =
        crawlDelay * 1000 - (Date.now() - (this.lastRequest.get(origin) ?? 0));
      if (wait > 0) await delay(wait, undefined, { signal });
    }
  }
  async get(url: string, signal?: AbortSignal): Promise<Page> {
    let target = normalizeUrl(url);
    let page: Page | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      signal?.throwIfAborted();
      await this.allowed(target, signal);
      page = await this.raw(target, signal);
      if (!page.location) break;
      target = normalizeUrl(new URL(page.location, page.url).href);
    }
    if (!page || page.location) throw new AppError("TOO_MANY_REDIRECTS");
    if ([401, 403].includes(page.status)) throw new AppError("ACCESS_DENIED");
    if (page.status === 429) throw new AppError("RATE_LIMITED");
    if (page.status < 200 || page.status >= 300)
      throw new AppError("SOURCE_UNAVAILABLE");
    return page;
  }
}
