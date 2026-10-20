// Phone view. Everything is driven by the latest STATE snapshot plus a little local UI state.
// A screen is rebuilt only when its key changes (kind, or round index); otherwise update() patches nodes,
// so the Leaflet picker, file input and name field survive the stream of STATE messages.

import { h, mount, clear, toast, wordmark } from './dom.js';
import { MSG, ERR, PHASE, CODE_ALPHABET, CODE_LENGTH, msg } from './protocol.js';
import { joinRoom } from './net.js';
import { processPhoto } from './photo.js';
import { createPicker, createMap, renderReveal } from './map.js';
import { formatKm } from './geo.js';

const LS_NAME = 'fmg-name';
const LS_PLAYER = 'fmg-player';
const LS_TEAM = 'fmg-team';

const ERR_TEXT = {
  [ERR.TEAM_FULL]: "Team's full. Delete a photo to swap.",
  [ERR.NOT_IN_LOBBY]: 'Too late, the game already started.',
  [ERR.SITTING_OUT]: "That's your team's photo. No peeking.",
  [ERR.ALREADY_LOCKED]: 'Your team already locked in.',
  [ERR.BAD_ROUND]: "That round's already over.",
};

const TIP =
  "iPhone: in the photo picker tap Options, then turn on Location. Or choose 'Browse', or take the photo " +
  'with the Camera app first. Android: some galleries strip location, so use Files instead.';

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function initials(name) {
  const w = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (w.length > 1) return (w[0][0] + w[1][0]).toUpperCase();
  return (w[0] || '?')[0].toUpperCase();
}

const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
// `hidden` loses to class-level display rules, so toggle display directly.
const show = (el, on) => { el.style.display = on ? '' : 'none'; };

// Keyed child reconciliation: keeps existing nodes (and their focus / pending taps) alive.
function keyed(container, items, key, make, patch) {
  const existing = container._k || (container._k = new Map());
  const seen = new Set();
  let prev = null;
  for (const it of items) {
    const k = key(it);
    seen.add(k);
    let e = existing.get(k);
    if (!e) { e = make(it); existing.set(k, e); }
    patch(e, it);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (e.el !== want) container.insertBefore(e.el, want);
    prev = e.el;
  }
  for (const [k, e] of [...existing]) {
    if (!seen.has(k)) { e.el.remove(); existing.delete(k); }
  }
}

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function goToCode(value) {
  const c = String(value || '').toUpperCase().replace(new RegExp(`[^${CODE_ALPHABET}]`, 'g'), '');
  const u = new URL(location.href);
  u.searchParams.set('join', c);
  location.assign(u.toString());
}

// ---------------------------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------------------------

