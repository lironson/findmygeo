// Leaflet helpers. The global `L` is touched only inside functions (never at import time).

import { currentTheme } from './theme.js';
import { greatCirclePoints, formatKm, fitLngs } from './geo.js';
import { reducedMotion } from './dom.js';

// Esri Gray Canvas: keyless, quiet, and it has a matching dark variant. Base + labels on top.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
const TILES = {
  light: ['World_Light_Gray_Base', 'World_Light_Gray_Reference'],
  dark: ['World_Dark_Gray_Base', 'World_Dark_Gray_Reference'],
};
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// TV scale: .screen.wide sets --k on an ancestor; pins grow with it.
const scaleOf = (map) => {
  const k = parseFloat(getComputedStyle(map.getContainer()).getPropertyValue('--k'));
  return k > 0 ? k : 1;
};
const safeColor = (c) => (typeof c === 'string' && /^[#a-z0-9(),.% -]+$/i.test(c) ? c : '');

function tileLayer(theme) {
  const [base, labels] = TILES[theme === 'dark' ? 'dark' : 'light'];
  const opts = { maxNativeZoom: 16, maxZoom: 18 };
  return L.layerGroup([
    L.tileLayer(`${ESRI}${base}/MapServer/tile/{z}/{y}/{x}`, { ...opts, attribution: ATTRIBUTION }),
    L.tileLayer(`${ESRI}${labels}/MapServer/tile/{z}/{y}/{x}`, opts),
  ]);
}

export function createMap(el, { interactive = true } = {}) {
  const map = L.map(el, {
    center: [20, 0], zoom: 2, minZoom: 1, worldCopyJump: true,
    zoomControl: false, zoomSnap: 0.5, zoomDelta: 1,
    dragging: interactive, touchZoom: interactive, scrollWheelZoom: interactive,
    doubleClickZoom: interactive, boxZoom: interactive, keyboard: interactive,
    tap: interactive,
  });
  map.attributionControl.setPrefix(false);
  if (interactive) L.control.zoom({ position: 'topright' }).addTo(map);

  // Tiles follow the theme: explicit toggle ('fmg-theme') or the OS scheme when none is set.
  let theme = currentTheme();
  let tiles = tileLayer(theme).addTo(map);
  const sync = () => {
    const next = currentTheme();
    if (next === theme) return;
    theme = next;
    map.removeLayer(tiles);
    tiles = tileLayer(theme).addTo(map);
  };
  const mq = matchMedia('(prefers-color-scheme: dark)');
  window.addEventListener('fmg-theme', sync);
  if (mq.addEventListener) mq.addEventListener('change', sync);

  // Keep the map correct when its box changes (rotation, panels opening, TV resize).
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
  }

  map.on('unload', () => {
    window.removeEventListener('fmg-theme', sync);
    if (mq.removeEventListener) mq.removeEventListener('change', sync);
    if (ro) ro.disconnect();
  });
  return map;
}

export function stickerIcon({ color, label = '', size = 36, slap = false } = {}) {
  const c = safeColor(color);
  const style = `--sz:${size}px;${c ? `--team:${c}` : ''}`;
  return L.divIcon({
    className: slap ? 'pin-sticker slap' : 'pin-sticker',
    html: `<span class="face" style="${style}">${esc(label)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function targetIcon({ slap = false, size = 30 } = {}) {
  return L.divIcon({
    className: slap ? 'pin-target slap' : 'pin-target',
    html: '<span class="face"></span>',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Replay the .slap landing on a marker's icon.
function slapMarker(marker, delayMs = 0) {
  const icon = marker.getElement && marker.getElement();
  if (!icon) return;
  icon.style.setProperty('--d', `${delayMs}ms`);
  icon.classList.remove('slap');
  void icon.offsetWidth; // restart the animation
  icon.classList.add('slap');
}

export function createPicker(el, { color, label, initial = null, onChange } = {}) {
  el.classList.add('fmg-picker');
  const map = createMap(el);
  let marker = null;
  let locked = false;
  const icon = stickerIcon({ color, label, size: Math.round(44 * scaleOf(map)) });

  const read = () => {
    if (!marker) return null;
    const ll = marker.getLatLng();
    return { lat: ll.lat, lng: wrapLng(ll.lng) };
  };
  const emit = () => { if (onChange) onChange(read()); };

  function place(latlng, { silent = false, animate = true } = {}) {
    if (!marker) {
      marker = L.marker(latlng, { icon, draggable: true, autoPan: true, keyboard: false, riseOnHover: true }).addTo(map);
      marker.on('dragend', () => { if (!locked) emit(); });
      if (locked) marker.dragging.disable();
    } else {
      marker.setLatLng(latlng);
    }
    if (animate && !reducedMotion()) slapMarker(marker);
    if (!silent) emit();
  }

  map.on('click', (e) => {
    if (locked) return;
    place(e.latlng);
  });

  if (initial) {
    place(L.latLng(initial.lat, initial.lng), { silent: true, animate: false });
    map.setView([initial.lat, initial.lng], 4, { animate: false });
  }

  return {
    map,
    getLatLng: read,
    setLatLng(ll) {
      if (!ll) return;
      place(L.latLng(ll.lat, ll.lng), { silent: true, animate: false });
    },
    setLocked(v) {
      locked = !!v;
      el.classList.toggle('is-locked', locked);
      if (marker) marker.dragging[locked ? 'disable' : 'enable']();
    },
    invalidate() { map.invalidateSize(); },
    destroy() { map.remove(); el.classList.remove('fmg-picker', 'is-locked'); },
  };
}

// ---------------------------------------------------------------------------
// Reveal: dashed orange "dimension lines" from every guess to the target.

const LINE_MS = 750;     // draw-in time per line
const LINE_STAGGER = 130;  // between lines
const SLAP_STAGGER = 100;  // between stickers

function clearReveal(map) {
  if (!map._fmgReveal) return;
  map._fmgReveal._cancelled = true;
  map._fmgReveal.clearLayers();
  map.removeLayer(map._fmgReveal);
  map._fmgReveal = null;
}

export function renderReveal(map, { target, guesses = [], animate = true } = {}) {
  clearReveal(map);
  const group = L.layerGroup().addTo(map);
  map._fmgReveal = group;
  const motion = animate && !reducedMotion();
  const k = scaleOf(map);

  const T = { lat: target.lat, lng: target.lng };
  // Draw everything in the world copy around the target so lines and pins agree across the antimeridian.
  const placed = guesses
    .filter((g) => !g.penalty && g.lat != null && g.lng != null)
    .map((g) => ({ ...g, lng: T.lng + wrapLng(g.lng - T.lng) }));

  const paths = placed.map((g) => greatCirclePoints({ lat: g.lat, lng: g.lng }, T, 64));
  // Fit the arcs, not just the endpoints: a great circle bows toward the pole and would clip off the map.
  const pts = [[T.lat, T.lng], ...paths.flat()];
  if (placed.length === 0) map.setView([T.lat, T.lng], 5, { animate: false });
  else map.fitBounds(L.latLngBounds(pts), { padding: [56, 56], maxZoom: 12, animate: false });

  const lines = placed.map((g, i) => {
    const path = paths[i];
    const delay = motion ? i * LINE_STAGGER : 0;
    const line = L.polyline(motion ? [path[0], path[0]] : path, {
      className: 'dim-line', color: '#ff4f00', weight: 3, dashArray: '10 8', lineCap: 'butt',
      interactive: false, smoothFactor: 0.3,
    }).addTo(group);

    const mid = path[Math.floor(path.length / 2)];
    L.marker(mid, {
      icon: L.divIcon({
        className: `dim-label${motion ? ' late' : ''}`, iconSize: null,
        html: `<span style="--team:${safeColor(g.color) || 'var(--accent)'};--d:${delay + (motion ? LINE_MS : 0)}ms">${esc(formatKm(g.km))} KM</span>`,
      }),
      interactive: false, keyboard: false, zIndexOffset: 400,
    }).addTo(group);
    return { line, path, delay };
  });

  L.marker([T.lat, T.lng], {
    icon: targetIcon({ slap: motion, size: Math.round(30 * k) }), interactive: false, keyboard: false, zIndexOffset: 900,
  }).addTo(group);

  placed.forEach((g, i) => {
    const m = L.marker([g.lat, g.lng], {
      icon: stickerIcon({ color: g.color, label: g.label, slap: motion, size: Math.round(36 * k) }),
      interactive: false, keyboard: false, zIndexOffset: 500 + i,
    }).addTo(group);
    if (motion) m.getElement()?.style.setProperty('--d', `${(i + 1) * SLAP_STAGGER}ms`);
  });

  if (motion && lines.length) animateLines(group, lines);
  return group;
}

// Grow each polyline point by point (the dash pattern stays anchored at the guess, so the
// dashes appear to be drawn out toward the target).
function animateLines(group, lines) {
  const t0 = performance.now();
  const step = (now) => {
    if (group._cancelled) return;
    let pending = false;
    for (const { line, path, delay } of lines) {
      const t = Math.min(1, Math.max(0, (now - t0 - delay) / LINE_MS));
      if (line._fmgDone) continue;
      if (t === 0) { pending = true; continue; }
      const e = 1 - (1 - t) ** 3; // ease-out
      const k = e * (path.length - 1);
      const i = Math.floor(k);
      const part = path.slice(0, i + 1);
      if (i < path.length - 1) {
        const f = k - i, a = path[i], b = path[i + 1];
        part.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      }
      line.setLatLngs(part);
      if (t < 1) pending = true; else { line.setLatLngs(path); line._fmgDone = true; }
    }
    if (pending) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Recap: every round's target as a numbered pin; select one to replay its reveal.

// Numbered square survey tag. Active pins sit a little above the point so the target x stays visible.
export function roundPinIcon(n, { active = false, dim = false, size = 26 } = {}) {
  return L.divIcon({
    className: `pin-round${active ? ' active' : ''}${dim ? ' dim' : ''}`,
    html: `<span class="face">${esc(n)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, active ? Math.round(size * 1.6) : size / 2],
  });
}

const PIN_Z = 2000; // above every reveal marker
const DIM_Z = 300;  // below reveal labels (400), stickers (500+) and the target x (900)

// rounds: [{ index, target:{lat,lng}, guesses:[{lat,lng,km,color,label,penalty}] }]
// Returns { showAll(), select(i), current(), destroy() }; i is the position in `rounds`.
export function renderRecap(map, { rounds = [], onSelect } = {}) {
  const k = scaleOf(map);
  const size = Math.round(26 * k);
  const group = L.layerGroup().addTo(map);
  const fitted = fitLngs(rounds.map((r) => r.target)); // pins sit together across the Pacific
  let cur = null;

  const paint = (m, i) => {
    const dim = cur != null && i !== cur;
    m.setIcon(roundPinIcon(rounds[i].index + 1, { active: i === cur, dim, size }));
    m.setZIndexOffset(dim ? DIM_Z : PIN_Z); // dimmed pins duck under the replayed round's stickers
    // The active pin stands at the target's own lng, where renderReveal draws its x.
    m.setLatLng([fitted[i].lat, i === cur ? rounds[i].target.lng : fitted[i].lng]);
  };
  const markers = rounds.map((r, i) => {
    const m = L.marker([fitted[i].lat, fitted[i].lng], {
      icon: roundPinIcon(r.index + 1, { size }), keyboard: true, riseOnHover: true,
      zIndexOffset: PIN_Z, title: `Round ${r.index + 1}`, alt: `Round ${r.index + 1}`,
    }).addTo(group);
    m.on('click', () => api.select(i));
    return m;
  });

  const api = {
    showAll() {
      clearReveal(map);
      cur = null;
      markers.forEach(paint);
      if (!rounds.length) return;
      if (rounds.length === 1) { map.setView([fitted[0].lat, fitted[0].lng], 5, { animate: false }); return; }
      const pad = Math.round(48 * k);
      map.fitBounds(L.latLngBounds(fitted.map((p) => [p.lat, p.lng])), { padding: [pad, pad], maxZoom: 10, animate: false });
    },
    select(i) {
      const r = rounds[i];
      if (!r) return;
      cur = i;
      renderReveal(map, { target: r.target, guesses: r.guesses, animate: true });
      markers.forEach(paint);
      onSelect?.(i);
    },
    current: () => cur,
    destroy() {
      clearReveal(map);
      group.clearLayers();
      map.removeLayer(group);
    },
  };
  api.showAll();
  return api;
}
