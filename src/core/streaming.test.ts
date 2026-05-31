import { afterEach, describe, expect, it, vi } from "vitest";
import { Meridian } from "../index.js";
import { type StreamChunk, parseSSEStream } from "./streaming.js";

/** Build a ReadableStream that emits the given string fragments as UTF-8 bytes. */
function streamFromFragments(fragments: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const fragment of fragments) {
        controller.enqueue(encoder.encode(fragment));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of parseSSEStream(stream)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("parseSSEStream", () => {
  it("parses multiple JSON events", async () => {
    const stream = streamFromFragments(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.data).toEqual({ n: 1 });
    expect(chunks[1]?.data).toEqual({ n: 2 });
    expect(chunks[0]?.raw).toBe('{"n":1}');
  });

  it("concatenates multi-line data fields with newlines", async () => {
    const stream = streamFromFragments(["data: line1\ndata: line2\n\n"]);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toBe("line1\nline2");
    expect(chunks[0]?.raw).toBe("line1\nline2");
  });

  it("skips the terminal [DONE] sentinel", async () => {
    const stream = streamFromFragments(['data: {"ok":true}\n\n', "data: [DONE]\n\n"]);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toEqual({ ok: true });
  });

  it("yields the raw string when the payload is not JSON", async () => {
    const stream = streamFromFragments(["data: hello world\n\n"]);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toBe("hello world");
    expect(chunks[0]?.raw).toBe("hello world");
  });

  it("handles events split across chunk boundaries", async () => {
    const stream = streamFromFragments(['data: {"par', 't":1,', '"done":true}', "\n\n"]);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toEqual({ part: 1, done: true });
  });

  it("captures the event field", async () => {
    const stream = streamFromFragments(['event: message\ndata: {"x":1}\n\n']);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.event).toBe("message");
    expect(chunks[0]?.data).toEqual({ x: 1 });
  });

  it("flushes a trailing event with no terminal blank line", async () => {
    const stream = streamFromFragments(['data: {"last":true}\n']);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toEqual({ last: true });
  });

  it("handles \\r\\n line endings", async () => {
    const stream = streamFromFragments(['event: ping\r\ndata: {"a":1}\r\n\r\n']);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.event).toBe("ping");
    expect(chunks[0]?.data).toEqual({ a: 1 });
  });

  it("ignores comment lines", async () => {
    const stream = streamFromFragments([": keep-alive\n\n", 'data: {"v":9}\n\n']);
    const chunks = await collect(stream);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.data).toEqual({ v: 9 });
  });
});

describe("Meridian provider .stream()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams SSE chunks from the openai client", async () => {
    const sse = streamFromFragments([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const meridian = await Meridian.create({
      openai: {
        auth: { token: "sk-test" },
      },
      localUnsafe: true,
    });

    const client = meridian.provider("openai");
    expect(client).toBeDefined();

    const received: string[] = [];
    for await (const chunk of client!.stream<{
      choices: { delta: { content: string } }[];
    }>("/v1/chat/completions", {
      method: "POST",
      body: { model: "gpt-4", messages: [] },
    })) {
      received.push(chunk.data.choices[0]!.delta.content);
    }

    expect(received).toEqual(["Hello", " world"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("throws a normalized MeridianError on a non-ok streaming response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const meridian = await Meridian.create({
      openai: {
        auth: { token: "sk-test" },
      },
      localUnsafe: true,
    });

    const client = meridian.provider("openai");

    await expect(async () => {
      for await (const _chunk of client!.stream("/v1/chat/completions", {
        method: "POST",
        body: {},
      })) {
        // no-op
      }
    }).rejects.toMatchObject({ status: 401, category: "auth" });
  });
});
