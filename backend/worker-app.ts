import express from "express";
import { AppError } from "./types.ts";
import { decodeTask } from "./pubsub.ts";
import type { TaskWorker } from "./task-worker.ts";

export function createWorkerApp(
  worker: TaskWorker,
  options: {
    subscription: string;
    deadSubscription: string;
    verify: (token: string) => Promise<boolean>;
  },
) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use(async (req, _res, next) => {
    // Cloud Run IAM is the outer gate; verify the original JWT again in-app.
    const token = req.headers.authorization;
    const bearer =
      typeof token === "string"
        ? token.match(/^Bearer (\S+)$/)?.[1]
        : undefined;
    if (!bearer || !(await options.verify(bearer).catch(() => false)))
      throw new AppError("UNAUTHORIZED", "", 401);
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.post("/internal/tasks", async (req, res) => {
    if (req.body?.subscription !== options.subscription)
      throw new AppError("FORBIDDEN", "", 403);
    const task = decodeTask(req.body?.message?.data);
    await worker.process(task.taskId);
    res.status(204).end(); // ACK only after the committed database transaction.
  });
  app.post("/internal/dead-letter", async (req, res) => {
    if (req.body?.subscription !== options.deadSubscription)
      throw new AppError("FORBIDDEN", "", 403);
    const data = req.body?.message?.data;
    let task;
    try {
      task = decodeTask(data);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "INVALID_TASK")
        throw error;
      // Poison payloads must not loop forever; raw data remains in the retained DL subscription.
      console.error(JSON.stringify({ event: "dead_letter_invalid" }));
    }
    if (task) {
      await worker.tasks.dead(task.taskId);
      console.error(
        JSON.stringify({ event: "task_dead_letter", taskId: task.taskId }),
      );
    }
    res.status(204).end();
  });
  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        error instanceof AppError
          ? error.status
          : error.type === "entity.too.large"
            ? 413
            : error.type === "entity.parse.failed"
              ? 400
              : 503;
      console.error(
        JSON.stringify({
          event: "worker_request_failed",
          code: error instanceof AppError ? error.code : "WORKER_ERROR",
        }),
      );
      res
        .status(status)
        .json({
          error: error instanceof AppError ? error.code : "WORKER_ERROR",
        });
    },
  );
  return app;
}
