# Spec 001 — sowel-plugin-netatmo-camera

## Context

Romain owns two Netatmo Security cameras: a **Presence** (outdoor, model
`NOC`) and an **Indoor Camera Advance** (indoor, model `NPC`, released late
2024 — corrected 2026-08-04; earlier drafts of this spec assumed a Welcome
`NACamera`, which he does not own). **v1 of this plugin targets the
Presence only** — decided 2026-08-04 after live API testing showed the
Advance is currently undiscoverable via the API (external Netatmo-side
issue) and its live view needs WebRTC, which spec 133's proxy doesn't
support yet. See "Live API test results" below for the full picture; the
Advance is revisited in a later iteration, not blocking this one. This
plugin binds into the `camera` equipment type introduced by
`mchacher/sowel` spec 133 (core Sowel, already implemented on
`alpitux/sowel:feat/camera-equipment-type`, not yet merged/tested live).

This is the **first** camera plugin, validating spec 133's contract against
a real vendor before Eufy/Foscam plugins are attempted. Auth reuses the
proven `client_id` + `refresh_token` pattern from `sowel-plugin-legrand-energy`
(same Netatmo OAuth server), but with a **new, dedicated Netatmo dev app** —
the Security API scopes are different from the Energy API scopes
`legrand_energy` uses, and mixing them in one app is unnecessary coupling.

Romain's dev VM (`192.168.10.x`) is **strictly LAN**, no public exposure —
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

All rows below are **confirmed live** against Romain's real Presence
(2026-08-04, see "Live API test results" and the order-dispatch tests
further down) — no more "to confirm" placeholders.

| Concern | Endpoint | Notes |
|---|---|---|
| OAuth token | `POST https://api.netatmo.com/oauth2/token` | Same server as `legrand_energy`. `grant_type=refresh_token`. Refresh token rotates on every call, persisted immediately (`onRefreshTokenUpdated`, same as `legrand_energy`). |
| Scopes | `read_camera`, `write_camera`, `access_camera`, `read_presence`, `write_presence`, `access_presence` | All 6 present on the token's granted scope list. |
| Discovery | `POST api/homesdata` | Devices are a **flat `home.modules[]` array** with a `type` field (`NOC`=Presence, `NPC`=Indoor Camera Advance, `NDB`=Doorbell), same convention `legrand_energy` already parses — **not** a separate `home.cameras[]` array as older docs/libraries suggested. No `vpn_url`/live state here — that's `homestatus`-only. |
| Live state | `POST api/homestatus` | Same flat `home.modules[]` shape; for the Presence returns `monitoring`, `floodlight`, `siren_status` (read-only, see below), `vpn_url`, `is_local`, `sd_status`, `alim_status` **all in one call**. |
| Local resolution | `GET {vpn_url}/command/ping` | Returns `{ local_url }` — but this is the camera's own self-reported LAN address, **not a reachability check from the caller**. On Romain's setup the dev VM and camera are on different subnets with no route between them by default, so the returned `local_url` was unreachable until a network-side filter was removed. The plugin now verifies reachability with a second ping directly against the candidate `local_url` before trusting it, falling back to `vpn_url` otherwise — see `pingLocal()`. |
| Snapshot | `GET {local_url or vpn_url}/live/snapshot_720.jpg` | Feeds `camera_snapshot_url`. Verified end-to-end through Sowel's media-proxy route — a real 1280×720 JPEG of Romain's driveway came back. |
| Live stream | `GET {local_url or vpn_url}/live/files/high/index.m3u8` | HLS, feeds `camera_stream_url`. Path confirmed correct. The manifest's `Content-Type` is `application/octet-stream`, **not** a standard HLS mime type — this broke spec 133's original content-type-based rewrite detection; fixed there (body-sniffs for `#EXTM3U` instead) rather than worked around here. Segments verified fetchable through the proxy (real ~800KB `.ts` MPEG-TS files). |
| Monitoring on/off | `POST api/setstate` `{ home: { id, modules: [{ id, monitoring: "on"\|"off" }] } }` | Maps to `camera_monitoring` (data) + `set_camera_monitoring` (order). The `home` wrapper **is** required — confirmed live (a call without it would be inconsistent with the floodlight call below, which needs it; both now share the same wrapped shape). Verified: toggled off and back on for real, confirmed via `homestatus` each time. |
| Presence floodlight | `POST api/setstate` `{ home: { id, modules: [{ id, floodlight: "on"\|"off"\|"auto" }] } }` | Maps to `camera_light_mode` (data) + `set_camera_light_mode` (order). Verified: set to `"on"`, confirmed via `homestatus`, restored to `"auto"`. |
| Presence siren | — **not supported, confirmed live** | `pyatmo`'s `SirenMixin` applies `siren_status` to the `NOC` class generically, and spec 133 was designed assuming the Presence has one — **wrong for Romain's actual unit**. Sending `{ siren_status: "sound" }` via `setstate` returns Netatmo error `code 21`: `"property /home/modules/0: should NOT have additional properties ['siren_status']"`. `capabilitiesFor("NOC")` now reports `hasSiren: false`; the `siren-timer.ts` module and the `trigger_camera_siren` order binding were removed from this plugin. `siren_status` still appears as a **read-only** field in `homestatus` responses (observed value: `"no_sound"`) — Netatmo may expose it there for other Presence hardware revisions that do have a physical siren; this plugin just never writes to it. |
| Events | `POST api/getevents` (`home_id`, `device_id`) | Returns `{ body: { home: { events: [...] } } }` — **not** a flat list. Each top-level event (`type: "outdoor"` for the Presence) groups one or more `subevents[]`, and it's the *subevent* that carries the real detection `type` (observed: `"human"` — not `"person"` as assumed from older library research) plus its own `id`/`time` and a time-limited `snapshot.url`. The plugin flattens subevents before de-duplication; the per-event snapshot URL isn't surfaced in v1 (see Non-Goals). |

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

