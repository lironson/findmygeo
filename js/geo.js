// Pure geometry helpers. No DOM, no browser globals: importable from node --test.

import { PENALTY_KM } from './protocol.js';

export { PENALTY_KM };

const R_KM = 6371.0088;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// Great-circle distance in km between {lat,lng} points.
export function haversineKm(a, b) {
  const p1 = a.lat * RAD, p2 = b.lat * RAD;
  const dp = (b.lat - a.lat) * RAD;
  let dl = (b.lng - a.lng) * RAD;
  dl = Math.atan2(Math.sin(dl), Math.cos(dl)); // shortest way round
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

const toVec = ({ lat, lng }) => {
  const p = lat * RAD, l = lng * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};

// Points along the great circle a -> b as [[lat,lng],...] (endpoints included).
// Longitudes are unwrapped against the previous point (so they may leave
// [-180,180]) which keeps Leaflet from drawing a line across the whole map.
export function greatCirclePoints(a, b, n = 64) {
  n = Math.max(1, Math.floor(n));
  const A = toVec(a), B = toVec(b);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const omega = Math.acos(dot);
  const so = Math.sin(omega);
  const out = [];
  let prevLng = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let lat, lng;
    if (i === 0) { lat = a.lat; lng = a.lng; }
    else if (i === n) { lat = b.lat; lng = b.lng; }
    else if (so < 1e-9) { // identical or antipodal-ish: fall back to linear
      lat = a.lat + (b.lat - a.lat) * t;
      lng = a.lng + (b.lng - a.lng) * t;
    } else {
      const k1 = Math.sin((1 - t) * omega) / so, k2 = Math.sin(t * omega) / so;
      const x = k1 * A[0] + k2 * B[0], y = k1 * A[1] + k2 * B[1], z = k1 * A[2] + k2 * B[2];
      lat = Math.atan2(z, Math.hypot(x, y)) * DEG;
      lng = Math.atan2(y, x) * DEG;
    }
    if (prevLng !== null) {
      while (lng - prevLng > 180) lng -= 360;
      while (lng - prevLng < -180) lng += 360;
    }
    prevLng = lng;
    out.push([lat, lng]);
  }
  return out;
}

// 0.42 -> "0.4", 12.3 -> "12.3", 1204.4 -> "1,204"
// One decimal below 100 km (close guesses are the fun ones), integer with
// thousands separators from 100 up.
export function formatKm(km) {
  if (!Number.isFinite(km)) return '0';
  const v = Math.max(0, km);
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0';
  if (r < 100) return r.toFixed(1);
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Shift each longitude by a multiple of 360 so the points span as little longitude as possible
// (Vancouver + Tokyo + Sydney sit together across the Pacific instead of spanning the globe).
// Same length and order as the input; lat untouched.
export function fitLngs(points) {
  let best = null, bestSpan = Infinity;
  for (const a of points) {
    const out = points.map((p) => ({ ...p, lng: p.lng + 360 * Math.round((a.lng - p.lng) / 360) }));
    const lngs = out.map((p) => p.lng);
    const span = Math.max(...lngs) - Math.min(...lngs);
    if (span < bestSpan - 1e-9) { best = out; bestSpan = span; }
  }
  return best || [];
}
