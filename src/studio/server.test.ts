import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Meridian } from "../index.js";
import { MockAdapter } from "../testing/mock-adapter.js";
import { createStudioServer, type StudioServerHandle } from "./server.js";

// Captured before any test stubs `globalThis.fetch` — used to talk to the
// real, locally-bound Studio server. The SDK's own outbound requests (made
// through whatever `globalThis.fetch` is at call time) are stubbed separately
// per the project convention: pipeline tests stub fetch, not MockAdapter.
const realFetch = globalThis.fetch;

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("Studio HTTP server", () => {
  let registryDir: string;
  let recordingsDir: string;
  let handle: StudioServerHandle | undefined;
  let meridian: Meridian;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), "meridian-studio-registry-"));
    recordingsDir = await mkdtemp(join(tmpdir(), "meridian-studio-recordings-"));
    (globalThis as any).fetch = async () => {
      const body = { ok: true };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    };
    meridian = await Meridian.create({
      localUnsafe: true,
      observability: [],
      providers: { mock: { auth: { apiKey: "k" }, adapter: new MockAdapter("mock") } },
    });
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    globalThis.fetch = realFetch;
    await rm(registryDir, { recursive: true, force: true });
    await rm(recordingsDir, { recursive: true, force: true });
  });

  describe("standalone (no live Meridian instance)", () => {
    beforeEach(async () => {
      handle = await createStudioServer({ port: 0, registryDir, recordingsDir });
    });

    it("503s every live endpoint", async () => {
      for (const path of ["/api/health", "/api/cost", "/api/providers", "/api/circuit-breakers"]) {
        const res = await realFetch(`${handle!.url}${path}`);
        expect(res.status).toBe(503);
      }
    });

    it("serves disk-backed replay and registry endpoints", async () => {
      const sessions = await json(await realFetch(`${handle!.url}/api/replay/sessions`));
      expect(sessions).toEqual({ sessions: [] });

      const providers = await json(await realFetch(`${handle!.url}/api/registry/providers`));
      expect(providers).toEqual({ providers: [] });
    });

    it("404s unknown routes", async () => {
      const res = await realFetch(`${handle!.url}/api/nope`);
      expect(res.status).toBe(404);
    });

    it("handles CORS preflight", async () => {
      const res = await realFetch(`${handle!.url}/api/health`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    });
  });

  describe("connected to a live Meridian instance", () => {
    beforeEach(async () => {
      handle = await createStudioServer({
        port: 0,
        registryDir,
        recordingsDir,
        meridian,
      });
    });

    it("serves live health, providers, circuit-breakers, and cost", async () => {
      await meridian.provider("mock")!.get("/ok");

      const health = await json(await realFetch(`${handle!.url}/api/health`));
      expect(health.mock).toMatchObject({ status: "healthy" });

      const providers = await json(await realFetch(`${handle!.url}/api/providers`));
      expect(providers.some((p: { name: string }) => p.name === "mock")).toBe(true);

      const breakers = await json(await realFetch(`${handle!.url}/api/circuit-breakers`));
      expect(breakers.mock).toMatchObject({ state: "CLOSED" });

      const cost = await json(await realFetch(`${handle!.url}/api/cost`));
      expect(cost.total.requests).toBe(1);
    });

    it("controls recording over HTTP and surfaces the summary", async () => {
      const status0 = await json(await realFetch(`${handle!.url}/api/recording/status`));
      expect(status0).toEqual({ active: false, sessionName: null });

      const start = await json(
        await realFetch(`${handle!.url}/api/recording/start`, {
          method: "POST",
          body: JSON.stringify({ name: "incident-1" }),
        }),
      );
      expect(start).toEqual({ sessionName: "incident-1" });

      await meridian.provider("mock")!.get("/ok");

      const stop = await json(
        await realFetch(`${handle!.url}/api/recording/stop`, {
          method: "POST",
          body: JSON.stringify({ dir: recordingsDir }),
        }),
      );
      expect(stop.requests).toBe(1);
      expect(stop.succeeded).toBe(1);

      const sessions = await json(await realFetch(`${handle!.url}/api/replay/sessions`));
      expect(sessions.sessions).toEqual(["incident-1"]);

      const replayed = await json(await realFetch(`${handle!.url}/api/replay/sessions/incident-1`));
      expect(replayed.requests).toBe(1);
    });
  });

  describe("auth", () => {
    it("rejects requests without the configured token", async () => {
      handle = await createStudioServer({
        port: 0,
        registryDir,
        recordingsDir,
        authToken: "secret",
      });
      const unauthed = await realFetch(`${handle.url}/api/replay/sessions`);
      expect(unauthed.status).toBe(401);

      const authed = await realFetch(`${handle.url}/api/replay/sessions`, {
        headers: { Authorization: "Bearer secret" },
      });
      expect(authed.status).toBe(200);
    });

    it("refuses to bind to a non-loopback host without a token", async () => {
      await expect(
        createStudioServer({ port: 0, host: "0.0.0.0", registryDir, recordingsDir }),
      ).rejects.toThrow(/Refusing to bind/);
    });
  });

  describe("schema registry endpoints", () => {
    beforeEach(async () => {
      handle = await createStudioServer({ port: 0, registryDir, recordingsDir });
    });

    it("reports endpoints and drift history for a provider", async () => {
      const { ContractRegistry } = await import("../registry/contract-registry.js");
      const registry = new ContractRegistry(registryDir);
      await registry.snapshot("stripe", "/v1/charges", { id: "ch_1", amount: 100 });
      await registry.snapshot("stripe", "/v1/charges", { id: "ch_2", amount: 100, captured: true });

      const providers = await json(await realFetch(`${handle!.url}/api/registry/providers`));
      expect(providers.providers).toEqual(["stripe"]);

      const report = await json(await realFetch(`${handle!.url}/api/registry/stripe`));
      expect(report.endpoints).toHaveLength(1);
      expect(report.endpoints[0]).toMatchObject({ latestVersion: 2 });

      const history = await json(
        await realFetch(
          `${handle!.url}/api/registry/stripe?endpoint=${encodeURIComponent("/v1/charges")}`,
        ),
      );
      expect(history.history).toHaveLength(1);
    });
  });
});
