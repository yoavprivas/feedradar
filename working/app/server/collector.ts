import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { articleUrl, normalizeUrl, type CollectorHttp } from "./network.ts";
import { AppError, type Discovered, type Entry, type Method } from "./types.ts";

const parser = new Parser();
export function cleanText(value: unknown) {
  return typeof value === "string"
    ? cheerio.load(value).text().replace(/\s+/g, " ").trim().slice(0, 1000)
    : "";
}
export function publicationDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || !/\d{4}/.test(value))
    return null;
  // Require a complete timestamp and an explicit zone; never invent midnight or a local zone.
  const dateText = value.trim();
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(
      dateText,
    );
  const rfc =
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|GMT|UTC)$/i.test(
      dateText,
    );
  if (!iso && !rfc) return null;
  if (iso) {
    const y = Number(iso[1]),
      m = Number(iso[2]),
      d = Number(iso[3]);
    if (
      m < 1 ||
      m > 12 ||
      d < 1 ||
      d > new Date(Date.UTC(y, m, 0)).getUTCDate()
    )
      return null;
  }
  const time = Date.parse(dateText);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function entries(values: Entry[]) {
  const unique = new Map<string, Entry>();
  for (const item of values.filter((e) => e.title && e.url)) {
    const previous = unique.get(item.url);
    unique.set(item.url, {
      ...item,
      publishedAt: item.publishedAt ?? previous?.publishedAt ?? null,
    });
  }
  return [...unique.values()].slice(0, 200);
}
export async function parseFeed(
  text: string,
  url: string,
): Promise<{ name: string; entries: Entry[]; method: Method } | null> {
  if (text.trimStart().startsWith("{")) {
    try {
      const data = JSON.parse(text);
      if (
        !String(data.version).startsWith("https://jsonfeed.org/version/") ||
        !Array.isArray(data.items)
      )
        return null;
      return {
        name: cleanText(data.title),
        method: "jsonfeed",
        entries: entries(
          data.items.map((item: any) => ({
            title: cleanText(item.title),
            url: articleUrl(item.url ?? item.external_url, url) ?? "",
            publishedAt: publicationDate(item.date_published),
          })),
        ),
      };
    } catch {
      return null;
    }
  }
  if (!/<(?:rss|feed|rdf:RDF)[\s>]/i.test(text)) return null;
  if (/<!ENTITY|<!DOCTYPE/i.test(text)) throw new AppError("INVALID_FEED");
  try {
    await parser.parseString(text);
  } catch {
    throw new AppError("INVALID_FEED");
  }
  const $ = cheerio.load(text, { xml: true });
  const atom = $("feed").length > 0;
  const nodes = atom ? $("feed > entry") : $("item");
  const list: Entry[] = [];
  nodes.each((_, el) => {
    const item = $(el);
    const link = atom
      ? item
          .children("link")
          .filter(
            (_, a) => !$(a).attr("rel") || $(a).attr("rel") === "alternate",
          )
          .first()
          .attr("href")
      : item.children("link").first().text() ||
        item
          .children("guid")
          .filter((_, a) => $(a).attr("isPermaLink") !== "false")
          .text();
    const rawDate = atom
      ? item.children("published").text()
      : item.children("pubDate").text() || item.children("dc\\:date").text();
    list.push({
      title: cleanText(item.children("title").first().text()),
      url: articleUrl(link, url) ?? "",
      publishedAt: publicationDate(rawDate),
    });
  });
  return {
    name: cleanText(
      $(atom ? "feed > title" : "channel > title")
        .first()
        .text(),
    ),
    method: "rss",
    entries: entries(list),
  };
}
export function parseWordpress(text: string, url: string): Entry[] {
  let posts: any;
  try {
    posts = JSON.parse(text);
  } catch {
    throw new AppError("INVALID_FEED");
  }
  if (!Array.isArray(posts)) throw new AppError("INVALID_FEED");
  return entries(
    posts.map((p) => ({
      title: cleanText(p.title?.rendered),
      url: articleUrl(p.link, url) ?? "",
      publishedAt: publicationDate(
        typeof p.date_gmt === "string"
          ? `${p.date_gmt.replace(/Z$/, "")}Z`
          : null,
      ),
    })),
  );
}
export function parseHtml(text: string, url: string): Entry[] {
  const $ = cheerio.load(text);
  const found: Entry[] = [];
  function visit(value: any, depth = 0) {
    if (!value || depth > 15) return;
    if (Array.isArray(value)) {
      value.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const kinds = Array.isArray(value["@type"])
      ? value["@type"]
      : [value["@type"]];
    if (
      kinds.some((k: string) =>
        [
          "NewsArticle",
          "Article",
          "BlogPosting",
          "ReportageNewsArticle",
        ].includes(k),
      )
    ) {
      found.push({
        title: cleanText(value.headline ?? value.name),
        url:
          articleUrl(value.url ?? value.mainEntityOfPage?.["@id"], url) ?? "",
        publishedAt: publicationDate(value.datePublished),
      });
    }
    Object.values(value).forEach((x) => visit(x, depth + 1));
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {
      /* malformed structured block */
    }
  });
  $("article").each((_, el) => {
    const item = $(el);
    const link = item.find("h1 a, h2 a, h3 a").first();
    found.push({
      title: cleanText(link.text()),
      url: articleUrl(link.attr("href"), url) ?? "",
      publishedAt: publicationDate(
        item.find("time[datetime]").first().attr("datetime"),
      ),
    });
  });
  return entries(found);
}
export class Collector {
  constructor(private http: Pick<CollectorHttp, "get">) {}
  async discover(input: string): Promise<Discovered> {
    const siteUrl = normalizeUrl(input);
    const page = await this.http.get(siteUrl);
    const direct = await parseFeed(page.text, page.url);
    if (direct)
      return {
        name: direct.name || new URL(page.url).hostname,
        siteUrl: page.url,
        collectionUrl: page.url,
        method: direct.method,
        entries: direct.entries,
      };
    const $ = cheerio.load(page.text);
    const name =
      cleanText(
        $('meta[property="og:site_name"]').attr("content") ?? $("title").text(),
      ) || new URL(page.url).hostname;
    const candidates: string[] = [];
    $('link[rel="alternate"]').each((_, el) => {
      const type = $(el).attr("type") ?? "";
      if (/rss|atom|feed\+json/i.test(type)) {
        const href = articleUrl($(el).attr("href"), page.url);
        if (href) candidates.push(href);
      }
    });
    for (const path of ["/feed/", "/rss.xml", "/feed.xml"])
      candidates.push(new URL(path, page.url).href);
    for (const candidate of [...new Set(candidates)].slice(0, 6)) {
      try {
        const feedPage = await this.http.get(candidate);
        const feed = await parseFeed(feedPage.text, feedPage.url);
        if (feed)
          return {
            name: feed.name || name,
            siteUrl: page.url,
            collectionUrl: feedPage.url,
            method: feed.method,
            entries: feed.entries,
          };
      } catch {
        /* Try another advertised feed or adapter. */
      }
    }
    const api = $('link[rel="https://api.w.org/"]').attr("href");
    if (api) {
      try {
        const base = new URL(api, page.url);
        if (base.origin === new URL(page.url).origin && !base.search) {
          const endpoint = new URL(
            "wp/v2/posts?per_page=50&_fields=id,link,title,date_gmt",
            base.href.endsWith("/") ? base : new URL(`${base.href}/`),
          );
          const result = await this.http.get(endpoint.href);
          return {
            name,
            siteUrl: page.url,
            collectionUrl: endpoint.href,
            method: "wordpress",
            entries: parseWordpress(result.text, page.url),
          };
        }
      } catch {
        /* Structured public HTML may still work. */
      }
    }
    const html = parseHtml(page.text, page.url);
    if (html.length)
      return {
        name,
        siteUrl: page.url,
        collectionUrl: page.url,
        method: "html",
        entries: html,
      };
    throw new AppError("UNSUPPORTED_SITE");
  }
  async collect(source: { collection_url: string; method: Method }) {
    const page = await this.http.get(source.collection_url);
    if (source.method === "wordpress")
      return parseWordpress(page.text, page.url);
    if (source.method === "html") {
      const result = parseHtml(page.text, page.url);
      if (!result.length) throw new AppError("SOURCE_CHANGED");
      return result;
    }
    const feed = await parseFeed(page.text, page.url);
    if (!feed) throw new AppError("INVALID_FEED");
    return feed.entries;
  }
}
