// Host (TV / laptop) view. Owns the game state, the PeerJS room and the IndexedDB copy.
// Rendering rule: a screen is built once per (phase, round) and then patched, so the Leaflet map
// and the photo never reload on the many state changes in between.

import { h, wordmark, toast } from './dom.js';
import { toggleTheme, currentTheme } from './theme.js';
import {
  MSG, ERR, PHASE, msg, TIMER_OPTIONS, TIMER_MIN, TIMER_MAX, CUSTOM_TIMER_DEFAULT, MIN_TEAMS, MAX_TEAMS, MIN_PHOTOS, MAX_PHOTOS,
  pickTeamNames, TEAM_COLORS, DEFAULT_TIMER, PENALTY_KM,
} from './protocol.js';
import * as G from './state.js';
import * as store from './store.js';
import { makeRoomCode, hostRoom } from './net.js';
import { createMap, renderReveal } from './map.js';
import { formatKm } from './geo.js';

const km = (x) => formatKm(x);
const MONO = { fontFamily: 'var(--font-mono)' };

// Short sticker labels: first letter, or first letter + the letter where two same-initial names part ways.
function teamLabels(teams) {
  const out = {};
  teams.forEach((t, i) => {
    const n = t.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || '?';
    const rivals = teams.filter((o, j) => j !== i && (o.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()[0] || '?') === n[0]);
    if (!rivals.length) { out[t.id] = n[0]; return; }
    let idx = 1;
    for (const o of rivals) {
      const on = o.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      let k = 0;
      while (k < n.length && k < on.length && n[k] === on[k]) k++;
      idx = Math.max(idx, k);
    }
    out[t.id] = idx < n.length ? n[0] + n[idx] : n[0] + String(i + 1);
  });
  return out;
}

function joinUrl(code) {
  const cur = new URLSearchParams(location.search);
  const p = new URLSearchParams();
  p.set('join', code);
  for (const k of ['peerHost', 'peerPort', 'peerPath', 'peerSecure']) if (cur.has(k)) p.set(k, cur.get(k));
  return `${location.origin}${location.pathname}?${p}`;
}

function qrSvg(text) {
  try {
    // eslint-disable-next-line no-undef
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  } catch (e) {
    return null;
  }
}

const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const toBuf = (v) => {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return null;
};

const ERR_TEXT = {
  [ERR.TEAM_FULL]: 'Your team already has all its photos.',
  [ERR.NOT_IN_LOBBY]: 'The game has already started.',
  [ERR.SITTING_OUT]: 'Your team sits this round out.',
  [ERR.ALREADY_LOCKED]: 'Your team already locked a pin.',
  [ERR.BAD_ROUND]: 'That round is over.',
  [ERR.UNKNOWN]: 'Something went sideways.',
};

