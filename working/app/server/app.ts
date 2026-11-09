import express from "express";
import helmet from "helmet";
import path from "node:path";
import type { Repository } from "./db.ts";
import type { Collector } from "./collector.ts";
import type { Scanner } from "./scanner.ts";
import { AppError } from "./types.ts";
import { normalizeUrl } from "./network.ts";

export function createApp(
  repo: Repository,
  collector: Collector,
  scanner: Scanner,
  staticDir?: string,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "object-src": ["'none'"],
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  // Bound to loopback and reject rebinding and cross-origin browser mutations.
  app.use((req, res, next) => {
    let host: string;
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (
        (origin && origin !== `http://${req.headers.host}`) ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        req.headers["x-feedradar-request"] !== "1" ||
        (req.method !== "DELETE" && !req.is("application/json"))
      ) {
        res.status(403).json({ error: "FORBIDDEN" });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await repo.pool.query("SELECT 1");
    res.json({ status: "ok", database: "postgresql" });
  });
  app.get("/api/state", async (_req, res) => {
    res.json({ sources: await repo.sources(), ...scanner.status() });
  });
  app.get("/api/feed", async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1000000
    )
      throw new AppError("INVALID_INPUT");
    res.json(await repo.feed(limit, offset));
  });
  let adding = false;
  app.post("/api/sources", async (req, res) => {
    if (typeof req.body?.url !== "string" || req.body.url.length > 2048)
      throw new AppError("INVALID_URL");
    if (adding) throw new AppError("ADD_IN_PROGRESS", "", 409);
    const url = normalizeUrl(req.body.url);
    if (await repo.hasSource(url))
      throw new AppError("DUPLICATE_SITE", "", 409);
    if ((await repo.sources()).length >= 50) throw new AppError("SOURCE_LIMIT");
    adding = true;
    try {
      const discovered = await collector.discover(url);
      const { id } = await repo.addSource(discovered);
      try {
        const added = await repo.saveScan(id, discovered.entries);
        res
          .status(201)
          .json({
            id,
            added,
            registrationStatus: "saved",
            collectionStatus: discovered.entries.length ? "ready" : "empty",
          });
      } catch (error) {
        const code = "STORAGE_ERROR";
        await repo.failed(id, code);
        res
          .status(201)
          .json({
            id,
            added: 0,
            registrationStatus: "saved",
            collectionStatus: "error",
            collectionError: code,
          });
      }
    } finally {
      adding = false;
    }
  });
  app.delete("/api/sources/:id", async (req, res) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(req.params.id),
      )
    )
      throw new AppError("INVALID_INPUT");
    if (!(await repo.remove(String(req.params.id))))
      throw new AppError("NOT_FOUND", "", 404);
    res.status(204).end();
  });
  app.post("/api/refresh", async (_req, res) => {
    res.json(await scanner.scan(true));
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get("/", (_req, res) =>
      res.sendFile(path.join(staticDir, "index.html")),
    );
  }
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof AppError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      if (error.type === "entity.parse.failed") {
        res.status(400).json({ error: "INVALID_INPUT" });
        return;
      }
      if (error.type === "entity.too.large") {
        res.status(413).json({ error: "INVALID_INPUT" });
        return;
      }
      console.error(
        "Request failed:",
        typeof error.code === "string" ? error.code : "INTERNAL_ERROR",
      );
      res.status(500).json({ error: "SERVER_ERROR" });
    },
  );
  return app;
}
