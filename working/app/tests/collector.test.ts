import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Collector,
  parseFeed,
  parseHtml,
  parseWordpress,
  publicationDate,
} from "../server/collector.ts";
import {
  articleUrl,
  CollectorHttp,
  createTransport,
  normalizeUrl,
  publicAddress,
  type Page,
} from "../server/network.ts";
import { AppError } from "../server/types.ts";
const rss =
  '<rss version="2.0"><channel><title>Example</title><link>https://example.com</link><description>News</description><item><title>Hello &amp; world</title><link>https://example.com/a?utm_source=x</link><pubDate>Sun, 08 Nov 2026 10:00:00 GMT</pubDate></item><item><title>No date</title><link>https://example.com/b</link></item></channel></rss>';
test("RSS parses titles, original dates and missing dates", async () => {
  const feed = await parseFeed(rss, "https://example.com/feed");
  assert.equal(feed?.entries.length, 2);
  assert.equal(feed.entries[0].title, "Hello & world");
  assert.equal(feed.entries[0].publishedAt, "2026-11-08T10:00:00.000Z");
  assert.equal(feed.entries[1].publishedAt, null);
  assert.equal(feed.entries[0].url, "https://example.com/a");
});
test("Atom updated is never substituted for original publication", async () => {
  const feed = await parseFeed(
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>A</title><link href="https://example.com/a"/><updated>2026-11-08T12:00:00Z</updated></entry><entry><title>B</title><link href="https://example.com/b"/><published>2026-11-07T12:00:00+02:00</published></entry></feed>',
    "https://example.com",
  );
  assert.equal(feed?.entries[0].publishedAt, null);
  assert.equal(feed?.entries[1].publishedAt, "2026-11-07T10:00:00.000Z");
});
test("JSON feed excludes unsafe links and modified-only dates", async () => {
  const feed = await parseFeed(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JSON",
      items: [
        {
          title: "A",
          url: "https://example.com/a",
          date_modified: "2026-01-01T00:00:00Z",
        },
        { title: "X", url: "javascript:alert(1)" },
      ],
    }),
    "https://example.com",
  );
  assert.equal(feed?.entries.length, 1);
  assert.equal(feed.entries[0].publishedAt, null);
});
test("Malformed and entity-bearing feeds rejected", async () => {
  await assert.rejects(
    parseFeed("<rss><channel><title>x</title></rss>", "https://example.com"),
  );
  await assert.rejects(
    parseFeed(
      '<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///etc/passwd">]><rss></rss>',
      "https://example.com",
    ),
  );
});
test("HTML structured articles ignore dateModified", () => {
  const list = parseHtml(
    '<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"NewsArticle","headline":"News","url":"/story","dateModified":"2026-01-01T12:00:00Z"}]}</script>',
    "https://example.com",
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].publishedAt, null);
  assert.equal(list[0].url, "https://example.com/story");
});
test("Semantic HTML works without executing JavaScript", () => {
  const list = parseHtml(
    '<article><h2><a href="/a">כותרת</a></h2><time datetime="2026-11-08T00:00:00Z"></time></article>',
    "https://example.com",
  );
  assert.equal(list[0].title, "כותרת");
  assert.equal(list[0].publishedAt, "2026-11-08T00:00:00.000Z");
});
test("WordPress API uses original GMT timestamp", () => {
  const list = parseWordpress(
    '[{"link":"https://example.com/a","title":{"rendered":"Hello &amp; world"},"date_gmt":"2026-11-08T10:00:00","modified_gmt":"2027-01-01T00:00:00"}]',
    "https://example.com",
  );
  assert.equal(list[0].publishedAt, "2026-11-08T10:00:00.000Z");
  assert.equal(list[0].title, "Hello & world");
});
test("Invalid and ambiguous dates remain absent", () => {
  for (const value of [
    undefined,
    "",
    "today",
    "2026-11-08T12:00:00",
    "no 2026 GMT",
  ])
    assert.equal(publicationDate(value), null);
});
test("URL and address protections reject local, private and special networks", () => {
  for (const ip of [
    "127.0.0.1",
    "10.2.3.4",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "100.64.0.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  for (const url of [
    "file:///x",
    "http://user:pass@example.com",
    "https://example.com:444",
    "http://localhost",
  ])
    assert.throws(() => normalizeUrl(url));
});
test("Real transport blocks literal loopback before making a request", async () => {
  await assert.rejects(
    createTransport()("http://127.0.0.1"),
    (e: any) => e.code === "UNSAFE_URL",
  );
});
test("URLs normalize tracking and reject active content", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(articleUrl("javascript:alert(1)", "https://example.com"), null);
  assert.equal(
    articleUrl("/a?utm_medium=x&id=2#part", "https://example.com"),
    "https://example.com/a?id=2",
  );
});
test("Duplicate entries within a feed collapse", async () => {
  const feed = await parseFeed(
    rss.replace(
      "</channel>",
      "<item><title>Again</title><link>https://example.com/a</link></item></channel>",
    ),
    "https://example.com",
  );
  assert.equal(feed?.entries.length, 2);
});
test("Duplicate without date does not erase a date already supplied", async () => {
  const feed = await parseFeed(
    rss.replace(
      "</channel>",
      "<item><title>Again</title><link>https://example.com/a</link></item></channel>",
    ),
    "https://example.com",
  );
  assert.equal(feed?.entries[0].publishedAt, "2026-11-08T10:00:00.000Z");
});
test("Impossible calendar dates and date-only values stay unknown", () => {
  for (const date of [
    "2026-02-30T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-11-09",
  ])
    assert.equal(publicationDate(date), null);
});
test("Advertised WordPress API is selected after feeds are unavailable", async () => {
  const collector = new Collector({
    get: async (url) => {
      if (url.includes("/wp-json/wp/v2/posts"))
        return {
          url,
          status: 200,
          contentType: "application/json",
          text: '[{"link":"https://example.com/a","title":{"rendered":"API article"},"date_gmt":"2026-11-08T12:00:00"}]',
        };
      if (url === "https://example.com/")
        return {
          url,
          status: 200,
          contentType: "text/html",
          text: '<title>WordPress</title><link rel="https://api.w.org/" href="https://example.com/wp-json/">',
        };
      throw new AppError("SOURCE_UNAVAILABLE");
    },
  });
  const result = await collector.discover("https://example.com");
  assert.equal(result.method, "wordpress");
  assert.equal(result.entries[0].title, "API article");
});
test("Structured HTML is selected when feeds and API are unavailable", async () => {
  const collector = new Collector({
    get: async (url) => {
      if (url !== "https://example.com/")
        throw new AppError("SOURCE_UNAVAILABLE");
      return {
        url,
        status: 200,
        contentType: "text/html",
        text: '<title>HTML news</title><article><h2><a href="/a">Structured story</a></h2></article>',
      };
    },
  });
  const result = await collector.discover("https://example.com");
  assert.equal(result.method, "html");
  assert.equal(result.entries.length, 1);
});
test("Normal homepage automatically discovers advertised feed", async () => {
  const collector = new Collector({
    get: async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      text: url.endsWith("/news.xml")
        ? rss
        : '<title>Home</title><link rel="alternate" type="application/rss+xml" href="/news.xml">',
    }),
  });
  const source = await collector.discover("https://example.com");
  assert.equal(source.collectionUrl, "https://example.com/news.xml");
  assert.equal(source.entries.length, 2);
});
test("Unsupported website does not produce a pretend source", async () => {
  const collector = new Collector({
    get: async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      text: "<html>No articles</html>",
    }),
  });
  await assert.rejects(
    collector.discover("https://example.com"),
    (e: any) => e.code === "UNSUPPORTED_SITE",
  );
});
test("robots prohibition prevents fetching content", async () => {
  const seen: string[] = [];
  const client = new CollectorHttp(async (url) => {
    seen.push(url);
    return {
      url,
      status: 200,
      contentType: "text/plain",
      text: "User-agent: *\nDisallow: /private",
    };
  }, 0);
  await assert.rejects(
    client.get("https://example.com/private"),
    (e: any) => e.code === "ROBOTS_DENIED",
  );
  assert.deepEqual(seen, ["https://example.com/robots.txt"]);
});
test("robots checked before following redirect into disallowed path", async () => {
  const seen: string[] = [];
  const client = new CollectorHttp(async (url) => {
    seen.push(url);
    return url.endsWith("robots.txt")
      ? {
          url,
          status: 200,
          contentType: "text/plain",
          text: "User-agent: *\nDisallow: /private",
        }
      : { url, status: 302, contentType: "", text: "", location: "/private" };
  }, 0);
  await assert.rejects(
    client.get("https://example.com/start"),
    (e: any) => e.code === "ROBOTS_DENIED",
  );
  assert(!seen.some((x) => x.endsWith("/private")));
});
test("robots unavailable is fail closed; robots missing allows fetching", async () => {
  const denied = new CollectorHttp(
    async (url) => ({ url, status: 503, contentType: "", text: "" }),
    0,
  );
  await assert.rejects(denied.get("https://example.com"));
  const allowed = new CollectorHttp(
    async (url) => ({
      url,
      status: url.endsWith("robots.txt") ? 404 : 200,
      contentType: "",
      text: "ok",
    }),
    0,
  );
  assert.equal((await allowed.get("https://example.com")).text, "ok");
});

