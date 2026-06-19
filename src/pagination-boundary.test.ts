/**
 * Regression: paginate() must not raise the "Pagination limit reached" guard
 * when results end naturally on exactly the maxPages-th page.
 *
 * The internal cap is 1000 pages. A run that legitimately finishes on page 1000
 * (the 1000th response has no `next` link) used to fall through to the post-loop
 * `pageCount >= maxPages` check and throw — *after* every page had already been
 * yielded. The loop now `return`s on natural completion so the limit error only
 * fires when pagination was actually truncated by the cap.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Meridian, type ProviderClient } from "./public.js";

const MAX_PAGES = 1000;

/** Stub fetch so GitHub-style pagination yields `lastPage` pages total: every
 *  page below `lastPage` carries a rel="next" Link header; the last one does not. */
function stubPagedFetch(lastPage: number): void {
  (globalThis as any).fetch = async (url: string | Request | URL) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const page = Number.parseInt(new URL(urlStr).searchParams.get("page") ?? "1", 10);

    const headers = new Headers({ "content-type": "application/json" });
    if (page < lastPage) {
      headers.set("Link", `<https://api.github.com/items?page=${page + 1}>; rel="next"`);
    }

    const data = [{ page }];
    return {
      ok: true,
      status: 200,
      headers,
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as Response;
  };
}

describe("paginate() maxPages boundary", () => {
  let github: ProviderClient;

  beforeEach(async () => {
    const client = await Meridian.create({
      github: {
        auth: { token: "test-token" },
        // Raise the limiter well above the page count so the 1000 sequential
        // requests aren't throttled into a multi-second queue under the default
        // 10 req/s bucket — this test exercises the loop guard, not rate limits.
        rateLimit: { tokensPerSecond: 1_000_000, maxTokens: 1_000_000 },
      },
      localUnsafe: true,
    });
    github = client.provider("github") as ProviderClient;
  });

  it("completes cleanly when results end exactly on the maxPages-th page", async () => {
    stubPagedFetch(MAX_PAGES);

    let pages = 0;
    for await (const _ of github.paginate("/items")) {
      pages++;
    }

    expect(pages).toBe(MAX_PAGES);
  });

  it("still raises the limit guard when there are more results than the cap", async () => {
    // Page 1000 still advertises a next page → genuinely truncated by the cap.
    stubPagedFetch(MAX_PAGES + 5);

    await expect(async () => {
      for await (const _ of github.paginate("/items")) {
        // drain
      }
    }).rejects.toThrow(/Pagination limit reached/);
  });
});
