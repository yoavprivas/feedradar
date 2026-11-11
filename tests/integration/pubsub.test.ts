import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Repository } from "../../backend/db.ts";
import { Collector } from "../../backend/collector.ts";
import { AppError, type Entry } from "../../backend/types.ts";
import { TaskStore, type TaskMessage } from "../../backend/task-store.ts";
import { TaskWorker } from "../../backend/task-worker.ts";
import { QueuedScanner } from "../../backend/queued-scanner.ts";
import { createApp } from "../../backend/app.ts";
import { createWorkerApp } from "../../backend/worker-app.ts";
import { hashPassword } from "../../backend/security.ts";

test("Pub/Sub durable jobs and authenticated HTTP worker (isolated PostgreSQL, simulated delivery)", async (t) => {
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
  const tasks = new TaskStore(repo);
  let published: TaskMessage[] = [],
    unavailable = false,
    fail = false,
    calls = 0;
  const publisher = {
    publish: async (messages: TaskMessage[]) => {
      if (unavailable && messages.length) throw new Error("transport outage");
      published.push(...messages);
    },
  };
  const collector = new Collector({
    get: async () => {
      throw new Error("unused");
    },
  });
  const entries: Entry[] = [
    {
      title: "Test article",
      url: "https://fixture.example/article",
      publishedAt: null,
    },
  ];
  collector.collect = async () => {
    calls++;
    if (fail) throw new AppError("TIMEOUT");
    return entries;
  };
  const scanner = new QueuedScanner(tasks, publisher, 3600000, 0);
  const worker = new TaskWorker(tasks, collector);
  const subscription = "projects/test-project/subscriptions/feedradar-worker";
  const deadSubscription =
    "projects/test-project/subscriptions/feedradar-dead-status";
  const app = createApp(repo, collector, scanner, undefined, {
    schedulerMode: "external",
    schedulerJob: "test-job",
    verifyScheduler: async (token) => token === "scheduler-test-token",
  }).listen(0, "127.0.0.1");
  const work = createWorkerApp(worker, {
    subscription,
    deadSubscription,
    verify: async (token) => token === "push-test-token",
  }).listen(0, "127.0.0.1");
  await Promise.all(
    [app, work].map((s) => new Promise<void>((r) => s.once("listening", r))),
  );
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const workerBase = `http://127.0.0.1:${(work.address() as any).port}`;
  const request = (url: string, body: unknown, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FeedRadar-Request": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const deliver = (
    id: string,
    dead = false,
    token = "push-test-token",
    sub = dead ? deadSubscription : subscription,
  ) =>
    request(
      workerBase + (dead ? "/internal/dead-letter" : "/internal/tasks"),
      {
        subscription: sub,
        message: {
          data: Buffer.from(
            JSON.stringify({ version: 1, taskId: id }),
          ).toString("base64"),
        },
      },
      { Authorization: `Bearer ${token}` },
    );
  const add = async (n = 1) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++)
      ids.push(
        (
          await repo.addSource({
            name: `Source ${i}`,
            siteUrl: `https://fixture${i}.example`,
            collectionUrl: `https://fixture${i}.example/feed`,
            method: "jsonfeed",
            entries: [],
          })
        ).id,
      );
    return ids;
  };
  const reset = async () => {
    await pool.query("TRUNCATE scan_tasks,scan_batches,sources CASCADE");
    await pool.query(
      "UPDATE scan_control SET last_started_at=NULL,owner=NULL,lease_until=NULL",
    );
    published = [];
    unavailable = false;
    fail = false;
    calls = 0;
  };
  const check = async (name: string, fn: () => Promise<void>) =>
    t.test(name, async () => {
      await reset();
      await fn();
    });
  try {
    await check(
      "batch results and feed remain behind administrator authentication",
      async () => {
        await add();
        const batch = await scanner.scan();
        const protectedApp = createApp(repo, collector, scanner, undefined, {
          authMode: "password",
          passwordHash: await hashPassword("isolated-queue-test-password"),
        }).listen(0, "127.0.0.1");
        await new Promise<void>((r) => protectedApp.once("listening", r));
        try {
          const origin = `http://127.0.0.1:${(protectedApp.address() as any).port}`;
          for (const route of [
            `/api/scans/${batch.batchId}`,
            "/api/feed",
            "/api/state",
          ])
            assert.equal((await fetch(origin + route)).status, 401);
        } finally {
          await new Promise<void>((r) => protectedApp.close(() => r()));
        }
      },
    );
    await check(
      "actual parallel workers process two sources and defer excess work",
      async () => {
        await add(3);
        await scanner.scan();
        const collect = collector.collect;
        let release!: () => void,
          ready!: () => void,
          active = 0,
          peak = 0;
        const hold = new Promise<void>((r) => {
          release = r;
        });
        const started = new Promise<void>((r) => {
          ready = r;
        });
        collector.collect = async () => {
          active++;
          peak = Math.max(peak, active);
          if (active === 2) ready();
          await hold;
          active--;
          return entries;
        };
        const first = worker.process(published[0].taskId),
          second = worker.process(published[1].taskId);
        try {
          await started;
          await assert.rejects(worker.process(published[2].taskId), {
            code: "WORKER_BUSY",
          });
          assert.equal(peak, 2);
        } finally {
          release();
          await Promise.all([first, second]);
          collector.collect = collect;
        }
        await worker.process(published[2].taskId);
        assert.equal((await repo.feed()).total, 3);
      },
    );
    await check(
      "one failing source does not prevent another task committing",
      async () => {
        const [bad] = await add(2);
        const badUrl = (await repo.source(bad))!.collection_url;
        const accepted = await scanner.scan();
        const collect = collector.collect;
        collector.collect = async (source) => {
          if (source.collection_url === badUrl) throw new AppError("TIMEOUT");
          return entries;
        };
        try {
          const outcomes = await Promise.allSettled(
            published.map((m) => worker.process(m.taskId)),
          );
          assert.equal(
            outcomes.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            outcomes.filter((r) => r.status === "rejected").length,
            1,
          );
          assert.equal((await repo.feed()).total, 1);
          const failed = (
            await pool.query("SELECT id FROM scan_tasks WHERE status='retry'")
          ).rows[0].id;
          await tasks.dead(failed);
          const batch = await tasks.batch(accepted.batchId);
          assert.equal(batch.result.succeeded, 1);
          assert.equal(batch.result.failed, 1);
        } finally {
          collector.collect = collect;
        }
      },
    );
    await check(
      "manual API returns 202 without running collection; result survives restart",
      async () => {
        await add();
        const response = await request(base + "/api/refresh", {});
        assert.equal(response.status, 202);
        const result = await response.json();
        assert.equal(result.accepted, true);
        assert.equal(calls, 0);
        assert.equal(published.length, 1);
        assert.equal((await scanner.persistentStatus()).scanning, true);
        assert.equal((await deliver(published[0].taskId)).status, 204);
        const batch = await (
          await fetch(base + `/api/scans/${result.batchId}`)
        ).json();
        assert.equal(batch.status, "complete");
        assert.equal(batch.result.added, 1);
        assert.equal(
          (
            await new QueuedScanner(
              new TaskStore(new Repository(pool)),
              publisher,
              3600000,
            ).persistentStatus()
          ).lastResult?.added,
          1,
        );
      },
    );
    await check(
      "automatic requests and Scheduler retries use the same persisted task",
      async () => {
        await add();
        const time = new Date().toISOString();
        const headers = {
          Authorization: "Bearer scheduler-test-token",
          "X-CloudScheduler-JobName": "test-job",
          "X-CloudScheduler-ScheduleTime": time,
        };
        const a = await request(base + "/internal/scan", {}, headers),
          b = await request(base + "/internal/scan", {}, headers);
        assert.equal(a.status, 202);
        assert.equal(b.status, 202);
        assert.equal((await a.json()).batchId, (await b.json()).batchId);
        assert.equal(published.length, 1);
        assert.equal(calls, 0);
        assert.equal((await deliver(published[0].taskId)).status, 204);
      },
    );
    await check(
      "publisher outage preserves the durable outbox and a later request recovers it",
      async () => {
        await add();
        unavailable = true;
        await assert.rejects(scanner.scan(false, "scheduled:recover"), {
          code: "PUBLISH_FAILED",
        });
        assert.equal((await tasks.outbox()).length, 1);
        unavailable = false;
        const accepted = await scanner.scan(false, "scheduled:recover");
        assert.equal(published.length, 1);
        assert.equal((await tasks.outbox()).length, 0);
        await worker.process(published[0].taskId);
        assert.equal((await tasks.batch(accepted.batchId)).status, "complete");
      },
    );
    await check(
      "redelivery after publish-before-mark and after commit creates no duplicates",
      async () => {
        await add();
        await scanner.scan();
        const id = published[0].taskId;
        await pool.query(
          "UPDATE scan_tasks SET published_at=NULL WHERE id=$1",
          [id],
        );
        await scanner.dispatch();
        assert.equal(published.length, 2);
        assert.equal(published[1].taskId, id);
        await worker.process(id);
        await worker.process(id);
        assert.equal(calls, 1);
        assert.equal((await repo.feed()).total, 1);
      },
    );
    await check(
      "failed collection returns non-ACK, then retries successfully without duplicate articles",
      async () => {
        await add();
        await scanner.scan();
        const id = published[0].taskId;
        fail = true;
        assert.equal((await deliver(id)).status, 400); // non-2xx causes Pub/Sub retry, including source errors.
        assert.equal(
          (await pool.query("SELECT status FROM scan_tasks WHERE id=$1", [id]))
            .rows[0].status,
          "retry",
        );
        fail = false;
        assert.equal((await deliver(id)).status, 204);
        assert.equal((await deliver(id)).status, 204);
        assert.equal((await repo.feed()).total, 1);
        assert.equal(
          (
            await pool.query("SELECT attempts FROM scan_tasks WHERE id=$1", [
              id,
            ])
          ).rows[0].attempts,
          2,
        );
      },
    );
    await check(
      "two tasks can run concurrently; third is deferred; expired owners cannot write",
      async () => {
        await add(3);
        await scanner.scan();
        const [a, b, c] = published.map((m) => m.taskId);
        const owners = await Promise.all([tasks.claim(a), tasks.claim(b)]);
        assert(owners[0] && owners[1]);
        await assert.rejects(tasks.claim(c), { code: "WORKER_BUSY" });
        await assert.rejects(tasks.claim(a), { code: "WORKER_BUSY" });
        await pool.query(
          "UPDATE scan_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
          [a],
        );
        const next = await tasks.claim(a);
        assert(next);
        await assert.rejects(
          repo.saveScan(owners[0].sourceId, entries, undefined, {
            id: a,
            owner: owners[0].owner,
          }),
          { code: "SCAN_LEASE_LOST" },
        );
        await assert.rejects(tasks.renew(a, owners[0].owner), {
          code: "SCAN_LEASE_LOST",
        });
        await repo.saveScan(next.sourceId, entries, undefined, {
          id: a,
          owner: next.owner,
        });
        assert(await tasks.claim(c));
      },
    );
    await check(
      "article writes and task completion roll back together on storage failure",
      async () => {
        await add();
        await scanner.scan();
        const id = published[0].taskId;
        const claim = await tasks.claim(id);
        assert(claim);
        await pool.query(`CREATE FUNCTION fail_task_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status='complete' THEN RAISE EXCEPTION 'simulated storage failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_task BEFORE UPDATE ON scan_tasks FOR EACH ROW EXECUTE FUNCTION fail_task_commit()`);
        try {
          await assert.rejects(
            repo.saveScan(claim.sourceId, entries, undefined, {
              id,
              owner: claim.owner,
            }),
            /simulated storage failure/,
          );
          assert.equal((await repo.feed()).total, 0);
          assert.equal(
            (
              await pool.query("SELECT status FROM scan_tasks WHERE id=$1", [
                id,
              ])
            ).rows[0].status,
            "running",
          );
        } finally {
          await pool.query(
            "DROP TRIGGER fail_task ON scan_tasks; DROP FUNCTION fail_task_commit()",
          );
        }
        await repo.saveScan(claim.sourceId, entries, undefined, {
          id,
          owner: claim.owner,
        });
        assert.equal((await repo.feed()).total, 1);
      },
    );
    await check(
      "worker rejects missing identity, wrong subscription and malformed message",
      async () => {
        await add();
        await scanner.scan();
        const id = published[0].taskId;
        assert.equal((await deliver(id, false, "wrong")).status, 401);
        assert.equal(
          (await deliver(id, false, "push-test-token", "wrong")).status,
          403,
        );
        assert.equal((await deliver("invalid")).status, 400);
        assert.equal(
          (
            await request(
              workerBase + "/internal/tasks",
              { subscription, message: { data: "!bad" } },
              { Authorization: "Bearer push-test-token" },
            )
          ).status,
          400,
        );
        assert.equal(calls, 0);
      },
    );
    await check(
      "dead-letter notification marks failed tasks; duplicates preserve successful results",
      async () => {
        await add();
        const batch = await scanner.scan();
        const id = published[0].taskId;
        fail = true;
        assert.equal((await deliver(id)).status, 400);
        assert.equal((await deliver(id, true)).status, 204);
        const result = await tasks.batch(batch.batchId);
        assert.equal(result.status, "complete");
        assert.equal(result.result.failed, 1);
        assert.equal((await deliver(id)).status, 204);
        assert.equal(calls, 1);
        fail = false;
        const next = await scanner.scan();
        const nextId = published.at(-1)!.taskId;
        await worker.process(nextId);
        assert.equal((await deliver(nextId, true)).status, 204);
        assert.equal((await tasks.batch(next.batchId)).result.succeeded, 1);
      },
    );
    await check(
      "late dead letters cannot override an active lease",
      async () => {
        await add();
        await scanner.scan();
        const id = published[0].taskId;
        const claim = await tasks.claim(id);
        assert(claim);
        assert.equal((await deliver(id, true)).status, 503);
        await repo.saveScan(claim.sourceId, entries, undefined, {
          id,
          owner: claim.owner,
        });
        assert.equal((await deliver(id, true)).status, 204);
        assert.equal(
          (await pool.query("SELECT status FROM scan_tasks WHERE id=$1", [id]))
            .rows[0].status,
          "complete",
        );
      },
    );
    await check(
      "removing a queued source completes its task without recreating deleted data",
      async () => {
        const [source] = await add();
        const batch = await scanner.scan();
        await repo.remove(source);
        await worker.process(published[0].taskId);
        assert.equal((await tasks.batch(batch.batchId)).status, "complete");
        assert.equal((await repo.feed()).total, 0);
      },
    );
    await check(
      "manual cooldown persists and competing batches cannot overlap",
      async () => {
        await add();
        await scanner.scan();
        await assert.rejects(scanner.scan(), { code: "SCAN_IN_PROGRESS" });
        await worker.process(published[0].taskId);
        await assert.rejects(
          new QueuedScanner(tasks, publisher, 3600000, 60000).scan(true),
          { code: "REFRESH_COOLDOWN" },
        );
      },
    );
  } finally {
    worker.stop();
    await Promise.all(
      [app, work].map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
