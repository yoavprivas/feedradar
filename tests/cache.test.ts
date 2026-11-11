import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FeedCache,
  UpstashRedis,
  datasetNamespace,
} from "../backend/feed-cache.ts";
import { FakeRedis, fixtureFeed } from "./helpers/fake-redis.ts";

test("cache-aside misses read once, then hits bypass the data loader; entries expire", async () => {
  const redis = new FakeRedis();
  const events: any[] = [];
  let reads = 0;
  const cache = new FeedCache(
    redis,
    "test:owner",
    60,
    (e) => events.push(e),
    () => redis.now,
  );
  const load = async () => {
    reads++;
    return fixtureFeed();
  };
  assert.deepEqual(await cache.read("1", 50, 0, load), fixtureFeed());
  assert.deepEqual(await cache.read("1", 50, 0, load), fixtureFeed());
  assert.equal(reads, 1);
  assert.equal([...redis.values.values()][0].ttl, 60);
  assert.deepEqual(
    events.map((e) => e.event),
    ["cache_miss", "cache_hit"],
  );
  redis.now = 61000;
  await cache.read("1", 50, 0, load);
  assert.equal(reads, 2);
});
test("dataset/owner scopes, revision, page size and offset do not share cached pages", async () => {
  const redis = new FakeRedis(),
    a = new FeedCache(redis, "dataset:A", 60, () => {}),
    b = new FeedCache(redis, "dataset:B", 60, () => {});
  await a.read("1", 50, 0, async () => fixtureFeed("Owner A"));
  const other = await b.read("1", 50, 0, async () => fixtureFeed("Owner B"));
  assert.equal(other.articles[0].title, "Owner B");
  await a.read("2", 50, 0, async () => fixtureFeed("New generation"));
  await a.read("2", 25, 0, async () => fixtureFeed("Different size"));
  await a.read("2", 50, 50, async () => fixtureFeed("Next page"));
  assert.equal(redis.values.size, 5);
});
test("an old in-flight fill cannot replace the current generation after a write", async () => {
  const redis = new FakeRedis(),
    cache = new FeedCache(redis, "racing:owner", 60, () => {});
  let release!: (value: ReturnType<typeof fixtureFeed>) => void,
    ready!: () => void;
  const started = new Promise<void>((r) => {
    ready = r;
  });
  const old = cache.read("1", 50, 0, async () => {
    ready();
    return new Promise((r) => {
      release = r;
    });
  });
  await started;
  await cache.read("2", 50, 0, async () => fixtureFeed("New"));
  release(fixtureFeed("Old"));
  await old;
  const current = await cache.read("2", 50, 0, async () => {
    throw new Error("Must be a hit");
  });
  assert.equal(current.articles[0].title, "New");
});
test("Redis outage falls back, opens a short circuit, and cannot resurrect pre-write data", async () => {
  const redis = new FakeRedis(),
    events: any[] = [];
  const cache = new FeedCache(
    redis,
    "offline:owner",
    60,
    (e) => events.push(e),
    () => redis.now,
  );
  await cache.read("1", 50, 0, async () => fixtureFeed("Old"));
  redis.online = false;
  assert.equal(
    (await cache.read("2", 50, 0, async () => fixtureFeed("New"))).articles[0]
      .title,
    "New",
  );
  const requests = redis.gets;
  await cache.read("2", 50, 0, async () => fixtureFeed("New"));
  assert.equal(redis.gets, requests);
  redis.online = true;
  redis.now = 6000;
  assert.equal(
    (await cache.read("2", 50, 0, async () => fixtureFeed("New"))).articles[0]
      .title,
    "New",
  );
  assert(!JSON.stringify(events).includes("private-token"));
  assert(events.some((e) => e.event === "cache_error"));
  assert(events.some((e) => e.event === "cache_bypass"));
});
test("failed cache writes do not turn a successful database read into a failed request", async () => {
  const redis = new FakeRedis();
  redis.failWrites = true;
  const cache = new FeedCache(redis, "write:owner", 60, () => {});
  assert.deepEqual(
    await cache.read("1", 50, 0, async () => fixtureFeed()),
    fixtureFeed(),
  );
});
test("malformed or unsafe cached payloads are misses and are replaced", async () => {
  const redis = new FakeRedis(),
    cache = new FeedCache(redis, "invalid:owner", 60, () => {});
  for (const raw of [
    "bad json",
    JSON.stringify({ total: 1, articles: [{ url: "javascript:alert(1)" }] }),
    "null",
  ]) {
    redis.values.set("invalid:owner:feed:1:50:0", {
      value: raw,
      expiresAt: 10000,
      ttl: 60,
    });
    assert.deepEqual(
      await cache.read("1", 50, 0, async () => fixtureFeed()),
      fixtureFeed(),
    );
  }
});
test("parallel misses share one database fill; errors are not cached", async () => {
  const redis = new FakeRedis(),
    cache = new FeedCache(redis, "parallel:owner", 60, () => {});
  let reads = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      cache.read("1", 50, 0, async () => {
        reads++;
        return fixtureFeed();
      }),
    ),
  );
  assert.equal(reads, 1);
  assert.equal(redis.gets, 1);
  assert.equal(redis.sets, 1);
  await assert.rejects(
    cache.read("2", 50, 0, async () => {
      throw new Error("Database unavailable");
    }),
    /Database unavailable/,
  );
  assert.equal(redis.sets, 1);
  await cache.read("2", 50, 0, async () => fixtureFeed());
  assert.equal(redis.sets, 2);
});
test("older pages bypass the cache and remain available from PostgreSQL", async () => {
  const redis = new FakeRedis(),
    cache = new FeedCache(redis, "older:owner", 60, () => {});
  await cache.read("1", 50, 501, async () => fixtureFeed());
  assert.equal(redis.gets, 0);
  assert.equal(redis.sets, 0);
});
test("database namespaces exclude passwords and separate roles/databases/environments", () => {
  const first = datasetNamespace(
    "feedradar:prod",
    "postgresql://owner:secret-one@db.example/app",
  );
  assert.equal(
    first,
    datasetNamespace(
      "feedradar:prod",
      "postgresql://owner:secret-two@db.example/app",
    ),
  );
  assert.notEqual(
    first,
    datasetNamespace(
      "feedradar:dev",
      "postgresql://owner:secret-one@db.example/app",
    ),
  );
  assert.notEqual(
    first,
    datasetNamespace(
      "feedradar:prod",
      "postgresql://other:secret-one@db.example/app",
    ),
  );
  assert.notEqual(
    first,
    datasetNamespace(
      "feedradar:prod",
      "postgresql://owner:secret-one@db.example/other",
    ),
  );
  assert(!first.includes("secret"));
  assert.throws(() => datasetNamespace("bad namespace", "postgresql://db/app"));
});
test("Upstash uses authenticated HTTPS POST commands with EX TTL and no redirects", async () => {
  const commands: any[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://fixture.upstash.io");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.method, "POST");
    assert.equal(
      (options?.headers as any).Authorization,
      "Bearer unit-test-token-long-enough",
    );
    assert(options?.signal);
    const command = JSON.parse(options?.body as string);
    commands.push(command);
    return new Response(
      JSON.stringify({ result: command[0] === "GET" ? null : "OK" }),
      { status: 200 },
    );
  };
  const redis = new UpstashRedis(
    "https://fixture.upstash.io",
    "unit-test-token-long-enough",
    500,
    request,
  );
  assert.equal(await redis.get("key"), null);
  await redis.set("key", "value", 60);
  assert.deepEqual(commands, [
    ["GET", "key"],
    ["SET", "key", "value", "EX", 60],
  ]);
});
test("Upstash failures and invalid configuration cannot expose credentials or redirect them", async () => {
  for (const url of [
    "http://fixture.upstash.io",
    "https://evil.example",
    "https://user:pass@fixture.upstash.io",
    "https://fixture.upstash.io/path",
    "https://fixture.upstash.io?token=x",
    "https://fixture.upstash.io:8443",
    "private-invalid-connection-value",
  ])
    assert.throws(() => new UpstashRedis(url, "unit-test-token-long-enough"));
  for (const response of [
    new Response("private-provider-message", { status: 401 }),
    new Response(JSON.stringify({ error: "private-provider-message" }), {
      status: 200,
    }),
  ]) {
    const redis = new UpstashRedis(
      "https://fixture.upstash.io",
      "unit-test-token-long-enough",
      500,
      async () => response,
    );
    await assert.rejects(redis.get("key"), { message: "REDIS_UNAVAILABLE" });
  }
});
test("Upstash command timeouts are bounded", async () => {
  const keeper = setTimeout(() => {}, 500);
  try {
    const request: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        );
      });
    const redis = new UpstashRedis(
      "https://fixture.upstash.io",
      "unit-test-token-long-enough",
      50,
      request,
    );
    await assert.rejects(redis.get("key"), { name: "TimeoutError" });
  } finally {
    clearTimeout(keeper);
  }
});
