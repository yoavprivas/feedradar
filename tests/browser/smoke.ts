import "dotenv/config";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import pg from "pg";
import { Repository } from "../../backend/db.ts";
import { Collector } from "../../backend/collector.ts";
import { Scanner } from "../../backend/scanner.ts";
import { createApp } from "../../backend/app.ts";
import { hashPassword } from "../../backend/security.ts";
import { QueuedScanner } from "../../backend/queued-scanner.ts";
import { TaskStore } from "../../backend/task-store.ts";
import { TaskWorker } from "../../backend/task-worker.ts";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL required");
const schema = `test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${schema}`,
});
const repo = new Repository(pool);
await repo.migrate();
let latest = false;
const collector = new Collector({
  get: async (url) => ({
    url,
    status: 200,
    contentType: "application/feed+json",
    text: JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "אתר בדיקה",
      items: [
        {
          title: "כתבה ראשונה",
          url: "https://fixture.example/one",
          date_published: "2026-11-08T10:00:00Z",
        },
        ...(latest
          ? [
              {
                title: "כתבה חדשה",
                url: "https://fixture.example/two",
                date_published: "2026-11-09T10:00:00Z",
              },
            ]
          : []),
      ],
    }),
  }),
});
const queued = process.env.BROWSER_SCAN_MODE === "pubsub";
const worker = new TaskWorker(new TaskStore(repo), collector);
const deliveries = new Set<Promise<void>>();
const deliveryErrors: unknown[] = [];
const scanner = queued
  ? new QueuedScanner(
      new TaskStore(repo),
      {
        publish: async (messages) => {
          // Simulated transport for browser behavior only; real GCP delivery is a release gate.
          for (const message of messages) {
            const delivery = new Promise<void>((r) => setTimeout(r, 150))
              .then(() => worker.process(message.taskId))
              .catch((error) => {
                deliveryErrors.push(error);
              });
            deliveries.add(delivery);
            void delivery.finally(() => deliveries.delete(delivery));
          }
        },
      },
      3600000,
      0,
    )
  : new Scanner(repo, collector, 3600000, 0);
const password = "browser-fixture-password";
const app = createApp(repo, collector, scanner, path.resolve("dist"), {
  authMode: "password",
  passwordHash: await hashPassword(password),
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByLabel("סיסמת מנהל").fill("wrong");
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByLabel("סיסמת מנהל").fill(password);
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await page
    .getByRole("heading", { name: "פיד הכתבות", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "ניהול אתרים" }).click();
  await page.getByLabel("כתובת האתר").fill("https://fixture.example");
  await page.getByRole("button", { name: "הוספת אתר", exact: true }).click();
  await page.getByRole("heading", { name: "אתר בדיקה", exact: true }).waitFor();
  await page.getByRole("button", { name: "חזרה לפיד", exact: true }).click();
  await page
    .getByRole("heading", { name: "כתבה ראשונה", exact: true })
    .waitFor();
  latest = true;
  await page.getByRole("button", { name: "רענון הפיד", exact: true }).click();
  await page.getByRole("heading", { name: "כתבה חדשה", exact: true }).waitFor();
  await mkdir("test-results", { recursive: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: `test-results/${queued ? "stage-c" : "stage-b"}-${width}.png`,
      fullPage: true,
    });
  }
  await page.reload();
  await page.getByRole("heading", { name: "כתבה חדשה", exact: true }).waitFor();
  await page.getByRole("button", { name: "יציאה", exact: true }).click();
  await page.getByLabel("סיסמת מנהל").waitFor();
  assert.equal((await context.request.get(base + "/api/feed")).status(), 401);
  assert.deepEqual(errors, []);
  assert.deepEqual(deliveryErrors, []);
  console.log(
    `Browser passed (${queued ? "queued, simulated transport" : "sync"}): login/rejection, add, collection, refresh, persistence on reload, logout, RTL widths 320/390/768/1440, no page errors.`,
  );
} finally {
  await browser?.close();
  worker.stop();
  await Promise.allSettled([...deliveries]);
  await scanner.stop();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
