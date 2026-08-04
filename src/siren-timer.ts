/**
 * Siren auto-revert (spec 001) — Netatmo models the Presence siren as a
 * state (`siren_status: "sound" | "no_sound"`), but Sowel's
 * `trigger_camera_siren` order contract is a momentary, no-payload action.
 * The plugin honors the momentary contract by setting `"sound"` then
 * scheduling a revert to `"no_sound"` — this isolates that scheduling so
 * it's testable without a real timer/network.
 */

export const SIREN_AUTO_REVERT_MS = 10_000;

export function scheduleSirenRevert(
  revert: () => void,
  scheduler: (fn: () => void, ms: number) => unknown = setTimeout,
  delayMs: number = SIREN_AUTO_REVERT_MS,
): void {
  scheduler(revert, delayMs);
}
