import { describe, it, expect, vi } from "vitest";
import { scheduleSirenRevert, SIREN_AUTO_REVERT_MS } from "./siren-timer.js";

describe("scheduleSirenRevert", () => {
  it("schedules the revert callback after the default delay", () => {
    const scheduler = vi.fn();
    const revert = vi.fn();
    scheduleSirenRevert(revert, scheduler);
    expect(scheduler).toHaveBeenCalledWith(revert, SIREN_AUTO_REVERT_MS);
  });

  it("honors a custom delay", () => {
    const scheduler = vi.fn();
    const revert = vi.fn();
    scheduleSirenRevert(revert, scheduler, 5_000);
    expect(scheduler).toHaveBeenCalledWith(revert, 5_000);
  });

  it("does not call revert itself — only schedules it", () => {
    const scheduler = vi.fn();
    const revert = vi.fn();
    scheduleSirenRevert(revert, scheduler);
    expect(revert).not.toHaveBeenCalled();
  });

  it("invokes revert once the scheduler actually fires", () => {
    const revert = vi.fn();
    const scheduler = (fn: () => void) => fn();
    scheduleSirenRevert(revert, scheduler);
    expect(revert).toHaveBeenCalledTimes(1);
  });
});
