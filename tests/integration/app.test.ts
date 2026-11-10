import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Repository } from "../../backend/db.ts";
import { Collector } from "../../backend/collector.ts";
import { Scanner } from "../../backend/scanner.ts";
import { createApp } from "../../backend/app.ts";
import { AppError } from "../../backend/types.ts";

test("PostgreSQL + HTTP API complete lifecycle", async (t) => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error(
      "TEST_DATABASE_URL is required; integration must not silently skip.",
    );
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
  let newArticle = false;
  let failFirst = false;
  const collector = new Collector({
    get: async (url) => {
      if (failFirst && url.includes("example.com"))
        throw new AppError("TIMEOUT");
      const host = new URL(url).hostname;
      const items = [
        {
          title: "Old",
          url: `https://${host}/old`,
          date_published: "2026-11-06T08:00:00Z",
        },
        { title: "Missing date", url: `https://${host}/unknown` },
        {
          title: "New",
          url: `https://${host}/new`,
          date_published: "2026-11-08T08:00:00Z",
        },
      ];
      if (newArticle)
        items.push({
          title: "Latest",
          url: `https://${host}/latest`,
          date_published: "2026-11-09T08:00:00Z",
        });
      return {
        url,
        status: 200,
        contentType: "application/feed+json",
        text: JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: host,
          items,
        }),
      };
    },
  });
  const scanner = new Scanner(repo, collector, 600000, 0);
  const server = createApp(repo, collector, scanner).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-FeedRadar-Request": "1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let firstId = "";
  try {
    await t.test("health proves a real PostgreSQL connection", async () => {
      assert.equal(
        (await (await request("/health")).json()).database,
        "postgresql",
      );
    });
    await t.test("adding a source persists its articles", async () => {
      const response = await request("/sources", "POST", {
        url: "https://example.com",
      });
      assert.equal(response.status, 201);
      const data = await response.json();
      firstId = data.id;
      assert.equal(data.added, 3);
      assert.equal(data.registrationStatus, "saved");
      assert.equal(data.collectionStatus, "ready");
      assert.equal((await repo.sources()).length, 1);
    });
    await t.test("duplicate add is rejected atomically", async () => {
      assert.equal(
        (await request("/sources", "POST", { url: "https://example.com" }))
          .status,
        409,
      );
      assert.equal((await repo.feed()).total, 3);
    });
    await t.test("feed sorts by original timestamp, unknown last", async () => {
      const data = await (await request("/feed")).json();
      assert.deepEqual(
        data.articles.map((a: any) => a.title),
        ["New", "Old", "Missing date"],
      );
      assert.equal(data.articles[2].published_at, null);
    });
    await t.test(
      "repeat scans deduplicate; new publication is saved",
      async () => {
        let result = await (await request("/refresh", "POST", {})).json();
        assert.equal(result.added, 0);
        newArticle = true;
        result = await (await request("/refresh", "POST", {})).json();
        assert.equal(result.added, 1);
        assert.equal((await repo.feed()).total, 4);
      },
    );
    await t.test(
      "bad source does not prevent another source updating",
      async () => {
        await request("/sources", "POST", {
          url: "https://second.example.org",
        });
        failFirst = true;
        const result = await (await request("/refresh", "POST", {})).json();
        assert.equal(result.failed, 1);
        assert.equal(result.succeeded, 1);
        assert.equal((await repo.sources())[0].last_error, "TIMEOUT");
        assert.equal((await repo.feed()).total, 8);
      },
    );
    await t.test("recovered source clears stale error", async () => {
      failFirst = false;
      await request("/refresh", "POST", {});
      assert.equal((await repo.sources())[0].last_error, null);
    });
    await t.test(
      "concurrent refresh requests share the same scan",
      async () => {
        const a = scanner.scan();
        const b = scanner.scan();
        assert.equal(a, b);
        await a;
      },
    );
    await t.test(
      "browser cross-origin writes and DNS rebinding are rejected",
      async () => {
        assert.equal(
          (
            await fetch(`${base}/api/refresh`, {
              method: "POST",
              headers: {
                Origin: "https://evil.example",
                "Content-Type": "application/json",
                "X-FeedRadar-Request": "1",
              },
              body: "{}",
            })
          ).status,
          403,
        );
        const hostileHost = await new Promise<number | undefined>(
          (resolve, reject) => {
            http
              .get(
                `${base}/api/state`,
                { headers: { Host: "evil.example" } },
                (res) => {
                  res.resume();
                  resolve(res.statusCode);
                },
              )
              .on("error", reject);
          },
        );
        assert.equal(hostileHost, 403);
        assert.equal(
          (
            await fetch(`${base}/api/refresh`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "invalid input and pagination bounds are rejected",
      async () => {
        assert.equal(
          (await request("/sources", "POST", { url: 42 })).status,
          400,
        );
        assert.equal((await request("/feed?limit=1000")).status, 400);
        assert.equal(
          (await request("/sources/not-a-uuid", "DELETE")).status,
          400,
        );
      },
    );
    await t.test(
      "database contents survive a fresh connection/repository",
      async () => {
        const secondPool = new pg.Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: `-c search_path=${schema}`,
        });
        try {
          const secondRepo = new Repository(secondPool);
          assert.equal((await secondRepo.feed()).total, 8);
        } finally {
          await secondPool.end();
        }
      },
    );
    await t.test("automatic scheduler scans without user action", async () => {
      const scheduled = new Scanner(repo, collector, 100, 0);
      scheduled.start();
      await new Promise((r) => setTimeout(r, 1250));
      await scheduled.stop();
      assert(scheduled.lastFinishedAt);
      assert.equal(scheduled.lastResult?.checked, 2);
    });
    await t.test(
      "removal deletes followed source and its articles only",
      async () => {
        assert.equal(
          (await request(`/sources/${firstId}`, "DELETE")).status,
          204,
        );
        assert.equal((await repo.sources()).length, 1);
        assert.equal((await repo.feed()).total, 4);
        assert.equal(
          (await request(`/sources/${firstId}`, "DELETE")).status,
          404,
        );
      },
    );
    await t.test(
      "initial collection failure preserves registration and can recover",
      async () => {
        const original = repo.saveScan;
        repo.saveScan = async () => {
          throw new Error("simulated storage failure");
        };
        let data: any;
        try {
          const response = await request("/sources", "POST", {
            url: "https://storage.example.org",
          });
          assert.equal(response.status, 201);
          data = await response.json();
          assert.equal(data.registrationStatus, "saved");
          assert.equal(data.collectionStatus, "error");
          assert.equal(data.collectionError, "STORAGE_ERROR");
          const stored = (await repo.sources()).find((s) => s.id === data.id)!;
          assert.equal(stored.last_success_at, null);
          assert.equal(stored.article_count, 0);
        } finally {
          repo.saveScan = original;
        }
        await scanner.scan();
        const recovered = (await repo.sources()).find((s) => s.id === data.id)!;
        assert.equal(recovered.last_error, null);
        assert.equal(recovered.article_count, 4);
      },
    );
  } finally {
    await scanner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
