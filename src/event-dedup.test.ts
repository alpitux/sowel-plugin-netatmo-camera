import { describe, it, expect } from "vitest";
import { newEvents } from "./event-dedup.js";

describe("newEvents", () => {
  it("returns everything when nothing has been seen yet", () => {
    const events = [
      { id: "a", type: "person", time: 100 },
      { id: "b", type: "movement", time: 200 },
    ];
    expect(newEvents(events, new Set())).toEqual(events);
  });

  it("filters out already-seen event ids", () => {
    const events = [
      { id: "a", type: "person", time: 100 },
      { id: "b", type: "movement", time: 200 },
    ];
    expect(newEvents(events, new Set(["a"]))).toEqual([events[1]]);
  });

  it("returns nothing new when everything has already been seen", () => {
    const events = [{ id: "a", type: "person", time: 100 }];
    expect(newEvents(events, new Set(["a"]))).toEqual([]);
  });

  it("sorts new events oldest-first regardless of input order", () => {
    const events = [
      { id: "b", type: "movement", time: 200 },
      { id: "a", type: "person", time: 100 },
      { id: "c", type: "animal", time: 300 },
    ];
    expect(newEvents(events, new Set()).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty events list", () => {
    expect(newEvents([], new Set(["a"]))).toEqual([]);
  });
});