**Presence (`NOC`) — fully confirmed working end-to-end**, including
plugin deployment on the real dev VM against the plugin build (not just
raw API calls):

- `homesdata` correctly lists it (`type: "NOC"`, home `"Maison"`).
- `homestatus` returns `monitoring`, `floodlight`, and `siren_status`
  **directly in the same response** — no separate local call needed just
  to *read* current state (only `setstate` writes and the actual
  snapshot/stream media fetch need `vpn_url`/local resolution).
- Plugin deployed to the dev VM (manual install — no registry entry yet,
  see "Manual prerequisite"), discovered the camera as a Sowel device,
  and a bound `camera` equipment fetched a **real snapshot** (1280×720
  JPEG of the actual driveway) through spec 133's media-proxy route.
- Live view: HLS manifest fetched and correctly rewritten, a real ~800KB
  `.ts` segment fetched through the sub-resource proxy — full pipeline
  verified, not just the manifest.
- Orders verified for real: `set_camera_monitoring` (off → confirmed via
  `homestatus` → back on), `set_camera_light_mode` (`"on"` → confirmed →
  back to `"auto"`). `trigger_camera_siren` **failed** with a Netatmo 400
  — see the siren row above; capability and order removed from this
  plugin as a result.
- `camera_detection` confirmed live too: a real "human" detection from
  earlier testing showed up correctly as the equipment's `detection` data
  after binding.
- Two real bugs found and fixed via this testing, not by inspection:
  (1) `pingLocal()` trusted a self-reported `local_url` without verifying
  reachability — fixed to double-ping; (2) spec 133's HLS-rewrite
  detection relied on `Content-Type`, which this camera doesn't send
  correctly — fixed there to sniff the body instead.

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

**Decision (2026-08-04)**: v1 targets the **Presence only**. The Advance
is deferred — revisit once (a) Netatmo resolves the discovery issue and
(b) spec 133 gains WebRTC support for live view (or the Advance is shipped
snapshot/monitoring-only, skipping live view — a separate small decision
for that later iteration, not needed now).

**Re-tested 2026-08-20 — still not discoverable, root cause still
unconfirmed:**

- Re-ran the same unfiltered `homesdata` query directly against the dev
  VM's live plugin credentials (token refreshed live, never leaving the
  VM). Result: 17 modules returned for the home, correctly covering every
  other Netatmo/Legrand/Bubendorff device Romain owns (shutters, energy
  meters, EV charger) plus exactly **one** camera — the Presence (`NOC`).
  No `NPC` module anywhere in the response. Same outcome as the original
  2026-08-04 test, two weeks later.
