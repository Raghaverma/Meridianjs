import { describe, expect, it, vi } from "vitest";
import { MemoryStateStorage } from "../state/memory.js";
import { SharedCooldownManager } from "./shared-cooldown.js";

describe("SharedCooldownManager", () => {
  it("records a cooldown and returns the remaining seconds", async () => {
    const storage = new MemoryStateStorage();
    const mgr = new SharedCooldownManager(storage);

    await mgr.recordCooldown("stripe", 30);
    const remaining = await mgr.getCooldownSeconds("stripe");

    // Remaining should be close to 30 (allow 1s of test execution drift).
    expect(remaining).toBeGreaterThan(28);
    expect(remaining).toBeLessThanOrEqual(30);
  });

  it("returns 0 for an unknown provider", async () => {
    const mgr = new SharedCooldownManager(new MemoryStateStorage());
    expect(await mgr.getCooldownSeconds("openai")).toBe(0);
  });

  it("returns 0 once the cooldown has expired", async () => {
    const storage = new MemoryStateStorage();
    const mgr = new SharedCooldownManager(storage);

    // Write an already-expired entry (expiry in the past).
    await storage.set("meridian:cooldown:github", String(Date.now() - 1000));
    expect(await mgr.getCooldownSeconds("github")).toBe(0);
  });

  it("ignores recordCooldown calls with non-positive retryAfter", async () => {
    const storage = new MemoryStateStorage();
    const mgr = new SharedCooldownManager(storage);

    await mgr.recordCooldown("stripe", 0);
    await mgr.recordCooldown("stripe", -5);
    expect(await mgr.getCooldownSeconds("stripe")).toBe(0);
  });

  it("scopes cooldowns per provider", async () => {
    const storage = new MemoryStateStorage();
    const mgr = new SharedCooldownManager(storage);

    await mgr.recordCooldown("stripe", 60);
    expect(await mgr.getCooldownSeconds("stripe")).toBeGreaterThan(0);
    expect(await mgr.getCooldownSeconds("openai")).toBe(0);
  });

  it("respects a custom key prefix", async () => {
    const storage = new MemoryStateStorage();
    const mgr = new SharedCooldownManager(storage, "acme:ratelimit:");

    await mgr.recordCooldown("stripe", 10);
    // Default prefix should not see the key.
    const defaultMgr = new SharedCooldownManager(storage);
    expect(await defaultMgr.getCooldownSeconds("stripe")).toBe(0);
    // Custom prefix should.
    expect(await mgr.getCooldownSeconds("stripe")).toBeGreaterThan(0);
  });

  describe("cross-process simulation", () => {
    it("a cooldown published by one manager is visible to another sharing the same storage", async () => {
      const sharedStorage = new MemoryStateStorage();

      // Simulate process A hitting a 429.
      const mgrA = new SharedCooldownManager(sharedStorage);
      await mgrA.recordCooldown("anthropic", 45);

      // Simulate process B checking before its next acquire.
      const mgrB = new SharedCooldownManager(sharedStorage);
      const seenByB = await mgrB.getCooldownSeconds("anthropic");

      expect(seenByB).toBeGreaterThan(0);
    });

    it("process B sees 0 once the cooldown window expires", async () => {
      const sharedStorage = new MemoryStateStorage();

      // Manually write an expired entry to simulate a lapsed cooldown.
      await sharedStorage.set("meridian:cooldown:anthropic", String(Date.now() - 500));

      const mgrB = new SharedCooldownManager(sharedStorage);
      expect(await mgrB.getCooldownSeconds("anthropic")).toBe(0);
    });
  });
});
