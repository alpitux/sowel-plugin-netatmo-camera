# Spec 001 — sowel-plugin-netatmo-camera

## Context

Romain owns two Netatmo Security cameras: a **Presence** (outdoor, model
`NOC`) and an **Indoor Camera Advance** (indoor, model `NPC`, released late
2024 — corrected 2026-08-04; earlier drafts of this spec assumed a Welcome
`NACamera`, which he does not own). This plugin binds them into the
`camera` equipment type introduced by `mchacher/sowel` spec 133 (core
Sowel, already implemented on `alpitux/sowel:feat/camera-equipment-type`,
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

## Live API test results (2026-08-04)

Romain created a Netatmo dev app ("Sowel-dev-camera") and generated a
refresh token — with **all available scopes** (confirmed directly by
Romain in the Netatmo account UI, not just what the app-creation form
defaulted to: `read_camera`, `write_camera`, `access_camera`,
`read_presence`, `write_presence`, `access_presence`, plus unrelated
`read_bubendorff`/`write_bubendorff`/`read_magellan`/`write_magellan` from
his other devices sharing the same app — harmless, just unused by this
plugin). This let Phase 1.3 happen for real, ahead of writing any plugin
code, by calling the Netatmo API directly.

**Presence (`NOC`) — fully confirmed working end-to-end:**

- `homesdata` correctly lists it (`type: "NOC"`, home `"Maison"`).
- `homestatus` returns `monitoring`, `floodlight`, and `siren_status`
  **directly in the same response** — no separate local call needed just
  to *read* current state (only `setstate` writes and the actual
  snapshot/stream media fetch need `vpn_url`/local resolution). This
  simplifies the plugin vs. the original plan: the poll loop can populate
  `camera_monitoring` / `camera_light_mode` data straight from
  `homestatus`, and only resolve `local_url` when a snapshot/stream is
  actually about to be fetched (or on its own slower cadence).
- Confirmed real values observed: `monitoring: "on"`, `floodlight: "auto"`,
  `siren_status: "no_sound"`, `vpn_url` present, `is_local: true`.
- HLS path, exact `getevents` type vocabulary, and the `home` wrapper
  question for `setstate` monitoring are still open (see "Open questions")
  — not yet exercised live, only discovery/state-read were tested so far.

**Indoor Camera Advance (`NPC`) — not discoverable via the API, cause external to this project:**

- Absent from `homesdata` and `homestatus` for this home, despite:
  - Romain confirming it's attached to the same Netatmo account and the
    same home ("Maison"), and displaying correctly in the Netatmo Security
    mobile app alongside the Presence.
  - The dev app token having **all available scopes**, ruling out a scope
    gap.
  - The `homesdata` response containing exactly one home, with no
    `disabled_homes_ids`-style filtering — ruling out a hidden/disabled
    home masking the device.
- This matches a **known, externally-reported Netatmo-side issue**: their
  own support has stated the API does support the Welcome, Advance Indoor
  Camera and Siren, yet multiple users report the Advance camera visible
  in the mobile app but absent from `homesdata`/`homestatus` — see
  [Netatmo forum: "Advance et API"](https://helpcenter.netatmo.com/hc/en-us/community/posts/24924930273938-Advance-et-API)
  and [Home Assistant discussion #1879](https://github.com/orgs/home-assistant/discussions/1879)
  (Home Assistant's own Netatmo integration doesn't support the Advance
  yet, for the same underlying reason). Nothing on the request side (params,
  headers, scopes) changes this — confirmed by direct testing against
  Romain's real account, not assumed.
- **Separately, even once discoverable**: the Advance's live view uses
  **WebRTC** (`api/webrtc/offer` / `api/webrtc/terminate`), not HLS. Spec
  133's core media-proxy route (`camera/stream`) only handles HLS-manifest
  rewriting and generic byte passthrough (e.g. MJPEG) — it has no WebRTC
  signaling support. Snapshot (`camera_snapshot_url`) would still work
  the same way as Presence once/if discovery is resolved, since snapshot
  is a plain HTTP JPEG fetch regardless of live-view transport — only
  `camera_stream_url` / live view is blocked on a separate piece of work.

**Decision on how to proceed with the Advance camera**: pending —
see the "Open questions" / next conversation turn. Not blocking Presence
implementation either way.

## Goals

1. Discover Romain's Presence as a Sowel device, exposing:
   - `camera_snapshot_url`, `camera_stream_url`, `camera_monitoring` (data)
     + `set_camera_monitoring` (order).
   - `camera_light_mode` (data) + `set_camera_light_mode` (order).
   - `trigger_camera_siren` (order).
   - `camera_detection` (data), opt-in per spec 133 (not auto-bound).
   Whether/how the Indoor Camera Advance is included in v1 is pending —
   see "Live API test results" above. If included, it would only expose
   `camera_snapshot_url` + `camera_monitoring` + `camera_detection` (no
   `camera_stream_url` — WebRTC not supported by spec 133's proxy yet —
   and no `camera_light_mode`/siren, which are Presence-specific hardware
   anyway).
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
  (different code path entirely, same category of gap as the Advance's
  live view — see below). Future work if Romain gets one.
- **Indoor Camera Advance (`NPC`) live view** — blocked on spec 133 not
  supporting WebRTC signaling. Snapshot/monitoring/detection for the
  Advance are still plausible for v1 (transport-agnostic), pending the
  discovery issue also being resolved (see "Live API test results").
- Netatmo webhooks — dev VM has no public exposure. Revisit only if that
  changes.
- Facial recognition / named-person identification (Advance-specific,
  it also has this like Welcome did) — out of scope, matches spec 133's
  non-goals.
- Any UI work — spec 133 already ships the full `camera` equipment type UI;
  this plugin only has to emit correctly-typed device data/orders.
- Modifying spec 133's core contract. If live testing surfaces a mismatch
  serious enough to need a core change, that's a follow-up to spec 133, not
  silently worked around here. (Adding WebRTC support to spec 133's proxy
  would be exactly this kind of follow-up, not something bolted on here.)

## Manual prerequisite (blocks Phase 1.3 live testing) — DONE 2026-08-04

Romain created a dev.netatmo.com app ("Sowel-dev-camera", separate from the
`legrand_energy` one) and generated a refresh token with all available
scopes. Credentials handed over out-of-band (never committed to this repo
or any spec — same handling as `legrand_energy`'s settings, stored only in
Sowel's `SettingsManager` on the dev VM once the plugin is installed
there).

## Acceptance Criteria

- [ ] Plugin authenticates against Netatmo using `client_id` +
      `refresh_token`, matching `legrand_energy`'s proven bridge pattern.
- [ ] `homesdata` discovery creates a Sowel device for the Presence,
      correctly typed. (Advance: pending scope decision.)
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
      Presence.
- [ ] A real motion event on the Presence shows up as a `camera_detection`
      update within one poll cycle, without duplicates on subsequent polls.
- [ ] Registry entry (`plugins/registry.json` in the `sowel` repo) added
      with `sha256` + `owner` once the first GitHub release exists (spec
      089 workflow).

## Test plan

The dev app now exists and basic discovery/state-read has already been
verified live against Romain's real Presence (see "Live API test
results"). Remaining live verification (orders, snapshot/stream fetch,
events) happens once the plugin is implemented and installed on the dev
VM. Split:

- **Unit-testable (vitest, this repo)**: event de-duplication logic
  (given a list of previously-seen event ids + a new `events_list`, return
  only the genuinely new ones), device-type → capability mapping (`NOC` →
  full capability set; `NPC` → snapshot/monitoring/detection only, if
  included at all), and the siren sound→no_sound auto-revert timer logic.
  Pure functions, no network.
- **Live-only**: everything touching the actual Netatmo API — auth,
  discovery, snapshot/stream URL correctness, order dispatch, event
  polling. Verified directly against Romain's account and cameras on the
  dev VM, documented in this spec's follow-up (results appended once
  testing happens), same convention as
  `sowel-plugin-legrand-energy/specs/001-nly-three-phase-meter/`.

## Open questions

**Blocking, needs Romain's decision:**

- What to do about the Indoor Camera Advance: (a) ship v1 with Presence
  only, revisit the Advance later once its `homesdata` discoverability
  issue is resolved Netatmo-side (and possibly once spec 133 gains WebRTC
  support for its live view), or (b) something else. See "Live API test
  results" above for the full picture.

**Non-blocking, to resolve during remaining Phase 1.3/1.4 live testing:**

- Exact HLS path (`/live/files/high/index.m3u8` vs `/live/index.m3u8` vs
  other) — confirm against the Presence's actual firmware.
- Whether `monitoring` in `setstate` needs the `home: { id, ... }` wrapper
  or works with just `modules: [...]` at the top level.
- Exact `getevents` event `type` vocabulary for the Presence
  (person/movement confirmed conceptually; animal/vehicle unconfirmed).
- Poll interval — start conservative (e.g. 60s, matching spec 133's
  suggested default snapshot refresh), tune based on observed Netatmo rate
  limit headers/errors.
- Siren auto-revert duration (default proposed: 10s).
