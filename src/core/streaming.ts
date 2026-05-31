/**
 * Server-Sent-Events (SSE) streaming support for Meridian.
 *
 * This is an additive, standalone code path. It does NOT touch the buffered
 * request pipeline used by get/post/etc.
 */

export interface StreamChunk<T = unknown> {
  event?: string;
  data: T;
  raw: string;
}

/**
 * Parse a raw SSE event block (the text between two double-newlines) into its
 * `event` name and concatenated `data` payload, following the SSE spec.
 *
 * Returns null when the block contains no `data:` field (e.g. comment-only or
 * empty blocks), which the caller should skip.
 */
function parseEventBlock(block: string): { event?: string; data: string } | null {
  const lines = block.split("\n");
  const dataLines: string[] = [];
  let event: string | undefined;
  let sawData = false;

  for (const rawLine of lines) {
    // Tolerate stray carriage returns from \r\n line endings.
    const line = rawLine.replace(/\r$/, "");
    // SSE comments start with ":" and are ignored.
    if (line.startsWith(":")) {
      continue;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    // SSE spec: a single leading space after the colon is stripped.
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
      sawData = true;
    }
    // Other fields (id, retry) are ignored for v1.
  }

  if (!sawData) {
    return null;
  }

  // Multiple data lines are concatenated with "\n" per the SSE spec.
  const result: { event?: string; data: string } = { data: dataLines.join("\n") };
  if (event !== undefined) {
    result.event = event;
  }
  return result;
}

/**
 * Build a StreamChunk from a parsed event block, attempting to JSON.parse the
 * data payload and falling back to the raw string. Returns null for the
 * terminal sentinel `[DONE]`.
 */
function toChunk(parsed: { event?: string; data: string }): StreamChunk | null {
  const raw = parsed.data;

  // Terminal sentinel — yield nothing.
  if (raw === "[DONE]") {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  const chunk: StreamChunk = { data, raw };
  if (parsed.event !== undefined) {
    chunk.event = parsed.event;
  }
  return chunk;
}

/**
 * Robust SSE parser. Decodes the byte stream, buffers across network chunks,
 * splits on event boundaries (double-newline, tolerant of `\r\n`), parses each
 * event block, and yields a StreamChunk per data event. Skips `[DONE]` and
 * flushes any trailing buffered event when the stream ends.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF so we can split consistently on "\n\n".
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundaryIndex: number;
      // Event blocks are separated by a blank line ("\n\n").
      while ((boundaryIndex = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        const parsed = parseEventBlock(block);
        if (parsed) {
          const chunk = toChunk(parsed);
          if (chunk) {
            yield chunk;
          }
        }
      }
    }

    // Flush any final decoder bytes and trailing buffered event.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n");
    // Drop a single trailing newline left by a well-formed final event.
    if (buffer.endsWith("\n")) {
      buffer = buffer.slice(0, -1);
    }

    if (buffer.length > 0) {
      const parsed = parseEventBlock(buffer);
      if (parsed) {
        const chunk = toChunk(parsed);
        if (chunk) {
          yield chunk;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