export function mountPlayer(root, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  const codeOk = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code);

  let playerId = lsGet(LS_PLAYER);
  if (!playerId) { playerId = uuid(); lsSet(LS_PLAYER, playerId); }
  let name = (lsGet(LS_NAME) || '').trim();
  let localTeam = null;
  try {
    const saved = JSON.parse(lsGet(LS_TEAM) || 'null');
    if (saved && saved.code === code) localTeam = saved.teamId;
  } catch (e) {}

  let net = null;
  let status = 'connecting';
  let state = null;
  let you = null;
  let roundPhoto = null;          // { index, url }
  const previews = new Map();     // uploadId -> object URL (my own uploads)
  let fullOverlay = null;

  let cur = null;                 // { key, el, update, mounted, destroy, onError, onPhoto }
  let curKey = null;

  // --- shell ---------------------------------------------------------------------------------
  const statusSlot = h('span.row');
  const body = h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minHeight: '0', paddingTop: 'var(--s4)' } });
  const shell = h(
    'div.screen',
    { style: { display: 'flex', flexDirection: 'column' } },
    h('header.masthead', wordmark(), statusSlot),
    body,
  );
  mount(root, shell);

  // --- lookups -------------------------------------------------------------------------------
  const teamById = (id) => (state && state.teams.find((t) => t.id === id)) || null;
  const myTeam = () => teamById(you && you.teamId);
  const teamName = (id) => (teamById(id) ? teamById(id).name : '?');
  const teamCount = (id) => (state ? state.uploads.filter((u) => u.teamId === id).length : 0);

  // --- network -------------------------------------------------------------------------------
  function sendHello(teamId) {
    if (!net) return;
    net.send(msg(MSG.HELLO, { playerId, name, teamId: teamId ?? null }));
  }

  function rememberTeam(teamId) {
    localTeam = teamId;
    lsSet(LS_TEAM, JSON.stringify({ code, teamId }));
  }

  function pickTeam(teamId, nameInput) {
    const nm = ((nameInput && nameInput.value) || name || '').trim();
    if (!nm) {
      toast('Name first, then team.');
      if (nameInput) nameInput.focus();
      return;
    }
    const renamed = nm !== name;
    name = nm;
    lsSet(LS_NAME, name);
    rememberTeam(teamId);
    if (!net) return;
    if (you && you.teamId != null && !renamed) net.send(msg(MSG.JOIN_TEAM, { teamId }));
    else sendHello(teamId);
    render();
  }

  function onStatus(s) {
    status = s;
    if (s === 'open' && name) sendHello((you && you.teamId) ?? localTeam);
    render();
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case MSG.STATE:
        state = m.state;
        you = m.you;
        if (you && you.teamId) { if (you.teamId !== localTeam) rememberTeam(you.teamId); }
        if (you && you.name && !name) { name = you.name; lsSet(LS_NAME, name); }
        if (state.phase !== PHASE.ROUND && state.phase !== PHASE.REVEAL) dropRoundPhoto();
        if (state.phase !== PHASE.LOBBY) dropPreviews();
        render();
        break;
      case MSG.ROUND_PHOTO: {
        if (m.image == null) break;
        const url = URL.createObjectURL(new Blob([m.image], { type: 'image/jpeg' }));
        if (roundPhoto) URL.revokeObjectURL(roundPhoto.url);
        roundPhoto = { index: m.roundIndex, url };
        if (cur && cur.onPhoto) cur.onPhoto(roundPhoto);
        break;
      }
      case MSG.ERROR:
        toast(ERR_TEXT[m.code] || m.message || 'Something went sideways.');
        if (cur && cur.onError) cur.onError(m);
        break;
      default:
    }
  }

  function dropRoundPhoto() {
    if (roundPhoto) { URL.revokeObjectURL(roundPhoto.url); roundPhoto = null; }
  }
  function dropPreviews() {
    for (const url of previews.values()) URL.revokeObjectURL(url);
    previews.clear();
  }

  // --- reusable pieces -----------------------------------------------------------------------

  // List of team buttons with member names + upload progress. Patched in place.
  function teamPicker({ onPick, selected }) {
    const el = h('div.stack');
    function update() {
      const cap = state ? state.config.photosPerTeam : 0;
      keyed(
        el,
        state ? state.teams : [],
        (t) => t.id,
        (t) => {
          const sticker = h('span.sticker');
          const nameEl = h('span', {
            style: { fontFamily: 'var(--font-display)', fontWeight: '700', fontSize: '22px', textTransform: 'uppercase', letterSpacing: 'var(--track-tight)', lineHeight: '1' },
          });
          const members = h('span.label', { style: { color: 'inherit', opacity: '.7', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' } });
          const count = h('span.num');
          const btn = h(
            'button.team-chip',
            {
              type: 'button',
              style: { width: '100%', justifyContent: 'flex-start', textAlign: 'left', gap: '12px', padding: '8px 14px 8px 8px' },
              onclick: () => onPick(t.id),
            },
            sticker,
            h('span', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flex: '1', minWidth: '0', gap: '3px' } }, nameEl, members),
            count,
          );
          return { el: btn, sticker, nameEl, members, count };
        },
        (e, t) => {
          e.el.style.setProperty('--team', t.color);
          setText(e.sticker, initials(t.name));
          setText(e.nameEl, t.name);
          const names = state.players.filter((p) => p.teamId === t.id).map((p) => p.name);
          setText(e.members, names.length ? names.join(', ') : 'Nobody yet');
          setText(e.count, `${teamCount(t.id)}/${cap}`);
          e.el.setAttribute('aria-pressed', selected() === t.id ? 'true' : 'false');
          e.el.style.boxShadow = selected() === t.id ? 'var(--hard)' : '';
        },
      );
    }
    return { el, update };
  }

  // Round header: R3/12 + countdown. Deadline is local (Date.now() + remainingMs from the latest STATE).
  function roundHeader() {
    const lbl = h('span.num', { style: { fontSize: '18px', fontWeight: '600' } });
    const timer = h('span.timer', { style: { fontSize: '30px' } });
    const noLimit = h('span.label', 'No timer');
    const el = h('div.row', { style: { justifyContent: 'space-between', flexWrap: 'nowrap', borderBottom: '1px solid var(--rule)', paddingBottom: '8px' } }, lbl, timer, noLimit);
    let deadline = null;
    let iv = null;
    function tick() {
      if (deadline == null) return;
      const ms = deadline - Date.now();
      setText(timer, fmtClock(ms));
      timer.classList.toggle('warn', ms <= 10000);
    }
    return {
      el,
      set(r) {
        setText(lbl, `R${r.index + 1}/${r.total}`);
        deadline = r.remainingMs == null ? null : Date.now() + r.remainingMs;
        show(timer, deadline != null);
        show(noLimit, deadline == null);
        tick();
        if (deadline != null && !iv) iv = setInterval(tick, 250);
      },
      stop() { clearInterval(iv); iv = null; },
    };
  }

  function statusRow() {
    const el = h('div.row');
    return {
      el,
      update() {
        const r = state.round;
        keyed(
          el,
          state.teams,
          (t) => t.id,
          () => ({ el: h('span.status') }),
          (e, t) => {
            const st = t.id === r.uploaderTeamId ? 'out' : r.locked && r.locked[t.id] ? 'pinned' : 'pinning';
            e.el.dataset.state = st;
            setText(e.el, t.name + (you && t.id === you.teamId ? ' (you)' : ''));
          },
        );
      },
    };
  }

  function openFull(url) {
    closeFull();
    const close = () => closeFull();
    fullOverlay = h(
      'div.overlay',
      { onclick: close, role: 'dialog', 'aria-label': 'Round photo' },
      h(
        'div.modal',
        { style: { padding: '8px', maxWidth: '96vw' } },
        h('img', { src: url, alt: 'Round photo', style: { display: 'block', maxWidth: '100%', maxHeight: '80dvh', margin: '0 auto' } }),
        h('div.label.center', { style: { marginTop: '8px' } }, 'Tap to close'),
      ),
    );
    document.body.append(fullOverlay);
  }
  function closeFull() {
    if (fullOverlay) { fullOverlay.remove(); fullOverlay = null; }
  }

  const swatch = (color) =>
    h('span', { style: { display: 'inline-block', width: '10px', height: '10px', background: color, border: '1.5px solid var(--ink)', marginRight: '8px', verticalAlign: '-1px' } });

  // ===========================================================================================
  // Screens
  // ===========================================================================================

  function buildMessage(title, text, extra) {
    return {
      el: h('div.stack.lg', h('div.h2', title), text ? h('p.muted', text) : null, extra || null),
    };
  }

  // ---- code entry / not found -------------------------------------------------------------
  function buildCodeEntry(kind) {
    const input = h('input.input', {
      type: 'text',
      maxlength: CODE_LENGTH,
      placeholder: 'KQZP',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      'aria-label': 'Room code',
      style: { fontFamily: 'var(--font-mono)', fontSize: '40px', letterSpacing: '.2em', textTransform: 'uppercase', textAlign: 'center' },
      oninput: () => {
        const v = input.value.toUpperCase().replace(new RegExp(`[^${CODE_ALPHABET}]`, 'g'), '');
        if (v !== input.value) input.value = v;
        go.disabled = v.length !== CODE_LENGTH;
      },
      onkeydown: (e) => { if (e.key === 'Enter' && !go.disabled) goToCode(input.value); },
    });
    const go = h('button.btn.accent.lg', { type: 'button', disabled: true, onclick: () => goToCode(input.value) }, 'Try that code');
    const title = kind === 'notfound' ? `Room ${code} not found` : "What's the room code?";
    const sub = kind === 'notfound' ? 'Check the code on the TV.' : "It's on the TV, big as life.";
    return {
      el: h('div.stack.lg', h('div.h2', title), h('p.muted', sub), h('label.field', h('span.label', 'Room code'), input), go),
      mounted() { setTimeout(() => input.focus(), 50); },
    };
  }

  // ---- join (name + team) ------------------------------------------------------------------
  function buildJoin() {
    const nameInput = h('input.input', {
      type: 'text',
      maxlength: 16,
      placeholder: 'e.g. Ana',
      autocomplete: 'off',
      autocapitalize: 'words',
      enterkeyhint: 'go',
      'aria-label': 'Your name',
      oninput: () => {
        name = nameInput.value.trim();
        lsSet(LS_NAME, name);
        sync();
      },
      onkeydown: (e) => { if (e.key === 'Enter') { nameInput.blur(); if (!state) next(); } },
    });
    nameInput.value = name;
    const picker = teamPicker({ onPick: (id) => pickTeam(id, nameInput), selected: () => (you && you.teamId) ?? localTeam });
    const waiting = h('div.empty.pulse', 'Connecting to the TV…');
    const next = () => {
      const nm = nameInput.value.trim();
      if (!nm || status !== 'open') return;
      name = nm;
      lsSet(LS_NAME, name);
      sendHello(localTeam);
    };
    const nextBtn = h('button.btn.accent.lg', { type: 'button', onclick: next }, "Let's go");
    const teamsBlock = h('div.stack', h('span.label', 'Pick a team'), picker.el);

    function sync() {
      const has = !!state;
      show(teamsBlock, has);
      show(nextBtn, !has);
      show(waiting, !has);
      if (!has) {
        nextBtn.disabled = !nameInput.value.trim() || status !== 'open';
        setText(waiting, status === 'open' ? 'Say who you are, then pick a team.' : 'Connecting to the TV…');
        waiting.classList.toggle('pulse', status !== 'open');
      }
    }

    return {
      el: h(
        'div.stack.lg',
        h('div.stack', h('span.label', 'Room'), h('div.big-num', { style: { letterSpacing: '.12em' } }, code)),
        h('div.h2', 'Name. Team. Go.'),
        h('label.field', h('span.label', 'Your name'), nameInput),
        teamsBlock,
        waiting,
        nextBtn,
      ),
      update() { sync(); picker.update(); },
    };
  }

  // ---- lobby / upload ----------------------------------------------------------------------
  function buildLobby() {
    let destroyed = false;
    const queue = [];
    let inFlight = false;
    let pumping = false;
    let resolver = null;
    let jobPicker = null;
    const pending = new Set();   // optimistic: sent, not yet in STATE
    const deleted = new Set();   // optimistic: delete sent
    const sources = new Map();   // uploadId -> 'exif' | 'manual' (local knowledge)

    const sticker = h('span.sticker.lg');
    const teamLine = h('div.label', { style: { fontSize: '13px' } });
    const bar = h('div.progress', h('span'));
    const switchBtn = h('button.text-btn', { type: 'button', onclick: () => { show(switcher, switcher.style.display === 'none'); } }, 'Switch team');
    const teamList = teamPicker({
      onPick: (id) => { show(switcher, false); if (id !== (you && you.teamId)) pickTeam(id); },
      selected: () => you && you.teamId,
    });
    const switcher = h('div.stack', { style: { display: 'none' } }, h('span.label', 'Pick a team'), teamList.el);

    const jobSlot = h('div');
    const dzInput = h('input', {
      type: 'file',
      accept: 'image/*',
      multiple: true,
      style: { display: 'none' },
      onchange: () => {
        const files = [...dzInput.files];
        dzInput.value = '';
        enqueue(files);
      },
    });
    const dzTitle = h('span.h2');
    const dzSub = h('span.muted');
    const dropzone = h(
      'label.dropzone',
      {
        ondragover: (e) => { e.preventDefault(); dropzone.classList.add('drag'); },
        ondragleave: () => dropzone.classList.remove('drag'),
        ondrop: (e) => {
          e.preventDefault();
          dropzone.classList.remove('drag');
          enqueue([...(e.dataTransfer ? e.dataTransfer.files : [])]);
        },
      },
      dzInput,
      dzTitle,
      dzSub,
    );

    const thumbs = h('div.thumbs');
    const mates = h('div.muted');
    const ready = h('div.label');
    const tip = h('details', h('summary.label', { style: { cursor: 'pointer' } }, 'No location in your photos?'), h('p.muted', { style: { marginTop: '8px' } }, TIP));

    const el = h(
      'div.stack.lg',
      h('div.stack', h('div.row', { style: { flexWrap: 'nowrap', gap: '14px' } }, sticker, h('div.stack', { style: { flex: '1', gap: '6px' } }, teamLine, bar)), h('div.row', switchBtn, h('span.spacer'), mates)),
      switcher,
      jobSlot,
      dropzone,
      thumbs,
      h('hr.rule'),
      ready,
      tip,
    );

    // --- counts ---
    const myIds = () => {
      const ids = [];
      for (const id of (you && you.myUploadIds) || []) if (!deleted.has(id)) ids.push(id);
      for (const id of pending) if (!ids.includes(id) && !deleted.has(id)) ids.push(id);
      return ids;
    };
    const teamTotal = () => {
      if (!state || !you) return 0;
      const inState = new Set(state.uploads.map((u) => u.id));
      let n = state.uploads.filter((u) => u.teamId === you.teamId && !deleted.has(u.id)).length;
      for (const id of pending) if (!inState.has(id) && !deleted.has(id)) n++;
      return n;
    };
    const cap = () => state.config.photosPerTeam;
    const slotsLeft = () => cap() - teamTotal();

    // --- adding photos ---
    function enqueue(files) {
      files = files.filter(Boolean);
      if (!files.length) return;
      const left = slotsLeft() - queue.length - (inFlight ? 1 : 0);
      if (left <= 0) { toast("Team's full. Delete one to swap."); return; }
      if (files.length > left) {
        toast(`Only ${left} slot${left === 1 ? '' : 's'} left. Took the first ${left}.`);
        files = files.slice(0, left);
      }
      queue.push(...files);
      pump();
    }

    function finishJob(v) {
      if (jobPicker) { try { jobPicker.destroy(); } catch (e) {} jobPicker = null; }
      clear(jobSlot);
      const r = resolver;
      resolver = null;
      if (r) r(v);
    }

    function confirmJob(res) {
      return new Promise((resolve) => {
        const gps = res.gps;
        const team = myTeam();
        const mapEl = h('div.map', { style: { position: 'absolute', inset: '0' } });
        const ok = h('button.btn.accent.lg', { type: 'button', disabled: !gps, onclick: done }, gps ? "Yep, that's the spot" : 'Pin it here');
        const skip = h('button.text-btn', { type: 'button', onclick: () => finishJob(null) }, 'Skip this photo');
        const more = queue.length ? h('span.label', `+${queue.length} more after this`) : null;
        const card = h(
          'div.stack',
          { style: { border: '1px solid var(--ink)', padding: 'var(--s3)' } },
          h('div.photo-well', { style: { height: '120px', minHeight: '0' } }, h('img', { src: res.previewUrl, alt: 'Your photo' })),
          h('div.callout', h('div.label', gps ? 'Found location in photo — looks right?' : 'No location in this photo — tap where it was taken'), gps ? h('div.muted', 'Drag the pin if it is off.') : null),
          h('div', { style: { position: 'relative', height: 'min(50dvh, 320px)', minHeight: '240px' } }, mapEl),
          ok,
          h('div.row', skip, h('span.spacer'), more),
        );
        mount(jobSlot, card);
        resolver = resolve;
        requestAnimationFrame(() => {
          if (destroyed || resolver !== resolve) return;
          jobPicker = createPicker(mapEl, {
            color: team ? team.color : undefined,
            label: team ? initials(team.name) : '',
            initial: gps ? { lat: gps.lat, lng: gps.lng } : null,
            onChange: () => { ok.disabled = false; },
          });
          if (gps) { try { jobPicker.map.setView([gps.lat, gps.lng], 10, { animate: false }); } catch (e) {} }
          if (jobPicker.invalidate) jobPicker.invalidate();
        });

        function done() {
          const ll = jobPicker && jobPicker.getLatLng();
          if (!ll) return;
          const moved = gps && (Math.abs(ll.lat - gps.lat) > 1e-4 || Math.abs(ll.lng - gps.lng) > 1e-4);
          finishJob({ lat: ll.lat, lng: ll.lng, source: gps && !moved ? 'exif' : 'manual' });
        }
      });
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      while (queue.length && !destroyed) {
        if (slotsLeft() <= 0) { queue.length = 0; toast("Team's full."); break; }
        const file = queue.shift();
        inFlight = true;
        mount(jobSlot, h('div.empty.pulse', 'Reading photo…'));
        renderDz();
        let res;
        try {
          res = await processPhoto(file);
        } catch (e) {
          inFlight = false;
          clear(jobSlot);
          toast((e && e.message) || "Couldn't read that photo.");
          continue;
        }
        if (destroyed) { URL.revokeObjectURL(res.previewUrl); break; }
        const decision = await confirmJob(res);
        inFlight = false;
        if (!decision) { URL.revokeObjectURL(res.previewUrl); continue; }
        const uploadId = uuid();
        previews.set(uploadId, res.previewUrl);
        sources.set(uploadId, decision.source);
        pending.add(uploadId);
        net.send(msg(MSG.UPLOAD, { uploadId, full: res.full, guess: res.guess, lat: decision.lat, lng: decision.lng, source: decision.source }));
        patch();
      }
      inFlight = false;
      pumping = false;
      if (!destroyed) { clear(jobSlot); patch(); }
    }

    function removeUpload(id) {
      deleted.add(id);
      pending.delete(id);
      net.send(msg(MSG.DELETE_UPLOAD, { uploadId: id }));
      patch();
    }

    // --- rendering ---
    function renderDz() {
      const busy = inFlight || queue.length > 0;
      show(dropzone, !busy);
      if (!state || !you) return;
      const full = slotsLeft() <= 0;
      dzInput.disabled = full;
      dropzone.style.opacity = full ? '.55' : '';
      setText(dzTitle, full ? 'Team is full' : 'Add photos');
      setText(dzSub, full ? 'Delete one to swap it out.' : 'Somewhere your mates have never been, eh?');
    }

    function renderThumbs() {
      const sourceOf = (id) => {
        const u = state.uploads.find((x) => x.id === id);
        return (u && u.source) || sources.get(id) || '';
      };
      keyed(
        thumbs,
        myIds(),
        (id) => id,
        (id) => {
          const img = h('img', { alt: 'Uploaded photo' });
          const x = h('button.thumb-x', { type: 'button', 'aria-label': 'Delete photo', onclick: () => removeUpload(id) }, '×');
          const badge = h('span.thumb-badge');
          const note = h('span.label', { style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center' } }, 'Saved');
          return { el: h('div.thumb', { style: { position: 'relative' } }, img, note, x, badge), img, badge, note };
        },
        (e, id) => {
          const url = previews.get(id);
          if (url && e.img.getAttribute('src') !== url) e.img.src = url;
          show(e.img, !!url);
          show(e.note, !url);
          setText(e.badge, sourceOf(id) === 'exif' ? 'EXIF' : sourceOf(id) === 'manual' ? 'MANUAL' : '');
        },
      );
    }

    function patch() {
      if (!state || !you) return;
      const inState = new Set(state.uploads.map((u) => u.id));
      for (const id of [...pending]) if (inState.has(id)) pending.delete(id);
      for (const id of [...deleted]) if (!inState.has(id) && !pending.has(id) && !(you.myUploadIds || []).includes(id)) deleted.delete(id);
      const mine = new Set(myIds());
      for (const [id, url] of [...previews]) {
        if (!mine.has(id) && !deleted.has(id)) { URL.revokeObjectURL(url); previews.delete(id); }
      }

      const t = myTeam();
      const total = teamTotal();
      if (t) {
        sticker.style.setProperty('--team', t.color);
        setText(sticker, initials(t.name));
        setText(teamLine, `Your team: ${t.name} · ${total}/${cap()} photos`);
      }
      bar.firstElementChild.style.width = `${Math.min(100, (total / Math.max(1, cap())) * 100)}%`;

      const others = state.players.filter((p) => p.teamId === you.teamId && p.id !== you.playerId).map((p) => p.name);
      setText(mates, others.length ? `With ${others.join(', ')}` : 'Just you so far');

      const readyTeams = state.teams.filter((x) => teamCount(x.id) >= cap()).length;
      setText(
        ready,
        total >= cap()
          ? `Your team is set. ${readyTeams} of ${state.teams.length} teams ready. Hang tight for the host.`
          : `${readyTeams} of ${state.teams.length} teams ready. The host starts when every team has ${cap()}.`,
      );

      teamList.update();
      renderThumbs();
      renderDz();
    }

    return {
      el,
      update: patch,
      onError() {
        // An upload was refused: stop pretending it is on its way.
        const inState = new Set(state ? state.uploads.map((u) => u.id) : []);
        for (const id of [...pending]) if (!inState.has(id)) pending.delete(id);
        patch();
      },
      destroy() {
        destroyed = true;
        queue.length = 0;
        finishJob(null);
      },
    };
  }

  // ---- round: guessing ---------------------------------------------------------------------
  function buildGuess() {
    const r = state.round;
    const team = myTeam();
    const idx = r.index;
    let picker = null;
    let localLocked = false;
    let appliedLocked = false;
    let destroyed = false;

    const header = roundHeader();
    const statuses = statusRow();

    const photoSlot = h('div', { style: { height: 'clamp(140px, 26dvh, 240px)', flex: 'none' } });
    function setPhoto(p) {
      if (p && p.index === idx) {
        const img = h('img', { src: p.url, alt: 'Round photo' });
        mount(photoSlot, h('div.photo-well', { style: { height: '100%', minHeight: '0', cursor: 'zoom-in' }, role: 'button', 'aria-label': 'View photo fullscreen', onclick: () => openFull(p.url) }, img));
      } else {
        mount(photoSlot, h('div.empty', { style: { height: '100%', display: 'grid', placeItems: 'center', textAlign: 'center' } }, 'Look at the big screen'));
      }
    }
    setPhoto(roundPhoto);

    const mapEl = h('div.map', { style: { position: 'absolute', inset: '0' } });
    const mapSlot = h('div', { style: { position: 'relative', flex: '1', minHeight: '280px' } }, mapEl);

    const info = h('div.label');
    const lockBtn = h('button.btn.accent.lg', { type: 'button', disabled: true, onclick: lock }, 'LOCK IT IN');
    const bar = h(
      'div.stack',
      { style: { position: 'sticky', bottom: '0', background: 'var(--bg)', borderTop: '1px solid var(--rule)', padding: '10px 0 max(10px, env(safe-area-inset-bottom))', gap: '8px', zIndex: '5' } },
      statuses.el,
      info,
      lockBtn,
    );

    function isLocked() { return !!(state.round && state.round.locked && state.round.locked[you.teamId]) || localLocked; }

    function lock() {
      const ll = picker && picker.getLatLng();
      if (!ll || isLocked()) return;
      localLocked = true;
      try { navigator.vibrate && navigator.vibrate(30); } catch (e) {}
      net.send(msg(MSG.GUESS, { roundIndex: idx, lat: ll.lat, lng: ll.lng }));
      apply();
    }

    function apply() {
      const locked = isLocked();
      const by = state.round && state.round.locked && state.round.locked[you.teamId];
      if (picker && locked !== appliedLocked) { picker.setLocked(locked); appliedLocked = locked; }
      if (locked) {
        setText(info, by ? `Locked by ${by}` : 'Locking…');
        setText(lockBtn, 'LOCKED');
        lockBtn.disabled = true;
      } else {
        const has = !!(picker && picker.getLatLng());
        setText(info, has ? 'Happy with it? Lock it in.' : 'Tap the map to drop your pin');
        setText(lockBtn, 'LOCK IT IN');
        lockBtn.disabled = !has;
      }
    }

    return {
      el: h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', gap: '10px' } }, header.el, photoSlot, mapSlot, bar),
      mounted() {
        requestAnimationFrame(() => {
          if (destroyed) return;
          picker = createPicker(mapEl, {
            color: team ? team.color : undefined,
            label: team ? initials(team.name) : '',
            initial: null,
            onChange: () => { if (picker) apply(); },
          });
          if (picker.invalidate) picker.invalidate();
          appliedLocked = false;
          apply();
        });
      },
      update() {
        const rr = state.round;
        header.set(rr);
        statuses.update();
        apply();
      },
      onPhoto: setPhoto,
      onError(m) {
        if (m.code !== ERR.ALREADY_LOCKED && localLocked && !(state.round.locked && state.round.locked[you.teamId])) {
          localLocked = false;
          apply();
        }
      },
      destroy() {
        destroyed = true;
        header.stop();
        closeFull();
        if (picker) { try { picker.destroy(); } catch (e) {} picker = null; }
      },
    };
  }

  // ---- round: sitting out ------------------------------------------------------------------
  function buildSitOut() {
    const r = state.round;
    const team = myTeam();
    const header = roundHeader();
    const statuses = statusRow();
    return {
      el: h(
        'div.stack.lg',
        header.el,
        h(
          'div.stack.center',
          { style: { alignItems: 'center', paddingTop: 'var(--s4)' } },
          h('span.sticker.xl', { style: { '--team': team ? team.color : '#ccc' } }, team ? initials(team.name) : ''),
          h('div.h2', "Your team's photo."),
          h('p.muted', 'Sit tight — no hints!'),
          h('div.label', `Uploaded by ${r.uploaderName}`),
        ),
        h('hr.rule'),
        h('div.stack', h('span.label', 'The others are guessing'), statuses.el),
      ),
      update() { header.set(state.round); statuses.update(); },
      destroy() { header.stop(); },
    };
  }

  // ---- reveal ------------------------------------------------------------------------------
  function buildReveal() {
    const rv = state.reveal;
    const total = state.round ? state.round.total : null;
    const myId = you.teamId;
    const mine = rv.guesses.find((g) => g.teamId === myId);
    const myPlace = mine ? rv.guesses.indexOf(mine) + 1 : 0;
    const out = rv.uploaderTeamId === myId;
    let map = null;
    let destroyed = false;

    const place = myPlace ? h('span.tag' + (myPlace === 1 ? '.accent' : ''), `#${myPlace} this round`) : h('span.tag', 'Sat out');

    let big;
    if (mine) {
      big = h(
        'div.stack',
        { style: { gap: '4px' } },
        h('span.label', mine.penalty ? 'No pin. Penalty.' : 'Your team was off by'),
        h('div.row', { style: { alignItems: 'baseline', flexWrap: 'nowrap' } }, h('span.big-num', formatKm(mine.km)), h('span.label', 'km')),
      );
    } else {
      big = h('div.stack', { style: { gap: '4px' } }, h('span.label', 'Your team’s photo'), h('div.h2', out ? 'Sat this one out' : 'No result'));
    }

    const mapEl = h('div.map', { style: { position: 'absolute', inset: '0' } });
    const mapSlot = h('div', { style: { position: 'relative', height: '260px' } }, mapEl);

    const roundRows = rv.guesses.map((g, i) => {
      const t = teamById(g.teamId);
      return h(
        'tr' + (i === 0 && !g.penalty ? '.winner' : ''),
        h('td.num', String(i + 1)),
        h('td', swatch(t ? t.color : '#ccc'), teamName(g.teamId), g.teamId === myId ? [' ', h('span.tag', 'You')] : null),
        h('td.num', g.penalty ? `${formatKm(g.km)}*` : formatKm(g.km)),
      );
    });
    const hasPenalty = rv.guesses.some((g) => g.penalty);

    const totals = state.scores.map((s, i) => {
      const t = teamById(s.teamId);
      return h(
        'tr' + (i === 0 ? '.winner' : ''),
        h('td.num', String(i + 1)),
        h('td', swatch(t ? t.color : '#ccc'), teamName(s.teamId), s.teamId === myId ? [' ', h('span.tag', 'You')] : null),
        h('td.num', formatKm(s.totalKm)),
      );
    });

    const head = (...cols) => h('thead', h('tr', cols.map((c, i) => h('th' + (i === cols.length - 1 ? '.num' : ''), c))));

    return {
      el: h(
        'div.stack.lg',
        h('div.row', h('span.label', `Round ${rv.roundIndex + 1}${total ? ` of ${total}` : ''}`), h('span.spacer'), place),
        big,
        mapSlot,
        h('div.stack', h('span.label', 'This round'), h('table.board', head('#', 'Team', 'km'), h('tbody', roundRows)), hasPenalty ? h('div.muted', '* No pin. Penalty distance.') : null, h('div.muted', `Photo by ${rv.uploaderName} (${teamName(rv.uploaderTeamId)})`)),
        h('div.stack', h('span.label', 'Running totals'), h('table.board', head('#', 'Team', 'Total km'), h('tbody', totals))),
        h('div.label.pulse.center', 'Waiting on the host…'),
      ),
      mounted() {
        requestAnimationFrame(() => {
          if (destroyed) return;
          try {
            map = createMap(mapEl, { interactive: false });
            const guesses = rv.guesses.map((g) => {
              const t = teamById(g.teamId);
              return { lat: g.lat, lng: g.lng, km: g.km, color: t ? t.color : '#ccc', label: t ? initials(t.name) : '?', penalty: !!g.penalty };
            });
            if (map.invalidateSize) map.invalidateSize();
            renderReveal(map, { target: rv.target, guesses, animate: true });
          } catch (e) {
            console.error('[player] reveal map failed', e);
          }
        });
      },
      destroy() {
        destroyed = true;
        if (map) { try { map.remove(); } catch (e) {} map = null; }
      },
    };
  }

  // ---- final -------------------------------------------------------------------------------
  function buildFinal() {
    const myId = you.teamId;
    const scores = state.scores;
    const mine = scores.find((s) => s.teamId === myId);
    const rankOf = (s) => 1 + scores.filter((x) => x.totalKm < s.totalKm).length;
    const rank = mine ? rankOf(mine) : null;
    const topKm = scores.length ? scores[0].totalKm : null;
    const quip = rank === 1 ? 'Champs. Try not to be smug.' : rank === scores.length && scores.length > 1 ? 'Last place. Builds character.' : 'Respectable. Mostly.';

    const rows = scores.map((s) => {
      const t = teamById(s.teamId);
      const win = s.totalKm === topKm;
      return h(
        'tr' + (win ? '.winner' : ''),
        h('td.num', String(rankOf(s))),
        h('td', swatch(t ? t.color : '#ccc'), teamName(s.teamId), s.teamId === myId ? [' ', h('span.tag', 'You')] : null),
        h('td.num', String(s.played)),
        h('td.num', formatKm(s.totalKm)),
      );
    });
    const winnerTeam = scores.length ? teamById(scores[0].teamId) : null;

    return {
      el: h(
        'div.stack.lg',
        h('span.label', 'Final'),
        mine
          ? h(
              'div.stack',
              { style: { gap: '4px' } },
              h('div.display', rank === 1 ? 'You won.' : `#${rank}`),
              h('div.muted', rank === 1 ? quip : `${quip} Out of ${scores.length}.`),
              h('div.row', { style: { alignItems: 'baseline', flexWrap: 'nowrap', marginTop: '8px' } }, h('span.big-num', formatKm(mine.totalKm)), h('span.label', 'km total')),
            )
          : h('div.h2', winnerTeam ? `${winnerTeam.name} won` : 'That’s a wrap'),
        h('table.board', h('thead', h('tr', h('th', '#'), h('th', 'Team'), h('th.num', 'Rds'), h('th.num', 'Total km'))), h('tbody', rows)),
        h('div.label.center', 'Look up. The TV has the victory lap.'),
      ),
    };
  }

  // ===========================================================================================
  // Router
  // ===========================================================================================

  function pickKey() {
    if (!code) return 'code';
    if (!codeOk || status === 'not-found') return 'notfound';
    if (!state || !you) return name && localTeam ? 'rejoin' : 'join';
    if (!you.teamId) return state.phase === PHASE.LOBBY ? 'join' : 'late';
    const r = state.round;
    switch (state.phase) {
      case PHASE.LOBBY: return 'lobby';
      case PHASE.ROUND:
        if (!r) return 'late';
        return `round:${r.index}:${r.uploaderTeamId === you.teamId ? 'out' : 'guess'}`;
      case PHASE.REVEAL: return state.reveal ? `reveal:${state.reveal.roundIndex}` : 'late';
      case PHASE.FINAL: return 'final';
      default: return 'late';
    }
  }

  function buildFor(key) {
    if (key === 'code') return buildCodeEntry('code');
    if (key === 'notfound') return buildCodeEntry('notfound');
    if (key === 'join') return buildJoin();
    if (key === 'rejoin') return buildMessage('Rejoining…', `Getting you back into ${code}.`);
    if (key === 'late') return buildMessage('Game on.', "You're not on a team for this one. Watch the big screen. You'll get the next game.");
    if (key === 'lobby') return buildLobby();
    if (key.endsWith(':guess')) return buildGuess();
    if (key.endsWith(':out')) return buildSitOut();
    if (key.startsWith('reveal:')) return buildReveal();
    if (key === 'final') return buildFinal();
    return buildMessage('One sec…');
  }

  function renderMeta() {
    clear(statusSlot);
    if (!code || !codeOk) return;
    if (status === 'open') {
      if (you && you.name) statusSlot.append(h('span.label', you.name));
    } else if (status === 'not-found') {
      statusSlot.append(h('span.status', { 'data-state': 'offline' }, 'no room'));
    } else if (status === 'reconnecting') {
      statusSlot.append(h('span.status', { 'data-state': 'offline' }, 'reconnecting…'));
    } else {
      statusSlot.append(h('span.status', { 'data-state': 'waiting' }, 'connecting…'));
    }
  }

  let metaKey = '';
  function render() {
    const key = pickKey();
    if (key !== curKey) {
      if (cur && cur.destroy) cur.destroy();
      closeFull();
      cur = buildFor(key);
      curKey = key;
      mount(body, cur.el);
      if (cur.mounted) cur.mounted();
    }
    if (cur && cur.update) cur.update();
    const mk = `${status}|${you ? you.name : ''}`;
    if (mk !== metaKey) { metaKey = mk; renderMeta(); }
  }

  render();

  if (code && codeOk) {
    joinRoom(code, { onMessage, onStatus }).then((n) => { net = n; });
  }
}
