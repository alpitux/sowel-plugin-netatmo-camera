/**
 * Sowel Plugin: Netatmo Camera
 *
 * Binds Netatmo Security cameras into Sowel's `camera` equipment type
 * (spec 133, mchacher/sowel). v1 supports the Presence (`NOC`) only — see
 * specs/001-netatmo-camera-plugin/spec.md for why the Indoor Camera
 * Advance (`NPC`) is deferred.
 *
 * Auth mirrors sowel-plugin-legrand-energy's proven bridge pattern (same
 * Netatmo OAuth server, client_id/client_secret/refresh_token), but with
 * a separate dev app (different, Security-scoped permissions).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isSupportedCameraType, capabilitiesFor } from "./capability-map.js";
import { newEvents, type NetatmoEvent } from "./event-dedup.js";

// ============================================================
// Local type definitions (mirrors src/shared/plugin-api.ts + related)
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

interface EventBus {
  emit(event: unknown): void;
}

interface SettingsManager {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface DiscoveredDevice {
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  data: { key: string; type: string; category: string; unit?: string; enumValues?: string[] }[];
  orders: {
    key: string;
    type: string;
    category?: string;
    dispatchConfig?: Record<string, unknown>;
    min?: number;
    max?: number;
    enumValues?: string[];
    unit?: string;
  }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
    sourceTimestamp?: number,
  ): void;
  removeStaleDevices(integrationId: string, activeIds: Set<string>): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(device: Device, orderKey: string, value: unknown): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

// ============================================================
// Netatmo API types
// ============================================================

interface NetatmoTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface NetatmoModule {
  id: string;
  type: string;
  name: string;
}

interface NetatmoHome {
  id: string;
  name: string;
  modules: NetatmoModule[];
}

interface NetatmoModuleStatus {
  id: string;
  type: string;
  monitoring?: "on" | "off";
  floodlight?: "auto" | "on" | "off";
  siren_status?: "sound" | "no_sound";
  vpn_url?: string;
  is_local?: boolean;
  sd_status?: number;
  alim_status?: number;
}

interface NetatmoSubevent {
  id: string;
  type: string;
  time: number;
}

interface NetatmoTopEvent {
  id: string;
  type: string;
  time: number;
  module_id?: string;
  subevents?: NetatmoSubevent[];
}

// ============================================================
// Constants
// ============================================================

const INTEGRATION_ID = "netatmo_camera";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;
const BASE_URL = "https://api.netatmo.com";
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_S = 300;
const DEFAULT_POLL_INTERVAL_S = 60;
const MIN_POLL_INTERVAL_S = 30;

// ============================================================
// Device mapping
// ============================================================

function mapCameraToDiscovered(mod: NetatmoModule): DiscoveredDevice {
  const caps = capabilitiesFor(mod.type);

  const data: DiscoveredDevice["data"] = [
    { key: "snapshot_url", type: "text", category: "camera_snapshot_url" },
    { key: "stream_url", type: "text", category: "camera_stream_url", unit: "hls" },
    { key: "monitoring", type: "boolean", category: "camera_monitoring" },
    { key: "detection", type: "text", category: "camera_detection" },
  ];
  const orders: DiscoveredDevice["orders"] = [
    { key: "monitoring", type: "boolean", category: "set_camera_monitoring" },
  ];

  if (caps.hasFloodlight) {
    data.push({
      key: "light_mode",
      type: "enum",
      category: "camera_light_mode",
      enumValues: ["auto", "on", "off"],
    });
    orders.push({
      key: "light_mode",
      type: "enum",
      category: "set_camera_light_mode",
      enumValues: ["auto", "on", "off"],
    });
  }
  if (caps.hasSiren) {
    orders.push({ key: "siren", type: "boolean", category: "trigger_camera_siren" });
  }

  return {
    friendlyName: mod.name || mod.id,
    manufacturer: "Netatmo",
    model: mod.type,
    data,
    orders,
  };
}

// ============================================================
// OAuth + API bridge
// ============================================================

class NetatmoBridge {
  private logger: Logger;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private refreshToken: string;
  private tokenExpiresAt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenFilePath: string;
  private onRefreshTokenUpdated: ((newToken: string) => void) | null = null;

  constructor(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    logger: Logger,
    tokenFilePath: string,
    onRefreshTokenUpdated?: (newToken: string) => void,
  ) {
    this.logger = logger;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.tokenFilePath = tokenFilePath;
    this.onRefreshTokenUpdated = onRefreshTokenUpdated ?? null;
    this.loadTokensFromFile();
  }

  async authenticate(): Promise<void> {
    await this.doRefreshToken();
    this.scheduleRefresh();
  }

  disconnect(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.accessToken = null;
  }

  async getHomesData(): Promise<{ body: { homes: NetatmoHome[] } }> {
    return this.apiPost("/api/homesdata", {});
  }

  async getHomeStatus(homeId: string): Promise<{ body: { home: { id: string; modules: NetatmoModuleStatus[] } } }> {
    return this.apiPost("/api/homestatus", { home_id: homeId });
  }

  /** `POST api/setstate` — confirmed live (2026-08-04): requires a raw
   * JSON body (unlike the other endpoints below, which are form-encoded),
   * and the `home: { id, modules: [...] }` wrapper is required for
   * `monitoring` too, not just `floodlight`/`siren_status`. A per-module
   * `body.errors` entry (e.g. `{ code: 7, message: "Already on" }`) is
   * Netatmo's idempotency feedback, not a failure — top-level `status`
   * stays `"ok"` and HTTP 200 either way, so this only throws on a real
   * transport/HTTP failure. */
  async setState(homeId: string, moduleId: string, patch: Record<string, unknown>): Promise<void> {
    if (this.accessToken && this.tokenExpiresAt > 0 && Date.now() > this.tokenExpiresAt - 60_000) {
      await this.doRefreshToken();
    }
    const res = await this.rawFetch(`${BASE_URL}/api/setstate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ home: { id: homeId, modules: [{ id: moduleId, ...patch }] } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`setstate failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as {
      body?: { errors?: { id: string; command: string; code: number; message: string }[] };
    };
    if (data.body?.errors?.length) {
      this.logger.debug({ errors: data.body.errors, moduleId }, "setstate: per-module notice (non-fatal)");
    }
  }

  /** Netatmo's `getevents` returns the most recent events for the device,
   * no server-side "since" filter (unlike `geteventsuntil`'s `event_id`
   * cursor) — de-duplication against previously-seen ids happens
   * client-side in the caller via `newEvents()`. */
  async getEvents(homeId: string, deviceId: string): Promise<NetatmoTopEvent[]> {
    const res = await this.apiPost<{ body: { home: { events: NetatmoTopEvent[] } } }>("/api/getevents", {
      home_id: homeId,
      device_id: deviceId,
    });
    return res.body?.home?.events ?? [];
  }

  /** Resolve the camera's LAN-local base URL, when the plugin (running on
   * the Sowel host) can actually reach it.
   *
   * Confirmed live (2026-08-04): `{vpn_url}/command/ping` returns whatever
   * `local_url` the camera last reported to Netatmo's cloud — this is the
   * camera's own belief about its LAN address, unconditionally, NOT a
   * reachability check from the caller's position. On Romain's setup the
   * dev VM and the camera are on different subnets with no route between
   * them, so blindly trusting `local_url` produced an address the VM
   * can't fetch at all (confirmed: even `curl` from the VM host times out
   * against it, not just from inside the container).
   *
   * So this now verifies reachability with a second, direct ping against
   * the candidate `local_url` itself before trusting it — falls back to
   * `vpn_url` (always reachable, it's Netatmo's relay) on any failure,
   * exactly as before. */
  async pingLocal(vpnUrl: string): Promise<string | null> {
    const candidate = await this.pingOnce(`${vpnUrl}/command/ping`);
    if (!candidate) return null;
    const verified = await this.pingOnce(`${candidate}/command/ping`);
    return verified ? candidate : null;
  }

  private async pingOnce(pingUrl: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const res = await fetch(pingUrl, { signal: controller.signal });
        if (!res.ok) return null;
        const data = (await res.json()) as { local_url?: string };
        return data.local_url ?? null;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private async doRefreshToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await this.rawFetch(`${BASE_URL}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as NetatmoTokenResponse;
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    this.saveTokensToFile();
    if (this.onRefreshTokenUpdated) this.onRefreshTokenUpdated(data.refresh_token);
    this.logger.info({ expiresIn: data.expires_in }, "Access token refreshed");
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const msUntilRefresh = Math.max(this.tokenExpiresAt - Date.now() - REFRESH_MARGIN_S * 1000, 60_000);
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.doRefreshToken();
        this.scheduleRefresh();
      } catch (err) {
        this.logger.warn({ err } as Record<string, unknown>, "Token refresh failed, retrying in 30s");
        this.refreshTimer = setTimeout(async () => {
          try {
            await this.doRefreshToken();
            this.scheduleRefresh();
          } catch (e) {
            this.logger.error({ err: e } as Record<string, unknown>, "Token refresh retry failed");
          }
        }, 30_000);
      }
    }, msUntilRefresh);
  }

  private loadTokensFromFile(): void {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        const saved = JSON.parse(fs.readFileSync(this.tokenFilePath, "utf-8")) as {
          refreshToken?: string;
          accessToken?: string;
          expiresAt?: number;
        };
        if (saved.refreshToken) this.refreshToken = saved.refreshToken;
        if (saved.accessToken && saved.expiresAt && saved.expiresAt > Date.now()) {
          this.accessToken = saved.accessToken;
          this.tokenExpiresAt = saved.expiresAt;
        }
      }
    } catch {
      /* no saved tokens */
    }
  }

  private saveTokensToFile(): void {
    try {
      const dir = path.dirname(this.tokenFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.tokenFilePath,
        JSON.stringify({
          refreshToken: this.refreshToken,
          accessToken: this.accessToken,
          expiresAt: this.tokenExpiresAt,
        }),
      );
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "Failed to persist tokens");
    }
  }

  private async apiPost<T>(endpoint: string, params: Record<string, unknown>): Promise<T> {
    if (this.accessToken && this.tokenExpiresAt > 0 && Date.now() > this.tokenExpiresAt - 60_000) {
      await this.doRefreshToken();
    }
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body.set(k, String(v));
    }
    const res = await this.rawFetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${endpoint} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================
// Plugin implementation
// ============================================================

class NetatmoCameraPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Netatmo Camera";
  readonly description = "Netatmo Security cameras — snapshot, live view, monitoring, spot light, detections";
  readonly icon = "Camera";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private bridge: NetatmoBridge | null = null;
  private status: IntegrationStatus = "disconnected";
  private homeId = "";
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_S * 1000;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastPollAt: string | null = null;
  private polling = false;
  private pollFailed = false;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private dataDir: string;

  // Camera tracking: sourceDeviceId (friendly name used with deviceManager) -> Netatmo module id + home id
  private cameraModuleIds = new Map<string, string>();
  private seenEventIds = new Map<string, Set<string>>(); // per camera module id

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
    this.dataDir = path.resolve(deps.pluginDir, "..", "..", "data");
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.pollFailed) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return (
      this.getSetting("client_id") !== undefined &&
      this.getSetting("client_secret") !== undefined &&
      this.getSetting("refresh_token") !== undefined
    );
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      { key: "client_id", label: "Client ID", type: "text", required: true, placeholder: "From dev.netatmo.com" },
      { key: "client_secret", label: "Client Secret", type: "password", required: true },
      {
        key: "refresh_token",
        label: "Refresh Token",
        type: "password",
        required: true,
        placeholder: "From Netatmo Token Generator",
      },
      {
        key: "polling_interval",
        label: "Polling interval (seconds)",
        type: "number",
        required: false,
        defaultValue: String(DEFAULT_POLL_INTERVAL_S),
        placeholder: `Min ${MIN_POLL_INTERVAL_S}, default ${DEFAULT_POLL_INTERVAL_S}`,
      },
    ];
  }

  async start(options?: { pollOffset?: number }): Promise<void> {
    this.stopPolling();
    if (this.bridge) {
      this.bridge.disconnect();
      this.bridge = null;
    }

    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const clientId = this.getSetting("client_id")!;
    const clientSecret = this.getSetting("client_secret")!;
    const refreshToken = this.getSetting("refresh_token")!;
    const pollingIntervalSec = parseInt(this.getSetting("polling_interval") ?? String(DEFAULT_POLL_INTERVAL_S), 10);
    this.pollIntervalMs =
      (isNaN(pollingIntervalSec) ? DEFAULT_POLL_INTERVAL_S : Math.max(pollingIntervalSec, MIN_POLL_INTERVAL_S)) *
      1000;

    try {
      this.bridge = new NetatmoBridge(
        clientId,
        clientSecret,
        refreshToken,
        this.logger,
        path.join(this.dataDir, "netatmo-camera-tokens.json"),
        (newToken) => {
          this.settingsManager.set(`${SETTINGS_PREFIX}refresh_token`, newToken);
        },
      );

      await this.bridge.authenticate();

      const homesData = await this.bridge.getHomesData();
      const homes = homesData.body.homes;
      if (homes.length === 0) throw new Error("No homes found");
      this.homeId = homes[0].id;
      this.logger.info({ homeId: this.homeId, homeName: homes[0].name }, "Using Netatmo home");

      await this.poll();

      const offset = options?.pollOffset ?? 0;
      const startInterval = () => {
        this.pollInterval = setInterval(() => this.safePoll(), this.pollIntervalMs);
      };
      if (offset > 0) {
        setTimeout(startInterval, offset);
      } else {
        startInterval();
      }

      this.status = "connected";
      this.retryCount = 0;
      this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      this.logger.info({ pollIntervalMs: this.pollIntervalMs }, "Netatmo Camera started");
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start Netatmo Camera");
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.cancelRetry();
    this.stopPolling();
    if (this.bridge) {
      this.bridge.disconnect();
      this.bridge = null;
    }
    this.status = "disconnected";
    this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
    this.logger.info("Netatmo Camera stopped");
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.bridge) throw new Error("Not connected");
    const moduleId = this.cameraModuleIds.get(device.sourceDeviceId) ?? device.sourceDeviceId;

    switch (orderKey) {
      case "monitoring":
        await this.bridge.setState(this.homeId, moduleId, { monitoring: value ? "on" : "off" });
        return;
      case "light_mode":
        await this.bridge.setState(this.homeId, moduleId, { floodlight: value });
        return;
      default:
        throw new Error(`Unknown order: ${orderKey}`);
    }
  }

  async refresh(): Promise<void> {
    if (!this.bridge || this.status !== "connected") throw new Error("Not connected");
    await this.poll();
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (!this.lastPollAt) return null;
    return { lastPollAt: this.lastPollAt, intervalMs: this.pollIntervalMs };
  }

  // ============================================================
  // Polling
  // ============================================================

  private async poll(): Promise<void> {
    if (this.polling || !this.bridge) return;
    this.polling = true;

    try {
      this.lastPollAt = new Date().toISOString();

      await this.discoverCameras();
      await this.pollCameraStatus().catch((err) =>
        this.logger.warn({ err } as Record<string, unknown>, "Camera status poll failed"),
      );
      await this.pollEvents().catch((err) =>
        this.logger.warn({ err } as Record<string, unknown>, "Event poll failed"),
      );

      if (this.pollFailed) {
        this.pollFailed = false;
        this.eventBus.emit({
          type: "system.alarm.resolved",
          alarmId: `poll-fail:${INTEGRATION_ID}`,
          source: "Netatmo Camera",
          message: "Communication rétablie",
        });
      }
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "Camera poll cycle failed");
      if (!this.pollFailed) {
        this.pollFailed = true;
        this.eventBus.emit({
          type: "system.alarm.raised",
          alarmId: `poll-fail:${INTEGRATION_ID}`,
          level: "error",
          source: "Netatmo Camera",
          message: `Poll en échec : ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private async discoverCameras(): Promise<void> {
    const homesData = await this.bridge!.getHomesData();
    const home = homesData.body.homes.find((h) => h.id === this.homeId);
    if (!home) throw new Error(`Home ${this.homeId} not found`);

    const activeIds = new Set<string>();

    for (const mod of home.modules ?? []) {
      if (!isSupportedCameraType(mod.type)) continue;

      const discovered = mapCameraToDiscovered(mod);
      this.deviceManager.upsertFromDiscovery(INTEGRATION_ID, INTEGRATION_ID, discovered);

      const name = mod.name || mod.id;
      this.cameraModuleIds.set(name, mod.id);
      activeIds.add(name);
    }

    this.deviceManager.removeStaleDevices(INTEGRATION_ID, activeIds);
  }

  private async pollCameraStatus(): Promise<void> {
    const status = await this.bridge!.getHomeStatus(this.homeId);
    const modules = status.body.home.modules;

    for (const mod of modules) {
      if (!isSupportedCameraType(mod.type)) continue;
      const friendlyName = [...this.cameraModuleIds.entries()].find(([, id]) => id === mod.id)?.[0];
      if (!friendlyName) continue;

      const payload: Record<string, unknown> = {};
      if (mod.monitoring !== undefined) payload.monitoring = mod.monitoring === "on";
      if (mod.floodlight !== undefined) payload.light_mode = mod.floodlight;

      if (mod.vpn_url) {
        const localUrl = await this.bridge!.pingLocal(mod.vpn_url);
        const base = localUrl ?? mod.vpn_url;
        payload.snapshot_url = `${base}/live/snapshot_720.jpg`;
        payload.stream_url = `${base}/live/files/high/index.m3u8`;
      }

      if (Object.keys(payload).length > 0) {
        this.deviceManager.updateDeviceData(INTEGRATION_ID, friendlyName, payload);
      }
    }
  }

  private async pollEvents(): Promise<void> {
    for (const [friendlyName, moduleId] of this.cameraModuleIds) {
      // Netatmo returns "whatever it considers recent" here, no window we
      // control — on the very first poll after plugin (re)start, `seen` is
      // empty, so everything currently returned fires once as a batch of
      // camera_detection updates. Acceptable: matches spec 001's "no
      // replay beyond what's needed to not miss anything".
      const topEvents = await this.bridge!.getEvents(this.homeId, moduleId);

      const flat: NetatmoEvent[] = topEvents.flatMap((e) =>
        (e.subevents ?? []).map((s) => ({ id: s.id, type: s.type, time: s.time })),
      );

      const seen = this.seenEventIds.get(moduleId) ?? new Set<string>();
      const fresh = newEvents(flat, seen);

      for (const event of fresh) {
        this.deviceManager.updateDeviceData(INTEGRATION_ID, friendlyName, { detection: event.type }, event.time);
        seen.add(event.id);
      }

      // Bound memory: keep only the most recent ids.
      if (seen.size > 500) {
        const sorted = flat.filter((e) => seen.has(e.id)).sort((a, b) => b.time - a.time);
        seen.clear();
        for (const e of sorted.slice(0, 200)) seen.add(e.id);
      }

      this.seenEventIds.set(moduleId, seen);
    }
  }

  private safePoll(): void {
    this.poll().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Poll failed"));
  }

  // ============================================================
  // Retry + helpers
  // ============================================================

  private scheduleRetry(): void {
    this.cancelRetry();
    this.retryCount++;
    const delaySec = Math.min(30 * Math.pow(2, this.retryCount - 1), 600);
    this.logger.warn({ retryCount: this.retryCount, delaySec }, "Scheduling retry");
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      this.start().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Retry failed"));
    }, delaySec * 1000);
  }

  private cancelRetry(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

// ============================================================
// Plugin entry point
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new NetatmoCameraPlugin(deps);
}
