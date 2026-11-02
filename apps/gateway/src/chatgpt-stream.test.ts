import { expect, test } from "vitest";
import { completedResponse } from "./chatgpt-stream.ts";
import { chatgptFailure } from "./chatgpt-errors.ts";
const response = (data: string) =>
  new Response(data, {
    headers: { "content-type": "text/event-stream", "x-request-id": "req_stream" },
  });
test("the SSE completion parser preserves split UTF-8 and CRLF framing", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"😺"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  await expect(
    completedResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } })),
  ).resolves.toBeUndefined();
});
test("top-level stream errors retain quota codes and sanitized request IDs", async () => {
  await expect(
    completedResponse(
      response(
        'data: {"type":"error","code":"subscription_sharing_usage_limit_exceeded","message":"never-store-this"}\n\n',
      ),
    ),
  ).rejects.toMatchObject({
    info: {
      reason: "usage_limit",
      code: "subscription_sharing_usage_limit_exceeded",
      status: 200,
      requestId: "req_stream",
    },
  });
});
test("truncated and contradictory terminal sequences cannot pass admission", async () => {
  for (const data of [
    "data: [DONE]\n\n",
    'data: {"type":"response.completed","response":{"status":"failed"}}\n\n',
    'data: {"type":"response.completed"}\n\ndata: {"type":"response.failed"}\n\n',
  ])
    await expect(completedResponse(response(data))).rejects.toThrow();
});
test("direct admission errors preserve status/body shape without provider diagnostic text", () => {
  expect(chatgptFailure(403, { detail: "private diagnostic" }, "req_admission")).toEqual({
    reason: "account_ineligible",
    code: "CHATGPT_ADMISSION_FAILED",
    status: 403,
    requestId: "req_admission",
    bodyShape: "detail",
  });
  expect(chatgptFailure(400, { error: { code: "refresh_token_reused" } }).reason).toBe(
    "authorization_expired",
  );
});

test("malformed JSON in a stream is interrupted without exposing bytes", async () => {
  await expect(completedResponse(response('data: {"private-secret"\n\n'))).rejects.toMatchObject({
    info: { reason: "interrupted", code: "CHATGPT_STREAM_INTERRUPTED" },
  });
});
