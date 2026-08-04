import { describe, it, expect } from "vitest";
import { isSupportedCameraType, capabilitiesFor } from "./capability-map.js";

describe("isSupportedCameraType", () => {
  it("supports the Presence (NOC)", () => {
    expect(isSupportedCameraType("NOC")).toBe(true);
  });

  it("does not support the Indoor Camera Advance (NPC) — out of scope for v1", () => {
    expect(isSupportedCameraType("NPC")).toBe(false);
  });

  it("does not support the Doorbell (NDB) — never in scope", () => {
    expect(isSupportedCameraType("NDB")).toBe(false);
  });

  it("does not support unknown types", () => {
    expect(isSupportedCameraType("NACamera")).toBe(false);
  });
});

describe("capabilitiesFor", () => {
  it("gives the Presence floodlight + siren", () => {
    expect(capabilitiesFor("NOC")).toEqual({ hasFloodlight: true, hasSiren: true });
  });

  it("gives unsupported/unknown types neither", () => {
    expect(capabilitiesFor("NPC")).toEqual({ hasFloodlight: false, hasSiren: false });
    expect(capabilitiesFor("NDB")).toEqual({ hasFloodlight: false, hasSiren: false });
  });
});
