import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Repository } from "../../backend/db.ts";
import { Collector } from "../../backend/collector.ts";
import { Scanner } from "../../backend/scanner.ts";
import { ScanStore } from "../../backend/scan-store.ts";
import { createApp } from "../../backend/app.ts";
import { hashPassword } from "../../backend/security.ts";

test("stage B authentication, durable coordination and migrations", async (t) => {
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
  const repo = new Repository(pool);
  await repo.migrate();
  const collector = new Collector({
    get: async () => {
      throw new Error("No external network in tests");
    },
  });
  const scanner = new Scanner(repo, collector, 3600000, 60000);
  const security = {
    authMode: "password",
    passwordHash: await hashPassword("test-password-long-enough"),
    schedulerJob: "test-job",
    verifyScheduler: async (token: string) => token === "verified-test-token",
  };
  const server = createApp(
    repo,
    collector,
    scanner,
    undefined,
    security,
  ).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    extra = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-FeedRadar-Request": "1",
        Cookie: cookie,
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let cookie = "";
  const store = new ScanStore(repo);
  try {
    await t.test(
      "migrations are numbered, repeatable and serialized",
      async () => {
        await Promise.all([repo.migrate(), repo.migrate()]);
        assert.equal(
          (await pool.query("SELECT count(*)::int n FROM schema_migrations"))
            .rows[0].n,
          2,
        );
      },
    );
    await t.test(
      "anonymous users cannot read data or mutate sources",
      async () => {
        assert.equal((await call("/api/feed")).status, 401);
        assert.equal((await call("/api/state")).status, 401);
        assert.equal(
          (await call("/api/sources", "POST", { url: "https://example.com" }))
            .status,
          401,
        );
        assert.equal((await call("/healthz")).status, 200);
        assert.equal(
          (await call("/api/auth/session")).headers.get("cache-control"),
          "no-store",
        );
      },
    );
    await t.test(
      "login rejects wrong passwords and cross-origin requests",
      async () => {
        assert.equal(
          (await call("/api/auth/login", "POST", { password: "wrong" })).status,
          401,
        );
        assert.equal(
          (
            await call(
              "/api/auth/login",
              "POST",
              { password: "test-password-long-enough" },
              "",
              { Origin: "https://evil.example" },
            )
          ).status,
          403,
        );
      },
    );
    await t.test(
      "session cookie is HttpOnly, strict, opaque and persists across app instances",
      async () => {
        const response = await call("/api/auth/login", "POST", {
          password: "test-password-long-enough",
        });
        assert.equal(response.status, 200);
        const raw = response.headers.get("set-cookie")!;
        assert.match(raw, /HttpOnly/i);
        assert.match(raw, /SameSite=Strict/i);
        cookie = raw.split(";")[0];
        assert.equal(
          (await call("/api/feed", "GET", undefined, cookie)).status,
          200,
        );
        const stored = (
          await pool.query("SELECT token_hash FROM admin_sessions")
        ).rows[0].token_hash;
        assert(!cookie.includes(stored));
        const second = createApp(
          new Repository(pool),
          collector,
          new Scanner(repo, collector, 3600000),
          undefined,
          security,
        ).listen(0, "127.0.0.1");
        await new Promise<void>((r) => second.once("listening", r));
        try {
          assert.equal(
            (
              await fetch(
                `http://127.0.0.1:${(second.address() as any).port}/api/feed`,
                { headers: { Cookie: cookie } },
              )
            ).status,
            200,
          );
        } finally {
          await new Promise<void>((r) => second.close(() => r()));
        }
      },
    );
    await t.test(
      "logout revokes session and expired sessions are refused",
      async () => {
        assert.equal(
          (await call("/api/auth/logout", "POST", {}, cookie)).status,
          204,
        );
        assert.equal(
          (await call("/api/feed", "GET", undefined, cookie)).status,
          401,
        );
        const response = await call("/api/auth/login", "POST", {
          password: "test-password-long-enough",
        });
        cookie = response.headers.get("set-cookie")!.split(";")[0];
        await pool.query(
          "UPDATE admin_sessions SET expires_at=now()-interval '1 second'",
        );
        assert.equal(
          (await call("/api/feed", "GET", undefined, cookie)).status,
          401,
        );
      },
    );
    await t.test(
      "login budget persists and is shared between requests",
      async () => {
        await pool.query("UPDATE login_throttle SET attempts=10");
        assert.equal(
          (
            await call("/api/auth/login", "POST", {
              password: "test-password-long-enough",
            })
          ).status,
          429,
        );
        await pool.query(
          "UPDATE login_throttle SET window_start=now()-interval '16 minutes'",
        );
        assert.equal(
          (
            await call("/api/auth/login", "POST", {
              password: "test-password-long-enough",
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "Scheduler rejects missing or bad identity and wrong job",
      async () => {
        assert.equal((await call("/internal/scan", "POST", {})).status, 401);
        assert.equal(
          (
            await call("/internal/scan", "POST", {}, "", {
              Authorization: "Bearer wrong",
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await call("/internal/scan", "POST", {}, "", {
              Authorization: "Bearer verified-test-token",
              "X-CloudScheduler-JobName": "wrong",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "authenticated Scheduler retry reuses persisted result after restart",
      async () => {
        const time = new Date().toISOString();
        const headers = {
          Authorization: "Bearer verified-test-token",
          "X-CloudScheduler-JobName": "test-job",
          "X-CloudScheduler-ScheduleTime": time,
        };
        assert.equal(
          (await call("/internal/scan", "POST", {}, "", headers)).status,
          200,
        );
        const fresh = new Scanner(repo, collector, 3600000);
        const result = await fresh.scan(false, `scheduled:${time}`);
        assert.equal(result.checked, 0);
        assert.equal(
          (
            await pool.query(
              "SELECT attempts FROM scan_runs WHERE run_key=$1",
              [`scheduled:${time}`],
            )
          ).rows[0].attempts,
          1,
        );
      },
    );
    await t.test(
      "database lock prevents overlapping replicas and expired owner cannot write",
      async () => {
        const lock = await store.acquire("lease-test", 0);
        await assert.rejects(new ScanStore(repo).acquire("other", 0), {
          code: "SCAN_IN_PROGRESS",
        });
        await pool.query(
          "UPDATE scan_control SET lease_until=now()-interval '1 second'",
        );
        const next = await new ScanStore(repo).acquire("recovered", 0);
        await assert.rejects(repo.saveScan(randomUUID(), [], lock.owner), {
          code: "SCAN_LEASE_LOST",
        });
        await assert.rejects(store.renew(lock.owner!), {
          code: "SCAN_LEASE_LOST",
        });
        await store.finish(next.owner!, "recovered", {
          added: 0,
          checked: 0,
          succeeded: 0,
          failed: 0,
        });
      },
    );
    await t.test(
      "cooldown survives restart and attempts are bounded",
      async () => {
        await assert.rejects(new Scanner(repo, collector, 3600000).scan(true), {
          code: "REFRESH_COOLDOWN",
        });
        for (let i = 0; i < 3; i++) {
          const lock = await store.acquire("retry-test", 0);
          await store.finish(lock.owner!, "retry-test", null);
        }
        await assert.rejects(store.acquire("retry-test", 0), {
          code: "SCAN_RETRY_LIMIT",
        });
        assert.equal(
          (await new Scanner(repo, collector, 3600000).persistentStatus())
            .scanning,
          false,
        );
      },
    );
    await t.test(
      "stopping an active scan cancels collection and releases its lease",
      async () => {
        const { id } = await repo.addSource({
          name: "Cancellation fixture",
          siteUrl: "https://cancel.example",
          collectionUrl: "https://cancel.example/feed",
          method: "rss",
          entries: [],
        });
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        const slow = new Collector({
          get: async () => {
            throw new Error("unused");
          },
        });
        slow.collect = async (_source, signal) => {
          started();
          return new Promise((_, reject) => {
            signal!.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          });
        };
        const stopping = new Scanner(repo, slow, 3600000, 0);
        const run = stopping.scan();
        const rejected = assert.rejects(run, /cancelled/);
        await ready;
        await stopping.stop();
        await rejected;
        assert.equal((await stopping.persistentStatus()).scanning, false);
        assert.equal(
          (
            await pool.query(
              "SELECT status FROM scan_runs ORDER BY started_at DESC LIMIT 1",
            )
          ).rows[0].status,
          "failed",
        );
        await repo.remove(id);
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