- Investigated a specific lead: an unconfirmed rumor of a distinct
  `"camera pro"` OAuth scope potentially gating newer camera models.
  **Ruled out** — Romain checked Netatmo's own token generator UI directly
  and no such scope exists there. Not the explanation.
- While researching, found a closer real-world parallel than the one
  already cited above:
  [home-assistant/core#140629](https://github.com/home-assistant/core/issues/140629) —
  a user with the exact same symptom (Advance camera invisible to the
  integration, older equipment fine) who **contacted Netatmo support
  directly**; Netatmo's reply was that *"their API is OK for new
  equipment."* That statement actually cuts against the "known Netatmo-side
  bug, nothing to do about it" framing this spec had settled on — if
  Netatmo's own support believes the API works, the gap might be
  account-specific or app-registration-specific rather than a blanket
  platform bug, but this is not confirmed either way. The linked HA issue
  itself remains open/unresolved, with no diagnostic conclusion from
  either side.
**Same-day follow-up (2026-08-20) — scope hypothesis conclusively ruled
out:**

- A contact of Romain's suggested two specific scope names allegedly
  gating newer-generation cameras: `cameraextnoc2` (plausible — Netatmo
  does sell a real `NOC2` outdoor camera line, a newer generation distinct
  from the original `NOC`/Presence, confirmed via product listings) and
  `cameraextnpc` (by analogy, for the `NPC`/Indoor Camera Advance itself).
- Romain regenerated a token from Netatmo's own token generator with
  **every scope currently offered by the UI enabled** (24 scopes granted:
  `read_station`, `read_magellan`, `write_magellan`, `read_bubendorff`,
  `write_bubendorff`, `read_smarther`, `write_smarther`,
  `read_thermostat`, `write_thermostat`, `read_camera`, `write_camera`,
  `access_camera`, `read_doorbell`, `access_doorbell`, `read_mx`,
  `write_mx`, `read_presence`, `write_presence`, `access_presence`,
  `read_homecoach`, `read_carbonmonoxidedetector`, `read_smokedetector`,
  `read_mhs1`, `write_mhs1` — confirmed via the token response's own
  `scope` field, not assumed).
- Neither `cameraextnoc2` nor `cameraextnpc` appears anywhere in that
  granted-scope list — they either don't exist as real Netatmo scopes, or
  aren't offered for this app/account. **Ruled out**, same as `"camera
  pro"` above.
- Re-ran `homesdata` with this maximal-scope token: **identical result** —
  17 modules, exactly one camera (`NOC`), still no `NPC`.
- **This is the strongest evidence yet that scope/permissions are not the
  cause.** With literally every available scope granted, discovery
  behavior didn't change at all. Whatever gates the Advance from
  `homesdata`, it isn't something fixable from the OAuth app
  configuration side — reinforces that if this is pursued further, the
  next step is contacting Netatmo support directly about this specific
  account/device (see previous entry), not more scope experimentation.

**Net effect on the decision above: none.** Still not discoverable, still
deferred, still Presence-only for v1.

**2026-08-21 — a second, different camera model reproduces the exact same
symptom; every remaining client-side hypothesis exhausted:**

- Romain installed a new physical camera, marketed as **"Outdoor
  Original"** — a distinct unit from his existing Presence
  ("Caméra Portail Cour", `NOC`), not a duplicate. Confirmed by Romain:
  visible and functional in the Netatmo Security mobile app, under the
  same single home ("Maison") as everything else on the account.
- `homesdata` re-tested immediately after: **still 17 modules, still
  exactly one camera (`NOC`)**. The new device does not appear, exact same
  symptom as the `NPC`/Advance case above — down to the same
  visible-in-app-but-absent-from-API pattern.
- Three more explanations tested and ruled out, in order:
  1. **Stale token** — re-tested with a plain refresh. No change.
  2. **Stale OAuth consent snapshot** (theory: Netatmo might fix the set
     of visible devices at authorization time rather than recomputing it
     per request, so a device added after authorizing the app wouldn't
     show up until re-consenting) — Romain performed a **full fresh
     re-authorization** (not just a token refresh) through Netatmo's
     token generator, done *after* confirming the new camera's install.
     No change — still absent.
  3. **Multiple homes** (theory: the new camera could have landed in a
     second, separate "home" entity that a single-home-assumption query
     might miss) — Romain confirmed via the app that his account has
     **exactly one home**. Not applicable.
- **This meaningfully strengthens the "real Netatmo-side platform issue"
  theory.** It's no longer one anomalous device (the Advance, a
  relatively new and unusual product) — it's now **two unrelated camera
  models**, installed independently, both reproducing the identical
  gap between the mobile app's view of the account and what the public
  API returns. Every hypothesis fixable from this project's side (scope,
  token freshness, consent staleness, home selection) has been tested and
  ruled out.
