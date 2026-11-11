import { GoogleAuth } from "google-auth-library";
import type { TaskMessage } from "./task-store.ts";
import { AppError } from "./types.ts";

export type Publisher = { publish(messages: TaskMessage[]): Promise<void> };
type Requester = {
  request(options: {
    url: string;
    method: "POST";
    data: unknown;
    timeout: number;
    retry: boolean;
  }): Promise<{ data: { messageIds?: string[] } }>;
};
export class PubSubPublisher implements Publisher {
  private auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/pubsub"],
  });
  constructor(
    private topic: string,
    private requester?: Requester,
  ) {
    if (
      !/^projects\/[a-z][a-z0-9-]+\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(
        topic,
      )
    )
      throw new Error("Invalid PUBSUB_TOPIC (full resource name required)");
  }
  async publish(messages: TaskMessage[]) {
    if (!messages.length) return;
    const client = this.requester ?? (await this.auth.getClient());
    const response = await client.request({
      url: `https://pubsub.googleapis.com/v1/${this.topic}:publish`,
      method: "POST",
      data: {
        messages: messages.map((m) => ({
          data: Buffer.from(JSON.stringify(m)).toString("base64"),
        })),
      },
      timeout: 20000,
      retry: false,
    });
    if (
      (response.data as { messageIds?: string[] }).messageIds?.length !==
      messages.length
    )
      throw new AppError("PUBLISH_FAILED", "", 503);
  }
}
export function decodeTask(data: unknown): TaskMessage {
  if (
    typeof data !== "string" ||
    data.length > 4096 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    throw new AppError("INVALID_TASK", "", 400);
  let m;
  try {
    m = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    throw new AppError("INVALID_TASK", "", 400);
  }
  if (
    m?.version !== 1 ||
    typeof m.taskId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      m.taskId,
    )
  )
    throw new AppError("INVALID_TASK", "", 400);
  return { version: 1, taskId: m.taskId };
}