test("News sitemap discovery is generic and uses publication date, not lastmod", async () => {
  const xml =
    '<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>https://example.com/a</loc><lastmod>2026-11-09T12:00:00Z</lastmod><news:news><news:publication><news:name>News</news:name></news:publication><news:title>Title</news:title><news:publication_date>2026-11-08T10:00:00Z</news:publication_date></news:news></url></urlset>';
  const collector = new Collector({
    get: async (url) => ({
      url,
      status: 200,
      contentType: "text/plain",
      text: url.endsWith("robots.txt")
        ? "Sitemap: https://example.com/news-sitemap.xml"
        : url.endsWith("news-sitemap.xml")
          ? xml
          : "<title>Home</title>",
    }),
  });
  const source = await collector.discover("https://example.com");
  assert.equal(source.collectionUrl, "https://example.com/news-sitemap.xml");
  assert.equal(source.entries[0].publishedAt, "2026-11-08T10:00:00.000Z");
});

test("Homepage links require article metadata, reject navigation and external hosts", async () => {
  const seen: string[] = [];
  const collector = new Collector({
    get: async (url) => {
      seen.push(url);
      let text = "<title>Home</title>";
      if (url === "https://example.com/")
        text +=
          '<nav><a href="/article/nav"><h2>Navigation link that must never be fetched</h2></a></nav><a href="https://other.example/article/x"><h2>External link that must never be fetched</h2></a><a href="/article/a">A sufficiently long news headline</a><a href="/article/not-news">Another sufficiently long headline</a>';
      if (url.endsWith("/article/a"))
        text =
          '<meta property="og:type" content="article"><meta property="og:title" content="Confirmed news"><meta property="article:published_time" content="2026-11-08T10:00:00Z"><link rel="canonical" href="/article/a">';
      return { url, text, status: 200, contentType: "text/html" };
    },
  });
  const result = await collector.discover("https://example.com");
  assert.equal(result.method, "html");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, "Confirmed news");
  assert.equal(result.entries[0].publishedAt, "2026-11-08T10:00:00.000Z");
  assert(!seen.some((u) => u.includes("/nav") || u.includes("other.example")));
  assert.deepEqual(
    await collector.collect({
      method: "html",
      collection_url: "https://example.com/",
    }),
    result.entries,
  );
});

test("Candidate article requests still enforce robots restrictions", async () => {
  const seen: string[] = [];
  const collector = new Collector(
    new CollectorHttp(async (url) => {
      seen.push(url);
      return {
        url,
        status: 200,
        contentType: "text/html",
        text: url.endsWith("robots.txt")
          ? "User-agent: *\nDisallow: /article/"
          : '<a href="/article/blocked">A sufficiently long news headline</a>',
      };
    }, 0),
  );
  await assert.rejects(
    collector.discover("https://example.com"),
    (e: any) => e.code === "ROBOTS_DENIED",
  );
  assert(!seen.some((u) => u.includes("/article/")));
});
