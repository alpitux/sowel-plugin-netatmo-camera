/**
 * Device-type → capability mapping (spec 001).
 *
 * v1 only handles the Presence (`NOC`). Written so a future `NPC` (Indoor
 * Camera Advance) case is additive — see spec 001 Non-Goals for why it's
 * not included yet (undiscoverable via the API today, live view needs
 * WebRTC which the Sowel-side media-proxy doesn't support).
 */

export interface CameraCapabilities {
  hasFloodlight: boolean;
  hasSiren: boolean;
}

const PRESENCE_TYPE = "NOC";

/** Camera module types this plugin discovers and binds as Sowel devices. */
export function isSupportedCameraType(type: string): boolean {
  return type === PRESENCE_TYPE;
}

export function capabilitiesFor(type: string): CameraCapabilities {
  if (type === PRESENCE_TYPE) {
    // hasSiren confirmed FALSE live (2026-08-04): Netatmo's setstate
    // rejects `siren_status` on Romain's real Presence with a 400 —
    // "should NOT have additional properties ['siren_status']". Community
    // references (pyatmo's SirenMixin) apply it to NOC generically, but
    // that doesn't hold for this actual unit/firmware — trust the live
    // API response over the library.
    return { hasFloodlight: true, hasSiren: false };
  }
  return { hasFloodlight: false, hasSiren: false };
}
