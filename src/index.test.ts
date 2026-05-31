import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { SDK_VERSION } from "./core/types.js";
import { Meridian } from "./index.js";

describe("Meridian - Built-in Adapter Auto-Registration", () => {
  it("should auto-register GitHub adapter without explicit adapter parameter", async () => {
    const meridian = await Meridian.create({
      github: {
        auth: { token: "test-token" },
      },
      localUnsafe: true,
    });

    expect(meridian).toBeDefined();

    expect((meridian as any).github).toBeDefined();
  });

  it("should work with nested providers config", async () => {
    const meridian = await Meridian.create({
      providers: {
        github: {
          auth: { token: "test-token" },
        },
      },
      localUnsafe: true,
    });

    expect(meridian).toBeDefined();
    expect((meridian as any).github).toBeDefined();
  });
});

describe("Meridian - Version Consistency", () => {
  it("should expose SDK_VERSION that matches package.json.version", () => {
    expect(SDK_VERSION).toBe(packageJson.version);
  });
});
