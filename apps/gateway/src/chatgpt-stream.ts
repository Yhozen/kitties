import { ChatgptProviderError, chatgptError, chatgptFailure } from "./chatgpt-errors.ts";
// Bounded SSE parsing handles split UTF-8, CRLF and multiple data lines. No stream bytes
// are written to diagnostics. A terminal completed event is the only success path.
export async function completedResponse(response: Response): Promise<void> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    chatgptError("CHATGPT_INVALID_STREAM", "interrupted");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    completed = false,
    size = 0;
  const dispatch = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as {
      type?: string;
      response?: { status?: string; error?: unknown };
      error?: unknown;
      code?: string;
      param?: string;
    };
    if (completed) chatgptError("CHATGPT_EVENT_AFTER_COMPLETION", "interrupted");
    if (event.type === "response.failed" || event.type === "error")
      throw new ChatgptProviderError(
        chatgptFailure(
          response.status,
          { error: event.response?.error ?? event.error ?? event },
          response.headers.get("openai-request-id") ??
            response.headers.get("x-request-id") ??
            undefined,
        ),
      );
    if (event.type === "response.incomplete")
      chatgptError("CHATGPT_RESPONSE_INCOMPLETE", "incomplete");
    if (event.type === "response.completed") {
      if (event.response?.status && event.response.status !== "completed")
        chatgptError("CHATGPT_INVALID_TERMINAL", "incomplete");
      completed = true;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      size += value?.length ?? 0;
      if (size > 4 * 1024 * 1024 || buffer.length > 1024 * 1024)
        chatgptError("CHATGPT_STREAM_LIMIT", "interrupted");
      // Normalize complete CRLF pairs only; an isolated trailing CR may span chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
    if (!completed) chatgptError("CHATGPT_STREAM_INTERRUPTED", "interrupted");
  } catch (error) {
    if (error instanceof ChatgptProviderError) throw error;
    chatgptError("CHATGPT_STREAM_INTERRUPTED", "interrupted");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
