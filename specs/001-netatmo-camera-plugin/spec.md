# Spec 001 — sowel-plugin-netatmo-camera

## Context

Romain owns two Netatmo Security cameras: a **Presence** (outdoor, model
`NOC`) and a **Welcome** (indoor, model `NACamera`). This plugin binds them
into the `camera` equipment type introduced by `mchacher/sowel` spec 133
(core Sowel, already implemented on `alpitux/sowel:feat/camera-equipment-type`,
not yet merged/tested live).

This is the **first** camera plugin, validating spec 133's contract against
a real vendor before Eufy/Foscam plugins are attempted. Auth reuses the
proven `client_id` + `refresh_token` pattern from `sowel-plugin-legrand-energy`
(same Netatmo OAuth server), but with a **new, dedicated Netatmo dev app** —
the Security API scopes are different from the Energy API scopes
`legrand_energy` uses, and mixing them in one app is unnecessary coupling.

Romain's dev VM (`192.168.10.250`) is **strictly LAN**, no public exposure —
so Netatmo webhooks (which require a publicly reachable callback URL) are
**not usable**. All state and event retrieval is by polling, the same
pattern `legrand_energy` already uses successfully.

## API research (spec 133 Phase 1.3 — done ahead of live testing)

Romain doesn't have a dev.netatmo.com app yet, so the exact request/response
shapes below couldn't be verified against his real account before writing
this spec. They're sourced from the actively-maintained
[`pyatmo`](https://github.com/jabesq-org/pyatmo) Python library (used by
Home Assistant's official Netatmo integration) rather than guessed — but
**must still be confirmed against Romain's real cameras during Phase 1.3
live testing**, before the implementation is considered done. Anything
below marked "to confirm" is a first real test target, not an assumption to
code blindly against.

| Concern | Endpoint | Notes |
|---|---|---|
| OAuth token | `POST https://api.netatmo.com/oauth2/token` | Same server as `legrand_energy`. `grant_type=refresh_token`. |
| Scopes | `read_camera`, `access_camera`, `read_presence`, `access_presence`, `write_presence` | To confirm exact set needed for monitoring toggle — `write_camera` may also be required (source split monitoring from Presence-specific writes). |
| Discovery | `POST api/homesdata` | Returns `homes[].cameras[]`: `id`, `type` (`NACamera`=Welcome, `NOC`=Presence, `NDB`=Doorbell — not owned, out of scope), `name`, `vpn_url`, `is_local`. |
| Live state | `POST api/homestatus` | Per-module current state: `monitoring`, `sd_status`, `alim_status`, and (Presence) `floodlight` mode. |
| Local resolution | `GET {vpn_url}/command/ping` | Returns `{ local_url }` if the camera is reachable on the same LAN as wherever this poll runs (i.e. the Sowel dev VM). Prefer `local_url` over `vpn_url` when present — lower latency, no Netatmo relay bandwidth. |
| Snapshot | `GET {local_url or vpn_url}/live/snapshot_720.jpg` | Feeds `camera_snapshot_url`. |
| Live stream | `GET {local_url or vpn_url}/live/files/high/index.m3u8` | HLS, feeds `camera_stream_url`. Sourced from Home Assistant's integration (`quality` defaults to `"high"`); older references show a slightly different path (`/live/index.m3u8`) depending on firmware — **first thing to confirm live**. |
| Monitoring on/off | `POST api/setstate` `{ modules: [{ id, monitoring: "on"\|"off" }] }` | Maps to `camera_monitoring` (data) + `set_camera_monitoring` (order). Whether a `home: { id, ... }` wrapper is also required (like floodlight/siren below) is to confirm. |
| Presence floodlight | `POST api/setstate` `{ home: { id, modules: [{ id, floodlight: "on"\|"off"\|"auto" }] } }` | Maps to `camera_light_mode` (data) + `set_camera_light_mode` (order). **Presence (`NOC`) only** — Welcome doesn't expose this; the plugin simply doesn't emit these keys for a `NACamera` device (spec 133 polymorphism). |
| Presence siren | `POST api/setstate` `{ home: { id, modules: [{ id, siren_status: "sound"\|"no_sound" }] } }` | Netatmo models the siren as a **state**, not a momentary pulse — but spec 133's `trigger_camera_siren` is a no-payload action. This plugin sends `"sound"`, then auto-reverts to `"no_sound"` after a fixed duration (default 10s, TBD during testing) — the momentary-action contract is honored, the stateful reality is hidden inside the plugin. **Presence only**, same reasoning as floodlight. |
| Events | `POST api/getevents` (`home_id`, optionally `event_id` cursor for `geteventsuntil`-style pagination) | Returns `events_list`. Confirmed `type` values include `"person"`, `"movement"`; Presence-specific `"animal"` / `"vehicle"` types are expected but **unconfirmed** — first thing to check against Romain's real Presence events. |

## Goals

1. Discover Romain's Presence and Welcome as Sowel devices, each exposing:
   - `camera_snapshot_url`, `camera_stream_url`, `camera_monitoring` (data)
     + `set_camera_monitoring` (order) — both camera types.
   - `camera_light_mode` (data) + `set_camera_light_mode` (order) —
     **Presence only**.
   - `trigger_camera_siren` (order) — **Presence only**.
   - `camera_detection` (data) — both camera types, opt-in per spec 133
     (not auto-bound).
2. A single poll loop (default interval TBD during testing, starting
   conservative — Netatmo enforces per-app rate limits) that:
   - Calls `homestatus` for state, resolves `local_url` via `ping` (cache
     the resolution — don't re-ping on every single poll tick if the last
     ping succeeded recently), updates device data.
   - Calls `getevents` (or paginated `geteventsuntil`), diffs against the
     last-seen event id/timestamp per camera, emits new `camera_detection`
     data updates for genuinely new events only (no replay on plugin
     restart beyond what's needed to not miss anything).
3. `executeOrder` implements `set_camera_monitoring`, and — for Presence
   devices only — `set_camera_light_mode` and `trigger_camera_siren`.
4. Settings schema: `client_id`, `client_secret` (from the new dev.netatmo.com
   app), `refresh_token` (from Netatmo's Token Generator) — same shape as
   `legrand_energy`'s settings, refresh-token rotation handled the same way
   (`onRefreshTokenUpdated` persisted back to `SettingsManager`).

## Non-Goals

- Doorbell (`NDB`) support — not owned, and it uses WebRTC instead of HLS
  (different code path entirely). Future work if Romain gets one.
- Netatmo webhooks — dev VM has no public exposure. Revisit only if that
  changes.
- Facial recognition / named-person identification (Welcome-specific) —
  out of scope, matches spec 133's non-goals.
- Any UI work — spec 133 already ships the full `camera` equipment type UI;
  this plugin only has to emit correctly-typed device data/orders.
- Modifying spec 133's core contract. If live testing surfaces a mismatch
  serious enough to need a core change, that's a follow-up to spec 133, not
  silently worked around here.

## Manual prerequisite (blocks Phase 1.3 live testing)

Romain does not have a dev.netatmo.com app yet. Before any live API testing
can happen:

1. Create a new app at <https://dev.netatmo.com/apps> (separate from the
   `legrand_energy` one), scoped to Security (`read_camera`, `access_camera`,
   `read_presence`, `access_presence`, `write_presence`, and possibly
   `write_camera` — confirm which the app-creation UI actually offers).
2. Generate a refresh token via Netatmo's Token Generator for that app,
   with the same scopes.
3. Hand `client_id` / `client_secret` / `refresh_token` over (not committed
   anywhere — same handling as `legrand_energy`'s settings).

## Acceptance Criteria

- [ ] Plugin authenticates against Netatmo using `client_id` +
      `refresh_token`, matching `legrand_energy`'s proven bridge pattern.
- [ ] `homesdata` discovery creates one Sowel device per camera
      (`Presence`, `Welcome`), correctly typed.
- [ ] Poll loop updates `camera_snapshot_url` / `camera_stream_url` with a
      currently-fetchable URL (verified by actually hitting spec 133's
      `GET /api/v1/equipments/:id/camera/snapshot` through Sowel and getting
      a real image back — not just checking the plugin's internal state).
- [ ] Local resolution prefers `local_url` when the dev VM and the camera
      are on the same LAN (they are, per Romain's setup) — verified by
      confirming the resolved URL is a `192.168.10.x` address, not a
      Netatmo relay.
- [ ] `set_camera_monitoring` order flips real camera monitoring state,
      confirmed via the Netatmo app or `homestatus`.
- [ ] `set_camera_light_mode` and `trigger_camera_siren` work on the
      Presence, are absent (not just disabled) on the Welcome.
- [ ] A real motion event on either camera shows up as a `camera_detection`
      update within one poll cycle, without duplicates on subsequent polls.
- [ ] Registry entry (`plugins/registry.json` in the `sowel` repo) added
      with `sha256` + `owner` once the first GitHub release exists (spec
      089 workflow).

## Test plan

Given no dev app exists yet, this is a fully live-testing-driven plugin —
there's no meaningful way to unit-test the actual Netatmo wire format ahead
of time. Proposed split:

- **Unit-testable (vitest, this repo)**: event de-duplication logic
  (given a list of previously-seen event ids + a new `events_list`, return
  only the genuinely new ones), device-type → capability mapping (`NOC` vs
  `NACamera` → which data/order keys to emit), and the siren
  sound→no_sound auto-revert timer logic. Pure functions, no network.
- **Live-only**: everything touching the actual Netatmo API — auth,
  discovery, snapshot/stream URL correctness, order dispatch, event
  polling. Verified directly against Romain's account and cameras on the
  dev VM, documented in this spec's follow-up (results appended once
  testing happens), same convention as
  `sowel-plugin-legrand-energy/specs/001-nly-three-phase-meter/`.

## Open questions (to resolve during Phase 1.3 live testing, not blocking spec approval)

- Exact HLS path (`/live/files/high/index.m3u8` vs `/live/index.m3u8` vs
  other) — confirm against Romain's actual firmware versions.
- Whether `monitoring` in `setstate` needs the `home: { id, ... }` wrapper
  or works with just `modules: [...]` at the top level.
- Exact `getevents` event `type` vocabulary for Presence (animal/vehicle)
  vs Welcome (person only, plus named-face ids we won't use).
- Poll interval — start conservative (e.g. 60s, matching spec 133's
  suggested default snapshot refresh), tune based on observed Netatmo rate
  limit headers/errors.
- Siren auto-revert duration (default proposed: 10s).
