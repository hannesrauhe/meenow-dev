// Physical device orientation from the accelerometer. With the OS rotation
// lock on, screen.orientation never leaves portrait, so capture code that
// relies on it produces sideways photos when the phone is held landscape.
// This tracker reads deviceorientation events instead; when no sensor data is
// available (desktop, permission denied) callers fall back to screen.orientation.

// Counterclockwise rotation from natural portrait: 0, 90 (top points left),
// 180 (upside down), 270 (top points right).
export type PhysicalAngle = 0 | 90 | 180 | 270;

let sensorAngle: PhysicalAngle | null = null;
let listeners = new Set<(angle: PhysicalAngle) => void>();
let tracking = 0;
let pendingAngle: PhysicalAngle | null = null;
let pendingSince = 0;

// Gravity must have at least this fraction of its magnitude in the screen
// plane; below it (device near flat, e.g. shooting downward) the in-plane
// direction is dominated by noise and the current angle is kept.
const FLAT_LIMIT = 0.4;
// Snap only within ±35° of a quadrant center; the 20° gaps between windows
// act as the hysteresis dead zone.
const SNAP_DEG = 35;
// A new angle must persist this long before it is committed, so hand wobble
// (e.g. during a pinch-to-zoom) cannot flip the orientation transiently.
const STABLE_MS = 400;

// Candidate angle from the gravity vector projected into the screen plane —
// unlike raw beta/gamma thresholds this cannot mistake a forward tilt past
// flat for a 180° rotation.
function derive(beta: number, gamma: number, current: PhysicalAngle): PhysicalAngle {
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  const px = -Math.cos(b) * Math.sin(g);
  const py = -Math.sin(b);
  if (Math.hypot(px, py) < FLAT_LIMIT) return current;
  const a = (Math.atan2(px, -py) * 180 / Math.PI + 360) % 360;
  for (const q of [0, 90, 180, 270] as const) {
    const d = Math.abs(a - q);
    if (Math.min(d, 360 - d) <= SNAP_DEG) return q;
  }
  return current;
}

function onDeviceOrientation(e: DeviceOrientationEvent): void {
  if (e.beta == null || e.gamma == null) return;
  const next = derive(e.beta, e.gamma, sensorAngle ?? 0);
  if (sensorAngle === null) {
    sensorAngle = next;
    listeners.forEach(cb => cb(next));
    return;
  }
  if (next === sensorAngle) { pendingAngle = null; return; }
  const now = Date.now();
  if (next !== pendingAngle) {
    pendingAngle = next;
    pendingSince = now;
    return;
  }
  if (now - pendingSince >= STABLE_MS) {
    pendingAngle = null;
    sensorAngle = next;
    listeners.forEach(cb => cb(next));
  }
}

// Reference-counted so overlapping capture screens cannot detach each other's
// listener. Returns a stop function; calling it twice is a no-op.
export function startOrientationTracking(): () => void {
  if (tracking++ === 0) window.addEventListener('deviceorientation', onDeviceOrientation);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--tracking === 0) {
      window.removeEventListener('deviceorientation', onDeviceOrientation);
      sensorAngle = null;
      pendingAngle = null;
      listeners.clear();
    }
  };
}

export function onPhysicalAngleChange(cb: (angle: PhysicalAngle) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Sensor-derived angle, falling back to screen.orientation so behavior is
// unchanged wherever the sensor is unavailable.
export function getPhysicalAngle(): PhysicalAngle {
  if (sensorAngle !== null) return sensorAngle;
  const type = screen.orientation?.type ?? '';
  if (type === 'landscape-primary') return 90;
  if (type === 'portrait-secondary') return 180;
  if (type === 'landscape-secondary') return 270;
  return 0;
}

// iOS 13+ gates deviceorientation behind an explicit permission that must be
// requested from a user gesture; elsewhere this resolves immediately. A denial
// is swallowed — getPhysicalAngle simply keeps its screen.orientation fallback.
export async function requestOrientationPermission(): Promise<void> {
  const doe = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof doe.requestPermission !== 'function') return;
  try { await doe.requestPermission(); } catch { /* fallback path covers denial */ }
}