- **Recommendation, unchanged in substance but now better justified**:
  the next productive step, if this is pursued further, is contacting
  Netatmo support directly about the account — the one thing that's
  actually produced a real (if inconclusive) answer for another affected
  user in the wild (see `home-assistant/core#140629` above). Nothing left
  to usefully test from the plugin/API-client side alone.

## Goals

1. Discover Romain's Presence — **and only the Presence, v1 scope** — as a
   Sowel device, exposing:
   - `camera_snapshot_url`, `camera_stream_url`, `camera_monitoring` (data)
     + `set_camera_monitoring` (order).
   - `camera_light_mode` (data) + `set_camera_light_mode` (order).
   - `camera_detection` (data), opt-in per spec 133 (not auto-bound).
   No `trigger_camera_siren` — confirmed live that this Presence unit
   rejects `siren_status` (Netatmo error code 21). See "Live API test
   results".
   The Indoor Camera Advance is explicitly out of scope for v1 (see
   Non-Goals) — the plugin's device-type mapping only needs to handle
   `NOC` for now, but should be written so adding `NPC` later (a future
   spec) is additive, not a rewrite.
2. A single poll loop (default interval TBD during testing, starting
   conservative — Netatmo enforces per-app rate limits) that:
   - Calls `homestatus` for state, resolves `local_url` via `ping` (cache
     the resolution — don't re-ping on every single poll tick if the last
     ping succeeded recently), updates device data.
   - Calls `getevents` (or paginated `geteventsuntil`), diffs against the
     last-seen event id/timestamp per camera, emits new `camera_detection`
     data updates for genuinely new events only (no replay on plugin
     restart beyond what's needed to not miss anything).
3. `executeOrder` implements `set_camera_monitoring` and — for Presence
   devices only — `set_camera_light_mode`.
4. Settings schema: `client_id`, `client_secret` (from the new dev.netatmo.com
   app), `refresh_token` (from Netatmo's Token Generator) — same shape as
   `legrand_energy`'s settings, refresh-token rotation handled the same way
   (`onRefreshTokenUpdated` persisted back to `SettingsManager`).

## Non-Goals

- Doorbell (`NDB`) support — not owned, and it uses WebRTC instead of HLS
  (different code path entirely, same category of gap as the Advance's
  live view — see below). Future work if Romain gets one.
- **Indoor Camera Advance (`NPC`) — entirely out of scope for v1**,
  decided 2026-08-04. Two independent blockers: not discoverable via the
  API today (external Netatmo-side issue) and its live view needs WebRTC,
  unsupported by spec 133's proxy. Future iteration once at least the
  discovery issue is resolved.
- Netatmo webhooks — dev VM has no public exposure. Revisit only if that
  changes.
- Siren — confirmed live (2026-08-04) this Presence unit doesn't have one
  (Netatmo rejects `siren_status` with a 400). Not a v1-scoping decision,
  a hardware fact; revisit only if Romain gets a Presence revision that
  does support it.
- Facial recognition / named-person identification — moot for v1 (the
  Presence doesn't have it; it's an Advance/Welcome feature), and out of
  scope regardless per spec 133's own non-goals.
- Any UI work — spec 133 already ships the full `camera` equipment type UI;
  this plugin only has to emit correctly-typed device data/orders.
- Modifying spec 133's core contract *silently*. Live testing did surface
  one real spec 133 bug (HLS rewrite detection trusting `Content-Type`,
  which this camera sends wrong) — fixed directly in spec 133's own repo/
  route, transparently, with a regression test, not worked around here.
  That's the intended process this non-goal describes, not an exception
  to it.

## Manual prerequisite (blocks Phase 1.3 live testing) — DONE 2026-08-04

Romain created a dev.netatmo.com app ("Sowel-dev-camera", separate from the
`legrand_energy` one) and generated a refresh token with all available
scopes. Credentials handed over out-of-band (never committed to this repo
or any spec — same handling as `legrand_energy`'s settings, stored only in
Sowel's `SettingsManager` on the dev VM once the plugin is installed
there).

## Acceptance Criteria

All verified live on the dev VM (2026-08-04) via a manual install (files +
DB row — no registry entry yet, see "Manual prerequisite"), not just unit
tests:

- [x] Plugin authenticates against Netatmo using `client_id` +
      `refresh_token`, matching `legrand_energy`'s proven bridge pattern.
- [x] `homesdata` discovery creates a Sowel device for the Presence,
      correctly typed. (Advance out of scope for v1 — see Non-Goals.)
- [x] Poll loop updates `camera_snapshot_url` / `camera_stream_url` with a
      currently-fetchable URL, verified by hitting spec 133's
      `GET /api/v1/equipments/:id/camera/snapshot` through Sowel and
      getting a real 1280×720 JPEG back.
- [x] Local resolution prefers `local_url` when actually reachable —
      **corrected from the original criterion**: the dev VM and the
      camera are on *different* subnets (192.168.10.x vs 192.168.20.x),
      not the same LAN as assumed. `local_url` only became reachable
      after Romain removed a network-side filter mid-testing, which is
      what surfaced the "trust but don't verify" bug in `pingLocal()`
      (fixed). Verified both states: falls back to the `vpn_url` relay
      when local is unreachable, and correctly prefers `local_url` once
      it is.
- [x] `set_camera_monitoring` order flips real camera monitoring state —
      toggled off, confirmed via `homestatus`, toggled back on, confirmed
      again.
- [x] `set_camera_light_mode` works on the Presence — set to `"on"`,
      confirmed via `homestatus`, restored to `"auto"`.
- [x] Live view: HLS manifest fetched, rewritten correctly, and a real
      segment (~800KB `.ts`) fetched through the sub-resource proxy.
- [x] A real motion event on the Presence shows up as a `camera_detection`
      update (`"human"`) — confirmed via a real detection from earlier in
      the testing session appearing correctly on the bound equipment.
- [ ] ~~`trigger_camera_siren` works~~ — **dropped**: Netatmo rejects it
      on this hardware (confirmed live, error code 21). Not a v1 gap, a
      capability this Presence unit doesn't have.
- [ ] Registry entry (`plugins/registry.json` in the `sowel` repo) added
      with `sha256` + `owner` once the first GitHub release exists (spec
      089 workflow) — not done yet, this plugin has no GitHub release.

## Test plan — executed 2026-08-04

- **Unit-tested (vitest, this repo, 11 tests)**: event de-duplication
  logic (given previously-seen event ids + a new `events_list`, return
  only the genuinely new ones, oldest-first), and device-type →
  capability mapping (`NOC` → floodlight only, no siren; unknown types →
  neither). The siren auto-revert timer module was written, tested, then
  **deleted** once live testing proved the Presence has no siren to
  revert.
- **Live-tested**, manually installed on the dev VM (files copied into
  `/app/plugins/netatmo_camera` + a direct `plugins` table row — no
  registry entry exists for this unreleased plugin): auth, discovery,
  snapshot/stream fetch through Sowel's media-proxy (real image + real
  HLS segment), `set_camera_monitoring` and `set_camera_light_mode` order
  dispatch (each verified via `homestatus` after the call), and a real
  `camera_detection` event. See "Acceptance Criteria" for the checked-off
  list and "Live API test results" for the two spec/plugin bugs this
  testing found and fixed.

## Open questions

- Poll interval — currently 60s (spec 133's suggested default). Not yet
  tuned against observed Netatmo rate-limit behavior over a longer run;
  revisit if 429s show up in practice.
- Per-event snapshot URL (`subevents[].snapshot.url`, time-limited) isn't
  surfaced on `camera_detection` in v1 — the value is just the detection
  kind (e.g. `"human"`). Worth revisiting once there's a UI reason to show
  it (spec 133's `CameraPanel.tsx` only renders the detection kind today).
