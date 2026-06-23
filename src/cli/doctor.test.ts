import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContractRegistry } from "../registry/contract-registry.js";
import type { ReliabilitySession } from "../replay/recorder.js";
import { ReliabilityStore } from "../replay/store.js";
import { diagnose, formatDoctorReport } from "./doctor.js";

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, ok: 3 } as const;

// Environment integration probes import optional peer deps and add noise that
// varies by install state — every test pins them off for deterministic counts.
const base = { checkIntegrations: false as const };

describe("meridian doctor", () => {
  let registryDir: string;
  let recordingsDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), "meridian-doctor-registry-"));
    recordingsDir = await mkdtemp(join(tmpdir(), "meridian-doctor-recordings-"));
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
    await rm(recordingsDir, { recursive: true, force: true });
  });

  it("reports a healthy, empty workspace as info-only", async () => {
    const report = await diagnose({ ...base, registryDir, recordingsDir });

    expect(report.healthy).toBe(true);
    expect(report.counts.critical).toBe(0);
    expect(report.findings.some((f) => f.area === "registry" && f.severity === "info")).toBe(true);
    expect(report.findings.some((f) => f.area === "recordings" && f.severity === "info")).toBe(
      true,
    );
    // Node check always lands as an environment finding.
    expect(report.findings.some((f) => f.area === "environment")).toBe(true);
  });

  it("ranks findings most-severe-first", async () => {
    const report = await diagnose({ ...base, registryDir, recordingsDir });
    for (let i = 1; i < report.findings.length; i++) {
      expect(SEVERITY_RANK[report.findings[i]!.severity]).toBeGreaterThanOrEqual(
        SEVERITY_RANK[report.findings[i - 1]!.severity],
      );
    }
  });

  it("flags a breaking schema change recorded in the registry", async () => {
    const registry = new ContractRegistry(registryDir);
    await registry.snapshot("openai", "/v1/models", { id: "x", created: 1 });
    // Dropping a field is a breaking (ERROR-severity) drift.
    await registry.snapshot("openai", "/v1/models", { id: "x" });

    const report = await diagnose({ ...base, registryDir, recordingsDir });
    const finding = report.findings.find((f) => f.area === "registry" && /breaking/i.test(f.title));
    expect(finding?.severity).toBe("warning");
    expect(report.healthy).toBe(true); // historical, not blocking
  });

  it("flags schemas that have not been re-verified recently", async () => {
    const registry = new ContractRegistry(registryDir);
    await registry.snapshot("stripe", "/v1/charges", { id: "ch_1" });

    // Look at the registry from 200 days in the future.
    const future = new Date(Date.now() + 200 * 86_400_000);
    const report = await diagnose({ ...base, registryDir, recordingsDir, now: future });

    expect(
      report.findings.some(
        (f) => f.area === "registry" && f.severity === "warning" && /not verified/i.test(f.title),
      ),
    ).toBe(true);
  });

  it("surfaces breaker, failure-rate, and failover signals from a recording", async () => {
    const session: ReliabilitySession = {
      version: 1,
      name: "outage",
      startedAt: "2026-06-23T00:00:00.000Z",
      events: [
        {
          type: "request",
          at: "",
          offsetMs: 0,
          provider: "openai",
          endpoint: "/v1/chat",
          method: "POST",
          requestId: "1",
        },
        {
          type: "error",
          at: "",
          offsetMs: 10,
          provider: "openai",
          endpoint: "/v1/chat",
          method: "POST",
          requestId: "1",
          circuitBreaker: "CLOSED",
          errorCategory: "provider",
          errorMessage: "500",
          retryable: true,
        },
        {
          type: "request",
          at: "",
          offsetMs: 20,
          provider: "anthropic",
          endpoint: "/v1/chat",
          method: "POST",
          requestId: "2",
        },
        {
          type: "error",
          at: "",
          offsetMs: 30,
          provider: "openai",
          endpoint: "/v1/chat",
          method: "POST",
          requestId: "3",
          circuitBreaker: "OPEN",
          errorCategory: "provider",
          errorMessage: "breaker",
          retryable: false,
        },
        {
          type: "response",
          at: "",
          offsetMs: 40,
          provider: "anthropic",
          endpoint: "/v1/chat",
          method: "POST",
          requestId: "2",
          statusCode: 200,
          duration: 50,
        },
      ],
    };
    await new ReliabilityStore(recordingsDir).save(session);

    const report = await diagnose({ ...base, registryDir, recordingsDir });
    const rec = report.findings.filter((f) => f.area === "recordings");

    expect(rec.some((f) => f.severity === "warning" && /breaker opened/i.test(f.title))).toBe(true);
    expect(rec.some((f) => f.severity === "warning" && /failed/i.test(f.title))).toBe(true);
    expect(rec.some((f) => f.severity === "info" && /failover/i.test(f.title))).toBe(true);
  });

  it("renders a sectioned, human-readable audit", async () => {
    const report = await diagnose({ ...base, registryDir, recordingsDir });
    const text = formatDoctorReport(report);

    expect(text).toContain("Meridian doctor");
    expect(text).toContain("Environment");
    expect(text).toContain("Contract registry");
    expect(text).toContain("Reliability recordings");
    expect(text).toMatch(/Healthy|Action required/);
  });
});
