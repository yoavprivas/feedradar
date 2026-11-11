import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decodeTask, PubSubPublisher } from "../backend/pubsub.ts";

test("Pub/Sub publishes real REST envelopes using existing Google auth client", async () => {
  const taskId = randomUUID();
  let calls = 0;
  const publisher = new PubSubPublisher(
    "projects/test-project/topics/feedradar-scans",
    {
      request: async (options) => {
        calls++;
        assert.equal(
          options.url,
          "https://pubsub.googleapis.com/v1/projects/test-project/topics/feedradar-scans:publish",
        );
        assert.equal(options.method, "POST");
        assert.equal(options.timeout, 20000);
        const data = options.data as { messages: { data: string }[] };
        assert.deepEqual(decodeTask(data.messages[0].data), {
          version: 1,
          taskId,
        });
        return { data: { messageIds: ["server-message-id"] } };
      },
    },
  );
  await publisher.publish([]);
  assert.equal(calls, 0);
  await publisher.publish([{ version: 1, taskId }]);
  assert.equal(calls, 1);
});
test("Pub/Sub rejects malformed tasks, topic names and incomplete publish acknowledgments", async () => {
  for (const data of [
    null,
    "",
    "!bad",
    Buffer.from("null").toString("base64"),
    Buffer.from(JSON.stringify({ version: 2, taskId: randomUUID() })).toString(
      "base64",
    ),
    Buffer.from(JSON.stringify({ version: 1, taskId: "bad" })).toString(
      "base64",
    ),
  ])
    assert.throws(() => decodeTask(data), { code: "INVALID_TASK" });
  assert.throws(() => new PubSubPublisher("https://evil.example/topic"));
  const publisher = new PubSubPublisher(
    "projects/test-project/topics/feedradar-scans",
    { request: async () => ({ data: {} }) },
  );
  await assert.rejects(
    publisher.publish([{ version: 1, taskId: randomUUID() }]),
    { code: "PUBLISH_FAILED" },
  );
});