export function mountHost(root) {
  const rolled = pickTeamNames(MAX_TEAMS);
  const app = {
    mode: 'loading',         // setup | loading | error | game
    loadingText: 'Warming up…',
    error: null,             // { title, text, actions: [{label, fn, accent}] }
    s: null,                 // HostState
    room: null,
    conns: new Map(),        // connId -> playerId
    saved: null,             // unfinished game found in IndexedDB
    view: null,
    viewKey: null,
    busy: false,
    photo: null,             // { uploadId, full, guess, url } for the current round
    photoLoads: new Map(),   // uploadId -> Promise
    pending: new Set(),      // in-flight putPhoto promises
    setup: {
      // rolled = random animal per slot (placeholder + fallback); names = input text; edited = host typed in it
      teamCount: 4, photos: 3, timerSec: DEFAULT_TIMER, customSec: CUSTOM_TIMER_DEFAULT,
      rolled, names: rolled.slice(), edited: Array(MAX_TEAMS).fill(false),
    },
    resuming: false,
  };

  // ------------------------------------------------------------------ shell

  const wm = wordmark();
  const roomMeta = h('span.label');
  const onlineMeta = h('span.label');
  const themeBtn = h('button.text-btn', { type: 'button', onclick: () => { toggleTheme(); paintTheme(); } });
  const meta = h('div.row', { style: { gap: '20px' } }, roomMeta, onlineMeta, themeBtn);
  const masthead = h('header.masthead', wm, meta);
  const stage = h('div', { style: { paddingTop: '20px' } });
  const screen = h('div.screen.wide', masthead, stage);
  root.replaceChildren(screen);

  function paintTheme() { themeBtn.textContent = currentTheme() === 'dark' ? 'Light mode' : 'Dark mode'; }
  paintTheme();

  function paintMasthead() {
    const s = app.s;
    wm.style.visibility = app.viewKey === 'setup' ? 'hidden' : '';
    if (app.mode === 'game' && s) {
      const on = s.players.filter((p) => p.connected).length;
      roomMeta.replaceChildren('ROOM ', h('span.num', s.code));
      onlineMeta.replaceChildren(h('span.num', `${on}/${s.players.length}`), ' ONLINE');
    } else {
      roomMeta.replaceChildren();
      onlineMeta.replaceChildren();
    }
  }

  // ------------------------------------------------------------------ rendering core

  function render() {
    let key, build;
    if (app.mode === 'game' && app.s) {
      const ph = app.s.phase;
      key = ph === PHASE.ROUND || ph === PHASE.REVEAL ? `${ph}:${app.s.roundIndex}` : ph;
      build = { lobby: buildLobby, round: buildRound, reveal: buildReveal, final: buildFinal }[ph];
    } else if (app.mode === 'setup') { key = 'setup'; build = buildSetup; }
    else if (app.mode === 'error') { key = `error:${app.error?.text}`; build = buildError; }
    else { key = `loading:${app.loadingText}`; build = buildLoading; }

    if (app.viewKey !== key) {
      app.view?.destroy?.();
      app.view = build();
      app.viewKey = key;
      stage.replaceChildren(app.view.el);
      app.view.mounted?.();
    }
    app.view.update?.();
    paintMasthead();
  }

  function afterChange() {
    store.saveGame(app.s);
    broadcastState();
    render();
  }

  // ------------------------------------------------------------------ networking

  function send(connId, m) {
    try { app.room?.send(connId, m); } catch (e) { console.warn('[host] send failed', e); }
  }

  function broadcastState() {
    const s = app.s;
    if (!s || !app.room) return;
    const state = G.toPublic(s, { now: Date.now() });
    for (const [connId, pid] of app.conns) send(connId, msg(MSG.STATE, { state, you: G.youFor(s, pid) }));
  }

  function sendError(connId, code) {
    send(connId, msg(MSG.ERROR, { code, message: ERR_TEXT[code] || ERR_TEXT[ERR.UNKNOWN] }));
  }

  function sendRoundPhoto(connId) {
    const s = app.s;
    if (!s || s.phase !== PHASE.ROUND) return;
    const p = s.players.find((x) => x.id === app.conns.get(connId));
    const cur = G.currentUpload(s);
    if (!p || !p.teamId || !cur || p.teamId === cur.teamId) return;
    if (app.photo?.uploadId === cur.id) {
      send(connId, msg(MSG.ROUND_PHOTO, { roundIndex: s.roundIndex, image: app.photo.guess }));
    } else {
      loadPhoto(cur.id).then((ph) => { if (ph) sendRoundPhoto(connId); });
    }
  }

  function loadPhoto(uploadId) {
    if (app.photo?.uploadId === uploadId) return Promise.resolve(app.photo);
    if (app.photoLoads.has(uploadId)) return app.photoLoads.get(uploadId);
    const p = store.getPhoto(uploadId).then((rec) => {
      app.photoLoads.delete(uploadId);
      if (!rec) { toast('A photo went missing. Skip the round?'); return null; }
      if (app.photo?.url) URL.revokeObjectURL(app.photo.url);
      app.photo = {
        uploadId, full: rec.full, guess: rec.guess,
        url: URL.createObjectURL(new Blob([rec.full], { type: 'image/jpeg' })),
      };
      return app.photo;
    }).catch(() => { app.photoLoads.delete(uploadId); return null; });
    app.photoLoads.set(uploadId, p);
    return p;
  }

  // Load the current round's photo, repaint, and hand it to every guessing phone.
  async function enterRoundPhoto() {
    const cur = G.currentUpload(app.s);
    if (!cur) return;
    const ph = await loadPhoto(cur.id);
    if (!ph || G.currentUpload(app.s)?.id !== cur.id) return;
    render();
    if (app.s.phase === PHASE.ROUND) for (const connId of app.conns.keys()) sendRoundPhoto(connId);
  }

  const handlers = () => ({
    onConnect() { paintMasthead(); },
    onDisconnect(connId) {
      const pid = app.conns.get(connId);
      app.conns.delete(connId);
      if (!pid || !app.s) return;
      const stillThere = [...app.conns.values()].includes(pid);
      if (!stillThere && G.setPlayerConnected(app.s, pid, false)) afterChange();
    },
    onMessage(connId, m) {
      Promise.resolve(onMessage(connId, m)).catch((e) => console.warn('[host] message failed', e));
    },
  });

  async function onMessage(connId, m) {
    const s = app.s;
    if (!s || !m || typeof m.t !== 'string') return;
    if (m.t === MSG.HELLO) {
      if (!m.playerId) return;
      const existing = s.players.find((p) => p.id === m.playerId);
      const r = G.addOrUpdatePlayer(s, { playerId: m.playerId, name: m.name, teamId: existing?.teamId ? undefined : m.teamId });
      if (r.error) return sendError(connId, r.error);
      app.conns.set(connId, m.playerId);
      G.setPlayerConnected(s, m.playerId, true);
      afterChange();
      sendRoundPhoto(connId);
      return;
    }
    const pid = app.conns.get(connId);
    if (!pid) return sendError(connId, ERR.UNKNOWN);

    switch (m.t) {
      case MSG.JOIN_TEAM: {
        const me = s.players.find((p) => p.id === pid);
        const r = G.addOrUpdatePlayer(s, { playerId: pid, name: me?.name, teamId: m.teamId });
        r.removedUploadIds?.forEach((id) => store.deletePhoto(id));
        afterChange();
        sendRoundPhoto(connId);
        break;
      }
      case MSG.UPLOAD: {
        const full = toBuf(m.full), guess = toBuf(m.guess);
        if (!full || !guess || !m.uploadId) return sendError(connId, ERR.UNKNOWN);
        const r = G.addUpload(s, { uploadId: m.uploadId, playerId: pid, lat: m.lat, lng: m.lng, source: m.source });
        if (r.error) return sendError(connId, r.error);
        if (r.duplicate) { afterChange(); return; }
        const put = store.putPhoto(m.uploadId, { full, guess });
        app.pending.add(put);
        try { await put; } catch (e) {
          G.removeUpload(s, pid, m.uploadId);
          sendError(connId, ERR.UNKNOWN);
        } finally { app.pending.delete(put); }
        afterChange();
        break;
      }
      case MSG.DELETE_UPLOAD: {
        const r = G.removeUpload(s, pid, m.uploadId);
        if (r.error) return sendError(connId, r.error);
        store.deletePhoto(m.uploadId);
        afterChange();
        break;
      }
      case MSG.GUESS: {
        const r = G.submitGuess(s, { playerId: pid, roundIndex: m.roundIndex, lat: m.lat, lng: m.lng, now: Date.now() });
        if (r.error) return sendError(connId, r.error);
        if (G.allLocked(s)) G.endRound(s, { now: Date.now() });
        afterChange();
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async function openRoom(code, { resuming }) {
    app.mode = 'loading';
    app.loadingText = resuming ? `Reopening room ${code}…` : 'Opening the room…';
    render();
    return hostRoom(code, handlers());
  }

  async function startNew() {
    const st = app.setup;
    let room = null, lastErr = null;
    app.resuming = false;
    app.mode = 'loading';
    app.loadingText = 'Opening the room…';
    render();
    await store.clearPhotos();
    for (let i = 0; i < 6 && !room; i++) {
      try { room = await hostRoom(makeRoomCode(), handlers()); } catch (e) {
        lastErr = e;
        if (e?.message !== 'ROOM_TAKEN') break;
      }
    }
    if (!room) {
      return showError('Could not open the room', 'Is the internet awake? The signalling server did not answer.', [
        { label: 'TRY AGAIN', accent: true, fn: startNew },
        { label: 'Back', fn: goSetup },
      ], lastErr);
    }
    const names = st.names.slice(0, st.teamCount).map((n, i) => (n || '').trim() || st.rolled[i]);
    app.room = room;
    app.s = G.createGame({
      code: room.code || makeRoomCode(), teamCount: st.teamCount, photosPerTeam: st.photos,
      timerSec: st.timerSec, teamNames: names,
    });
    app.conns.clear();
    app.photo = null;
    app.mode = 'game';
    afterChange();
  }

  async function resume() {
    const saved = app.saved;
    if (!saved) return goSetup();
    app.resuming = true;
    let room;
    try { room = await openRoom(saved.code, { resuming: true }); } catch (e) {
      const taken = e?.message === 'ROOM_TAKEN';
      return showError(
        taken ? `Room ${saved.code} is still busy` : 'Could not reopen the room',
        taken ? 'Another tab (or a ghost of this one) still holds the code. Close it, wait a few seconds, retry.'
          : 'The signalling server did not answer.',
        [{ label: 'RETRY', accent: true, fn: resume }, { label: 'New game instead', fn: newGameFromSaved }],
        e,
      );
    }
    const s = saved;
    G.resetConnections(s);
    G.restartTimer(s, { now: Date.now() });
    app.room = room;
    app.s = s;
    app.saved = null;
    app.conns.clear();
    app.photo = null;
    app.mode = 'game';
    afterChange();
    if (s.phase === PHASE.ROUND || s.phase === PHASE.REVEAL) enterRoundPhoto();
  }

  async function newGameFromSaved() {
    await store.clearGame();
    app.saved = null;
    goSetup();
  }

  function showError(title, text, actions, err) {
    if (err) console.warn('[host]', err);
    app.error = { title, text, actions };
    app.mode = 'error';
    render();
  }

  function goSetup() {
    app.mode = 'setup';
    render();
  }

  async function scrapGame() {
    try { app.room?.close(); } catch (e) { /* ignore */ }
    app.room = null;
    app.conns.clear();
    app.s = null;
    if (app.photo?.url) URL.revokeObjectURL(app.photo.url);
    app.photo = null;
    await store.clearGame();
    await store.clearPhotos();
    goSetup();
  }

  // ------------------------------------------------------------------ game actions

  async function doStart(trim) {
    const s = app.s;
    if (!s || s.phase !== PHASE.LOBBY || app.busy) return;
    if (!(trim ? G.canStartTrim(s) : G.canStart(s))) return;
    app.busy = true;
    try {
      await Promise.all([...app.pending]);
      const r = G.startGame(s, { trim, now: Date.now() });
      if (r.error) { toast('Not ready yet.'); return; }
      r.dropped.forEach((id) => store.deletePhoto(id));
      afterChange();
      await enterRoundPhoto();
    } finally { app.busy = false; }
  }

  function endRoundNow() {
    const s = app.s;
    if (!s || s.phase !== PHASE.ROUND) return;
    G.endRound(s, { now: Date.now() });
    afterChange();
  }

  async function doNext(fromIndex) {
    const s = app.s;
    if (!s || s.phase !== PHASE.REVEAL || s.roundIndex !== fromIndex || app.busy) return;
    app.busy = true;
    try {
      G.nextRound(s, { now: Date.now() });
      afterChange();
      if (s.phase === PHASE.ROUND) await enterRoundPhoto();
    } finally { app.busy = false; }
  }

  async function doPlayAgain() {
    const s = app.s;
    if (!s || s.phase !== PHASE.FINAL) return;
    G.playAgain(s);
    await store.clearPhotos();
    if (app.photo?.url) URL.revokeObjectURL(app.photo.url);
    app.photo = null;
    afterChange();
  }

  // One interval drives the countdown UI and the auto-end.
  const tickTimer = setInterval(() => {
    const s = app.s;
    if (!s || s.phase !== PHASE.ROUND) return;
    if (s.deadline != null && Date.now() >= s.deadline) { endRoundNow(); return; }
    app.view?.tick?.();
  }, 250);

  const onKey = (e) => {
    const s = app.s;
    if (!s || s.phase !== PHASE.REVEAL) return;
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      doNext(s.roundIndex);
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('fmg-theme', paintTheme);

  // ------------------------------------------------------------------ small view helpers

  const sticker = (team, labels, cls = '') =>
    h(`span.sticker${cls ? '.' + cls : ''}`, { style: { '--team': team.color } }, labels[team.id]);

  function photoWell(heightCss) {
    const img = h('img', { alt: 'Mystery photo', draggable: false });
    const el = h('div.photo-well', { style: { height: heightCss, minHeight: '240px' } }, img);
    return {
      el,
      sync() {
        const ph = app.photo;
        const cur = G.currentUpload(app.s);
        if (ph && cur && ph.uploadId === cur.id && img.dataset.id !== ph.uploadId) {
          img.src = ph.url;
          img.dataset.id = ph.uploadId;
        }
      },
    };
  }

  const teamById = (s, id) => s.teams.find((t) => t.id === id);

  // ------------------------------------------------------------------ views: loading / error

  function buildLoading() {
    return {
      el: h('div.stack.lg', { style: { paddingTop: '10vh' } },
        h('div.display', app.loadingText),
        h('div.label.pulse', 'One moment')),
    };
  }

  function buildError() {
    const e = app.error;
    return {
      el: h('div.stack.lg', { style: { paddingTop: '8vh', maxWidth: '40em' } },
        h('div.display', e.title),
        h('p', { style: { fontSize: '1.3em' } }, e.text),
        h('div.row', { style: { gap: '20px' } },
          e.actions.map((a) => (a.accent
            ? h('button.btn.accent.lg', { type: 'button', onclick: a.fn }, a.label)
            : h('button.text-btn', { type: 'button', onclick: a.fn }, a.label))))),
    };
  }

  // ------------------------------------------------------------------ view: setup

  function buildSetup() {
    const st = app.setup;
    const parts = [];

    // title
    const bigMark = wordmark();
    bigMark.style.fontSize = '1em';
    parts.push(h('div.stack', { style: { paddingTop: '2vh' } },
      h('h1.display', { style: { fontSize: 'clamp(72px, 10vw, 220px)', margin: 0 } }, bigMark),
      h('div.h2.muted', 'Snap a photo. Stump your friends.')));

    // resume offer
    if (app.saved) {
      const sv = app.saved;
      const where = sv.phase === PHASE.LOBBY
        ? `In the lobby, ${sv.uploads.length} photo${sv.uploads.length === 1 ? '' : 's'} in.`
        : sv.phase === PHASE.FINAL ? 'Game over, results waiting.'
          : `Round ${sv.roundIndex + 1} of ${sv.order.length}.`;
      parts.push(h('div.callout.stack', { style: { maxWidth: '46em' } },
        h('div.label', 'Unfinished game'),
        h('div.h2', 'Room ', h('span.num', sv.code), ' is still warm.'),
        h('div.muted', `${where} ${sv.teams.map((t) => t.name).join(', ')}.`),
        h('div.row', { style: { gap: '24px', paddingTop: '8px' } },
          h('button.btn.accent', { type: 'button', onclick: resume }, `Resume game ${sv.code}`),
          h('button.text-btn', { type: 'button', onclick: newGameFromSaved }, 'New game'))));
    }

    // rules
    const roundsOut = h('span.num');
    const teamVal = h('span.num'), photoVal = h('span.num');
    const teamDec = h('button', { type: 'button', 'aria-label': 'Fewer teams' }, '−');
    const teamInc = h('button', { type: 'button', 'aria-label': 'More teams' }, '+');
    const photoDec = h('button', { type: 'button', 'aria-label': 'Fewer photos' }, '−');
    const photoInc = h('button', { type: 'button', 'aria-label': 'More photos' }, '+');
    const grid = h('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 17em), 1fr))', gap: '16px 28px' },
    });
    const isPreset = (sec) => TIMER_OPTIONS.includes(sec);
    if (st.custom == null) st.custom = !isPreset(st.timerSec);
    const segBtns = TIMER_OPTIONS.map((sec) => h('button', {
      type: 'button',
      onclick: () => { st.custom = false; st.timerSec = sec; paintRules(); },
      dataset: { sec },
    }, sec ? `${sec}s` : 'OFF'));
    const customBtn = h('button', {
      type: 'button',
      onclick: () => { st.custom = true; st.timerSec = st.customSec; paintRules(); customIn.select(); },
      dataset: { sec: 'custom' },
    }, 'CUSTOM');
    const clampSec = (v) => Math.min(TIMER_MAX, Math.max(TIMER_MIN, Math.round(Number(v))));
    const customPreview = h('span.muted.num');
    const customIn = h('input.input', {
      type: 'number', inputmode: 'numeric', min: TIMER_MIN, max: TIMER_MAX, step: 5, value: st.customSec,
      'aria-label': 'Custom timer in seconds',
      style: { ...MONO, width: '6em', flex: 'none', minHeight: '44px', textAlign: 'right' },
      oninput: () => {
        const v = Math.round(Number(customIn.value));
        if (customIn.value !== '' && v >= TIMER_MIN && v <= TIMER_MAX) { st.customSec = v; st.timerSec = v; }
        paintRules();
      },
      onchange: () => {
        st.customSec = customIn.value === '' || !Number.isFinite(Number(customIn.value)) ? st.customSec : clampSec(customIn.value);
        st.timerSec = st.customSec;
        customIn.value = st.customSec;
        paintRules();
      },
    });
    const customRow = h('div.row', { style: { gap: '10px' } }, customIn, h('span.label', 's'), customPreview);

    function paintTeams() {
      grid.replaceChildren(...Array.from({ length: st.teamCount }, (_, i) => {
        const initial = () => ((st.names[i] || '').trim()[0] || st.rolled[i][0]).toUpperCase();
        const sw = h('span.sticker.lg', { style: { '--team': TEAM_COLORS[i] } }, initial());
        const input = h('input.input', {
          type: 'text', value: st.names[i], maxlength: 12, placeholder: st.rolled[i],
          autocomplete: 'off', spellcheck: false,
          'aria-label': `Team ${i + 1} name`,
          style: { textTransform: 'uppercase', flex: '1', minWidth: '0' },
          oninput: () => { st.names[i] = input.value; st.edited[i] = !!input.value.trim(); sw.textContent = initial(); },
        });
        return h('label.row', { style: { flexWrap: 'nowrap', gap: '14px' } }, sw, input);
      }));
    }
    // re-roll every slot the host hasn't typed into; never repeat the typed names (or, if possible, their initials)
    function shuffleNames() {
      const free = st.edited.map((e, i) => (e ? -1 : i)).filter((i) => i >= 0);
      const keep = st.edited.map((e, i) => (e ? (st.names[i].trim() || st.rolled[i]) : null)).filter(Boolean);
      pickTeamNames(free.length, Math.random, keep).forEach((nm, k) => { st.rolled[free[k]] = nm; st.names[free[k]] = nm; });
      paintTeams();
    }
    function paintRules() {
      teamVal.textContent = st.teamCount;
      photoVal.textContent = st.photos;
      teamDec.disabled = st.teamCount <= MIN_TEAMS;
      teamInc.disabled = st.teamCount >= MAX_TEAMS;
      photoDec.disabled = st.photos <= MIN_PHOTOS;
      photoInc.disabled = st.photos >= MAX_PHOTOS;
      roundsOut.textContent = st.teamCount * st.photos;
      segBtns.forEach((b) => b.setAttribute('aria-pressed', String(!st.custom && Number(b.dataset.sec) === st.timerSec)));
      customBtn.setAttribute('aria-pressed', String(st.custom));
      customRow.hidden = !st.custom;
      customPreview.textContent = st.timerSec ? `= ${mmss(st.timerSec * 1000)}` : '';
    }
    teamDec.onclick = () => { st.teamCount--; paintTeams(); paintRules(); };
    teamInc.onclick = () => { st.teamCount++; paintTeams(); paintRules(); };
    photoDec.onclick = () => { st.photos--; paintRules(); };
    photoInc.onclick = () => { st.photos++; paintRules(); };
    paintTeams();
    paintRules();

    parts.push(h('div.split',
      h('div.stack.lg',
        h('div.stack', { style: { gap: '8px' } }, h('div.label', 'Teams'), h('div.stepper', teamDec, teamVal, teamInc)),
        h('div.stack', { style: { gap: '8px' } }, h('div.label', 'Photos per team'), h('div.stepper', photoDec, photoVal, photoInc)),
        h('div.stack', { style: { gap: '8px' } }, h('div.label', 'Round timer'), h('div.seg', segBtns, customBtn), customRow),
        h('div.muted', roundsOut, ' rounds. Everyone guesses all but their own team\'s photos.')),
      h('div.stack',
        h('div.row', { style: { justifyContent: 'space-between' } },
          h('div.label', 'Team names (tap to rename)'),
          h('button.text-btn', { type: 'button', onclick: shuffleNames }, 'SHUFFLE NAMES')),
        grid)));

    parts.push(h('div.row', { style: { gap: '28px', paddingTop: '8px' } },
      h('button.btn.accent.lg', { type: 'button', onclick: startNew }, 'OPEN THE ROOM'),
      h('span.muted', 'Players join on their phones. No app, no account.')));

    return { el: h('div.stack.lg', parts) };
  }

  // ------------------------------------------------------------------ view: lobby

  function buildLobby() {
    const s = app.s;
    const labels = teamLabels(s.teams);
    const url = joinUrl(s.code);
    const svg = qrSvg(url);
    const qr = h('div.qr', { style: { width: 'min(100%, 16em)' } });
    if (svg) qr.innerHTML = svg; else qr.append(h('div.label', 'QR unavailable'));

    const left = h('div.stack.lg',
      h('div.stack', { style: { gap: '6px' } },
        h('div.label', 'Room code'),
        h('div', {
          style: { ...MONO, fontWeight: '600', fontSize: 'clamp(72px, 9.5vw, 240px)', lineHeight: '.95', letterSpacing: '.02em' },
        }, s.code)),
      h('div.stack', { style: { gap: '10px' } }, h('div.label', 'Scan to join'), qr),
      h('div.num.muted', { style: { wordBreak: 'break-all', fontSize: '.95em' } }, url));

    const rows = s.teams.map((t) => {
      const members = h('div.muted');
      const count = h('span.num', { style: { fontSize: '2.2em', fontWeight: '500' } });
      const fill = h('span');
      const row = h('div.sheet.stack',
        h('div.row', { style: { flexWrap: 'nowrap', gap: '16px' } },
          sticker(t, labels, s.teams.length <= 4 ? 'lg' : ''),
          h('div.stack', { style: { gap: '4px', flex: '1', minWidth: '0' } }, h('div.h2', t.name), members),
          count),
        h('div.progress', fill));
      return { t, members, count, fill, row };
    });

    const startBtn = h('button.btn.accent.lg', { type: 'button', onclick: () => doStart(false) }, 'START GAME');
    const trimBtn = h('button.text-btn', { type: 'button', onclick: () => doStart(true) }, 'Start with what we have');
    const hint = h('div.muted');
    const scrap = h('button.text-btn', {
      type: 'button',
      onclick: () => { if (confirm('Close this room and start over?')) scrapGame(); },
    }, 'Scrap this room');

    const right = h('div.stack',
      h('div.row', { style: { alignItems: 'flex-start', gap: '20px' } },
        h('div.stack', { style: { gap: '8px', flex: '1', minWidth: '0' } },
          h('h2.h2', 'The teams'),
          h('span.label', 'Need ', h('span.num', s.config.photosPerTeam), s.config.photosPerTeam === 1 ? ' photo each' : ' photos each'),
          hint),
        h('div.stack', { style: { gap: '10px', alignItems: 'flex-end' } }, startBtn, trimBtn)),
      h('div', rows.map((r) => r.row)),
      h('div.row', scrap));

    return {
      el: h('div.split', left, right),
      update() {
        const s2 = app.s;
        const per = G.uploadsByTeam(s2);
        const R = s2.config.photosPerTeam;
        for (const r of rows) {
          const mine = s2.players.filter((p) => p.teamId === r.t.id);
          r.members.replaceChildren(...(mine.length
            ? mine.flatMap((p, i) => [i ? ', ' : '', h('span', { style: p.connected ? {} : { opacity: '.45' } }, p.name)])
            : ['Nobody yet.']));
          r.count.textContent = `${per[r.t.id]}/${R}`;
          r.count.classList.toggle('accent-text', per[r.t.id] >= R);
          r.fill.style.width = `${Math.min(100, (per[r.t.id] / R) * 100)}%`;
        }
        const ok = G.canStart(s2), okTrim = G.canStartTrim(s2);
        startBtn.disabled = !ok;
        trimBtn.disabled = !okTrim;
        if (ok) hint.textContent = `All set. ${s2.teams.length * R} rounds, ${(s2.teams.length - 1) * R} guesses each.`;
        else if (okTrim) {
          const n = G.trimTarget(s2);
          hint.textContent = `Short a few? Every team plays ${n} photo${n === 1 ? '' : 's'} (${s2.teams.length * n} rounds), extras get benched.`;
        } else {
          const missing = s2.teams.filter((t) => !per[t.id]).map((t) => t.name);
          hint.textContent = missing.length ? `Still waiting on ${missing.join(', ')}.` : 'Waiting on photos.';
        }
      },
    };
  }

  // ------------------------------------------------------------------ view: round

  function buildRound() {
    const s = app.s;
    const labels = teamLabels(s.teams);
    const cur = G.currentUpload(s);
    const total = s.order.length;
    const idx = s.roundIndex;

    const rail = h('nav.rail', { 'aria-label': 'Rounds', style: { maxHeight: 'calc(100dvh - 6em)', overflowY: 'auto' } },
      Array.from({ length: total }, (_, i) => h('div.rail-item', {
        dataset: { state: i < idx ? 'done' : i === idx ? 'current' : 'todo' },
      }, `R${i + 1}`)));

    const timer = h('div.timer', { style: { fontSize: '3em' } });
    const sitter = teamById(s, cur.teamId);
    const head = h('div.row', { style: { gap: '20px' } },
      h('h2.h2', { style: { fontSize: '2.4em' } }, 'Round ', h('span.num', idx + 1), h('span.muted', ' / '), h('span.num', total)),
      h('span.tag.accent', `${sitter.name} sits this one out`),
      h('span.spacer'),
      timer);

    const well = photoWell('calc(100dvh - 16em)');
    const cells = s.teams.map((t) => {
      const st = h('span.status', { dataset: { state: 'pinning' } }, 'PINNING');
      return { t, st, el: h('div.row', { style: { flexWrap: 'nowrap', gap: '10px' } }, sticker(t, labels), h('div.h2', { style: { fontSize: '1.3em' } }, t.name), st) };
    });
    const strip = h('div.row', { style: { gap: '18px 36px' } }, cells.map((c) => c.el));
    const endBtn = h('button.text-btn', { type: 'button', onclick: endRoundNow }, 'End round now');
    const body = h('div.stack', head, well.el, strip, h('div.row', endBtn));

    const view = {
      el: h('div.with-rail', rail, body),
      mounted() {
        const now = rail.children[idx];
        if (now) rail.scrollTop = now.offsetTop - rail.clientHeight / 2;
      },
      tick() {
        const s2 = app.s;
        if (s2.deadline == null) { timer.textContent = '--:--'; timer.classList.remove('warn'); return; }
        const left = Math.max(0, s2.deadline - Date.now());
        timer.textContent = mmss(left);
        timer.classList.toggle('warn', left <= 10_000);
      },
      update() {
        const s2 = app.s;
        well.sync();
        for (const c of cells) {
          const lock = s2.locks[c.t.id];
          if (c.t.id === cur.teamId) { c.st.dataset.state = 'out'; c.st.textContent = 'SITS OUT'; }
          else if (lock) { c.st.dataset.state = 'pinned'; c.st.textContent = `LOCKED · ${lock.name}`; }
          else { c.st.dataset.state = 'pinning'; c.st.textContent = 'PINNING'; }
        }
        view.tick();
      },
    };
    return view;
  }

  // ------------------------------------------------------------------ view: reveal

  function buildReveal() {
    const s = app.s;
    const labels = teamLabels(s.teams);
    const pub = G.toPublic(s, { now: Date.now() });
    const rv = pub.reveal;
    const idx = s.roundIndex;
    const last = idx + 1 >= s.order.length;
    const scoreOf = Object.fromEntries(pub.scores.map((x) => [x.teamId, x]));
    const uploaderTeam = teamById(s, rv.uploaderTeamId);

    const nextBtn = h('button.btn.accent.lg', { type: 'button', onclick: () => doNext(idx) }, last ? 'SEE RESULTS →' : 'NEXT ROUND →');
    const head = h('div.row', { style: { gap: '20px' } },
      h('h2.h2', { style: { fontSize: '2.4em' } }, 'Round ', h('span.num', idx + 1), h('span.muted', ' / '), h('span.num', s.order.length), ' · the answer'),
      h('span.spacer'),
      h('span.label.muted', 'Space / → to go on'),
      nextBtn);

    const well = photoWell('min(44vh, 34em)');
    const left = h('div.stack',
      well.el,
      h('div.row', { style: { gap: '12px' } },
        sticker(uploaderTeam, labels),
        h('div.h2', { style: { fontSize: '1.4em' } }, 'Photo by ', rv.uploaderName, ' (', uploaderTeam.name, ')')));

    const mapEl = h('div.map');
    const mapBox = h('div', { style: { height: 'min(44vh, 34em)', minHeight: '320px' } }, mapEl);

    const best = rv.guesses.filter((g) => !g.penalty).reduce((m, g) => Math.min(m, g.km), Infinity);
    const bodyRows = rv.guesses.map((g, i) => {
      const t = teamById(s, g.teamId);
      return h('tr', { class: !g.penalty && g.km === best ? 'winner' : null },
        h('td.num', i + 1),
        h('td', h('div.row', { style: { flexWrap: 'nowrap', gap: '10px' } }, sticker(t, labels), h('span.h2', { style: { fontSize: '1.2em' } }, t.name))),
        h('td', g.lockedBy || h('span.muted', 'no pin')),
        h('td.num', g.penalty ? `${km(PENALTY_KM)} (penalty)` : `${km(g.km)} km`),
        h('td.num', `${km(scoreOf[g.teamId].totalKm)} km`));
    });
    bodyRows.push(h('tr',
      h('td.num.muted', '–'),
      h('td', h('div.row', { style: { flexWrap: 'nowrap', gap: '10px' } }, sticker(uploaderTeam, labels), h('span.h2.muted', { style: { fontSize: '1.2em' } }, uploaderTeam.name))),
      h('td.muted', 'sat this one out'),
      h('td.num.muted', '–'),
      h('td.num', `${km(scoreOf[uploaderTeam.id].totalKm)} km`)));
    const board = h('table.board', { style: { width: '100%' } },
      h('thead', h('tr', h('th', '#'), h('th', 'Team'), h('th', 'Pinned by'), h('th.num', { style: { textAlign: 'right' } }, 'This round'), h('th.num', { style: { textAlign: 'right' } }, 'Total'))),
      h('tbody', bodyRows));

    let map = null, gone = false;
    return {
      el: h('div.stack.lg', head, h('div.split', left, mapBox), board),
      mounted() {
        requestAnimationFrame(() => {
          if (gone) return;
          try {
            map = createMap(mapEl, { interactive: true });
            map.invalidateSize();
            renderReveal(map, {
              target: rv.target,
              guesses: rv.guesses.map((g) => ({
                lat: g.lat, lng: g.lng, km: g.km, penalty: g.penalty,
                color: teamById(s, g.teamId).color, label: labels[g.teamId],
              })),
              animate: true,
            });
          } catch (e) { console.warn('[host] map failed', e); }
        });
      },
      update() { well.sync(); },
      destroy() { gone = true; try { map?.remove(); } catch (e) { /* ignore */ } },
    };
  }

  // ------------------------------------------------------------------ view: final

  function buildFinal() {
    const s = app.s;
    const labels = teamLabels(s.teams);
    const pub = G.toPublic(s, { now: Date.now() });
    const aw = G.awards(s);
    const top = pub.scores[0].totalKm;
    const winners = pub.scores.filter((x) => Math.abs(x.totalKm - top) < 0.05).map((x) => teamById(s, x.teamId));

    const winnerBlock = h('div.row', { style: { gap: '32px', flexWrap: 'nowrap' } },
      h('div.row', { style: { flexWrap: 'nowrap', gap: '0' } },
        winners.map((t, i) => h('span', { style: { marginLeft: i ? '-28px' : '0' } }, sticker(t, labels, 'xl')))),
      h('div.stack', { style: { gap: '8px' } },
        h('div.label', winners.length > 1 ? 'A tie at the top' : 'And the winner is'),
        h('div.display', `${winners.map((t) => t.name).join(' & ')} WIN.`)));

    const rows = pub.scores.map((sc, i) => {
      const t = teamById(s, sc.teamId);
      return h('tr', { class: Math.abs(sc.totalKm - top) < 0.05 ? 'winner' : null },
        h('td.num', i + 1),
        h('td', h('div.row', { style: { flexWrap: 'nowrap', gap: '10px' } }, sticker(t, labels), h('span.h2', { style: { fontSize: '1.3em' } }, t.name))),
        h('td.num', { style: { textAlign: 'right' } }, `${km(sc.totalKm)} km`),
        h('td.num', { style: { textAlign: 'right' } }, `${km(aw.averages[sc.teamId])} km`),
        h('td.num', { style: { textAlign: 'right' } }, sc.played));
    });
    const board = h('table.board', { style: { width: '100%' } },
      h('thead', h('tr', h('th', '#'), h('th', 'Team'), h('th', { style: { textAlign: 'right' } }, 'Total'), h('th', { style: { textAlign: 'right' } }, 'Avg per round'), h('th', { style: { textAlign: 'right' } }, 'Rounds'))),
      h('tbody', rows));

    let callout = null;
    if (aw.closest) {
      const c = aw.closest;
      const gt = teamById(s, c.teamId), ut = teamById(s, c.uploaderTeamId);
      callout = h('div.callout.stack', { style: { gap: '10px' } },
        h('div.label', 'Closest guess of the night'),
        h('div.big-num', `${km(c.km)} km`),
        h('div', `${gt.name} (${c.lockedBy}) on ${c.uploaderName}'s photo for ${ut.name}, round `, h('span.num', c.roundIndex + 1), '.'));
    }

    const actions = h('div.row', { style: { gap: '28px' } },
      h('button.btn.accent.lg', { type: 'button', onclick: doPlayAgain }, 'PLAY AGAIN'),
      h('button.btn.lg', {
        type: 'button',
        onclick: () => { if (confirm('Close the room and start a brand new game?')) scrapGame(); },
      }, 'NEW GAME'),
      h('span.muted', 'Play again keeps the teams and players. New photos, fresh scores.'));

    return {
      el: h('div.stack.lg', winnerBlock, h('div.split', callout || h('div'), board), actions),
    };
  }

  // ------------------------------------------------------------------ boot

  render();
  store.loadGame().then((saved) => {
    if (saved && saved.phase !== PHASE.FINAL && saved.phase !== PHASE.SETUP) app.saved = saved;
    goSetup();
  }).catch(() => goSetup());

  return () => {
    clearInterval(tickTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('fmg-theme', paintTheme);
  };
}
