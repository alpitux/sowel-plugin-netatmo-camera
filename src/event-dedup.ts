/**
 * Event de-duplication (spec 001) — the plugin polls `api/getevents` since
 * webhooks aren't usable (dev VM is LAN-only), so every poll re-fetches a
 * window of events and must diff against what's already been emitted as
 * `camera_detection` updates.
 */

export interface NetatmoEvent {
  id: string;
  type: string;
  time: number;
}

/**
 * Returns the events not present in `seenIds`, oldest first — callers
 * should emit them in this order and fold each id into their "seen" set
 * incrementally, so a crash mid-batch doesn't replay already-emitted
 * events on the next poll.
 */
export function newEvents<T extends NetatmoEvent>(
  events: readonly T[],
  seenIds: ReadonlySet<string>,
): T[] {
  return events.filter((e) => !seenIds.has(e.id)).sort((a, b) => a.time - b.time);
}
