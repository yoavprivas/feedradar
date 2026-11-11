import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Repository } from "../../backend/db.ts";
import { Collector } from "../../backend/collector.ts";
import { Scanner } from "../../backend/scanner.ts";
import { createApp } from "../../backend/app.ts";
import { hashPassword } from "../../backend/security.ts";
import { FeedCache } from "../../backend/feed-cache.ts";
import { FakeRedis } from "../helpers/fake-redis.ts";

test("authenticated cache-aside and transactional invalidation with actual PostgreSQL", async (t) => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL required");
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const plain = new Repository(pool);
  await plain.migrate();
  const redis = new FakeRedis(),
    events: any[] = [];
  const cached = new Repository(
    pool,
    new FeedCache(
      redis,
      "test:dataset:admin",
      60,
      (e) => events.push(e),
      () => redis.now,
    ),
  );
  const collector = new Collector({
    get: async () => {
      throw new Error("No external network");
    },
  });
  const scanner = new Scanner(cached, collector, 3600000, 0);
  const server = createApp(cached, collector, scanner, undefined, {
    authMode: "password",
    passwordHash: await hashPassword("cache-test-password-long-enough"),
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  const request = (path = "/api/feed", auth = true) =>
    fetch(base + path, { headers: auth ? { Cookie: cookie } : {} });
  const item = (suffix: string, date: string | null = null) => ({
    title: suffix,
    url: `https://fixture.example/${suffix}`,
    publishedAt: date,
  });
  const reset = async () => {
    await pool.query("TRUNCATE sources CASCADE");
    await pool.query("UPDATE feed_cache_state SET revision=revision+1");
    redis.values.clear();
    redis.online = true;
    redis.failWrites = false;
    redis.now += 10000;
    redis.gets = 0;
    redis.sets = 0;
    events.length = 0;
    const source = await plain.addSource({
      name: "Fixture",
      siteUrl: "https://fixture.example",
      collectionUrl: "https://fixture.example/feed",
      method: "rss",
      entries: [],
    });
    await plain.saveScan(source.id, [item("one")]);
    return source.id;
  };
  const check = (name: string, fn: (source: string) => Promise<void>) =>
    t.test(name, async () => {
      const source = await reset();
      await fn(source);
    });
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FeedRadar-Request": "1",
      },
      body: JSON.stringify({ password: "cache-test-password-long-enough" }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    await check(
      "a warm authenticated hit executes only the existing session query",
      async () => {
        const query = pool.query.bind(pool);
        const calls: string[] = [];
        pool.query = ((...args: any[]) => {
          calls.push(typeof args[0] === "string" ? args[0] : "query");
          return (query as any)(...args);
        }) as typeof pool.query;
        try {
          const first = await request();
          assert.equal(first.status, 200);
          const body = await first.json();
          assert.equal(calls.length, 3);
          calls.length = 0;
          const hit = await request();
          assert.equal(hit.status, 200);
          assert.deepEqual(await hit.json(), body);
          assert.equal(calls.length, 1);
          assert.match(calls[0], /admin_sessions/);
          assert(events.some((e) => e.event === "cache_miss"));
          assert(events.some((e) => e.event === "cache_hit"));
        } finally {
          pool.query = query;
        }
      },
    );
    await check(
      "anonymous and revoked sessions cannot read a warm cache",
      async () => {
        await request();
        const before = redis.gets;
        assert.equal((await request("/api/feed", false)).status, 401);
        assert.equal(
          (
            await fetch(base + "/api/feed", {
              headers: { Cookie: "feedradar-local=" + "a".repeat(64) },
            })
          ).status,
          401,
        );
        assert.equal(redis.gets, before);
      },
    );
    await check(
      "a worker without Redis credentials invalidates cached pages atomically with new data",
      async (source) => {
        assert.equal((await (await request()).json()).total, 1);
        const oldRevision = await plain.feedRevision();
        await plain.saveScan(source, [item("one"), item("two")]);
        assert.notEqual(await plain.feedRevision(), oldRevision);
        const updated = await (await request()).json();
        assert.equal(updated.total, 2);
        assert(updated.articles.some((a: any) => a.title === "two"));
        const before = events.filter((e) => e.event === "cache_hit").length;
        await request();
        assert.equal(
          events.filter((e) => e.event === "cache_hit").length,
          before + 1,
        );
      },
    );
    await check(
      "publication-date repair refreshes the cache even with zero new articles",
      async (source) => {
        assert.equal(
          (await (await request()).json()).articles[0].published_at,
          null,
        );
        assert.equal(
          await plain.saveScan(source, [item("one", "2026-11-11T08:00:00Z")]),
          0,
        );
        assert.equal(
          (await (await request()).json()).articles[0].published_at,
          "2026-11-11T08:00:00.000Z",
        );
      },
    );
    await check(
      "source removal invalidates cached articles and totals",
      async (source) => {
        assert.equal((await (await request()).json()).total, 1);
        assert.equal(await plain.remove(source), true);
        const removed = await (await request()).json();
        assert.equal(removed.total, 0);
        assert.deepEqual(removed.articles, []);
      },
    );
    await check(
      "cache invalidation and article writes roll back together on a database failure",
      async (source) => {
        const before = await plain.feedRevision();
        await request();
        await pool.query(`CREATE FUNCTION block_cache_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled generation failure'; END $$;
    CREATE TRIGGER block_cache_revision BEFORE UPDATE ON feed_cache_state FOR EACH ROW EXECUTE FUNCTION block_cache_revision()`);
        try {
          await assert.rejects(
            plain.saveScan(source, [item("two")]),
            /controlled generation failure/,
          );
          assert.equal(await plain.feedRevision(), before);
          assert.equal((await (await request()).json()).total, 1);
          assert.equal((await plain.feed()).total, 1);
        } finally {
          await pool.query(
            "DROP TRIGGER block_cache_revision ON feed_cache_state; DROP FUNCTION block_cache_revision()",
          );
        }
      },
    );
    await check(
      "Redis outage preserves HTTP success and offline writes remain fresh after recovery",
      async (source) => {
        await request();
        redis.online = false;
        await plain.saveScan(source, [item("two")]);
        const fallback = await request();
        assert.equal(fallback.status, 200);
        assert.equal((await fallback.json()).total, 2);
        await plain.saveScan(source, [item("three")]);
        redis.online = true;
        redis.now += 6000;
        assert.equal((await (await request()).json()).total, 3);
        assert.equal((await (await request()).json()).total, 3);
        assert(events.some((e) => e.event === "cache_error"));
        assert.equal((await plain.feed()).total, 3);
      },
    );
    await check(
      "TTL expiry refreshes unchanged generations from PostgreSQL",
      async () => {
        await request();
        await request();
        const misses = events.filter((e) => e.event === "cache_miss").length;
        redis.now += 61000;
        assert.equal((await (await request()).json()).total, 1);
        assert.equal(
          events.filter((e) => e.event === "cache_miss").length,
          misses + 1,
        );
      },
    );
  } finally {
    await scanner.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
