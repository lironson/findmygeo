// Pure game engine. No DOM, no browser globals, no Date.now(): callers inject `now` and `rng`.
// HostState is a plain JSON-able object (it is persisted to IndexedDB as-is).

import { haversineKm } from './geo.js';
import {
  VERSION, PHASE, ERR, PENALTY_KM, TIMER_OPTIONS, DEFAULT_TIMER,
  MIN_TEAMS, MAX_TEAMS, MIN_PHOTOS, MAX_PHOTOS, DEFAULT_TEAM_NAMES, TEAM_COLORS,
} from './protocol.js';

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const cleanName = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const validCoord = (lat, lng) =>
  typeof lat === 'number' && typeof lng === 'number' &&
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- setup

export function createGame({ code, teamCount = 4, photosPerTeam = 3, timerSec = DEFAULT_TIMER, teamNames = [] } = {}) {
  teamCount = clampInt(teamCount, MIN_TEAMS, MAX_TEAMS, 4);
  photosPerTeam = clampInt(photosPerTeam, MIN_PHOTOS, MAX_PHOTOS, 3);
  timerSec = TIMER_OPTIONS.includes(Number(timerSec)) ? Number(timerSec) : DEFAULT_TIMER;
  const used = new Set();
  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    let name = cleanName(teamNames[i], 12).toUpperCase() || DEFAULT_TEAM_NAMES[i];
    if (used.has(name)) { let k = 2; while (used.has(`${name} ${k}`)) k++; name = `${name} ${k}`; }
    used.add(name);
    teams.push({ id: `t${i}`, name, color: TEAM_COLORS[i] });
  }
  return {
    v: VERSION,
    code,
    phase: PHASE.LOBBY,
    config: { teamCount, photosPerTeam, timerSec },
    teams,
    players: [],          // { id, name, teamId, connected }
    uploads: [],          // { id, teamId, playerId, source, lat, lng }   (coords never leave the host pre-reveal)
    order: [],            // upload ids, one per round
    roundIndex: 0,
    roundStartedAt: null,
    deadline: null,       // epoch ms or null
    locks: {},            // teamId -> { playerId, name, lat, lng, at }
    history: [],          // finished rounds (internal form, includes uploadId)
  };
}

export function addOrUpdatePlayer(s, { playerId, name, teamId } = {}) {
  if (!playerId) return { error: ERR.UNKNOWN };
  const nm = cleanName(name, 16);
  let p = s.players.find((x) => x.id === playerId);
  const removedUploadIds = [];
  if (!p) {
    p = { id: playerId, name: nm || 'PLAYER', teamId: null, connected: true };
    s.players.push(p);
  } else if (nm) p.name = nm;

  if (teamId && teamId !== p.teamId && s.teams.some((t) => t.id === teamId)) {
    if (s.phase === PHASE.LOBBY) {
      // switching teams: uploads made for the old team are withdrawn
      if (p.teamId) {
        for (const u of s.uploads.filter((u) => u.playerId === p.id)) removedUploadIds.push(u.id);
        s.uploads = s.uploads.filter((u) => u.playerId !== p.id);
      }
      p.teamId = teamId;
    } else if (!p.teamId) {
      p.teamId = teamId; // late joiner picks a team mid-game
    }
  }
  return { ok: true, player: p, removedUploadIds };
}

export function setPlayerConnected(s, playerId, connected) {
  const p = s.players.find((x) => x.id === playerId);
  if (!p) return false;
  const changed = p.connected !== !!connected;
  p.connected = !!connected;
  return changed;
}

export function resetConnections(s) {
  for (const p of s.players) p.connected = false;
}

// ---------------------------------------------------------------- uploads

export function uploadsByTeam(s) {
  const c = {};
  for (const t of s.teams) c[t.id] = 0;
  for (const u of s.uploads) c[u.teamId] = (c[u.teamId] || 0) + 1;
  return c;
}

export function addUpload(s, { uploadId, playerId, lat, lng, source } = {}) {
  if (s.phase !== PHASE.LOBBY) return { error: ERR.NOT_IN_LOBBY };
  const p = s.players.find((x) => x.id === playerId);
  if (!p || !p.teamId || !uploadId) return { error: ERR.UNKNOWN };
  if (!validCoord(lat, lng)) return { error: ERR.UNKNOWN };
  const dup = s.uploads.find((u) => u.id === uploadId);
  if (dup) return dup.playerId === playerId ? { ok: true, duplicate: true } : { error: ERR.UNKNOWN };
  if (uploadsByTeam(s)[p.teamId] >= s.config.photosPerTeam) return { error: ERR.TEAM_FULL };
  s.uploads.push({
    id: uploadId, teamId: p.teamId, playerId, lat, lng,
    source: source === 'exif' ? 'exif' : 'manual',
  });
  return { ok: true };
}

export function removeUpload(s, playerId, uploadId) {
  if (s.phase !== PHASE.LOBBY) return { error: ERR.NOT_IN_LOBBY };
  const i = s.uploads.findIndex((u) => u.id === uploadId && u.playerId === playerId);
  if (i < 0) return { error: ERR.UNKNOWN };
  s.uploads.splice(i, 1);
  return { ok: true };
}

export function canStart(s) {
  if (s.phase !== PHASE.LOBBY) return false;
  const c = uploadsByTeam(s);
  return s.teams.every((t) => c[t.id] === s.config.photosPerTeam);
}

// "Start with what we have": every team has at least one photo.
export function canStartTrim(s) {
  return s.phase === PHASE.LOBBY && trimTarget(s) >= 1;
}

// How many photos per team a trimmed start would play (0 when some team has none).
export function trimTarget(s) {
  const c = uploadsByTeam(s);
  return Math.min(...s.teams.map((t) => c[t.id]));
}

// ---------------------------------------------------------------- ordering

// Can the remaining multiset `counts` be laid out with no two neighbours from the same team,
// given the first item must not come from `prev`?
function feasible(counts, prev) {
  let n = 0;
  for (const k in counts) n += counts[k];
  const hi = Math.ceil(n / 2), lo = Math.floor(n / 2);
  for (const k in counts) if (counts[k] > (k === prev ? lo : hi)) return false;
  return true;
}

/**
 * Shuffle uploads so that the same uploader team never appears twice in a row whenever that is possible.
 * At each step pick uniformly among teams (other than the previous) whose choice keeps the rest solvable.
 * If the input is unsolvable (one team has too many), fall back to greedy "most remaining first" which
 * minimises adjacent repeats, and repeats only when nothing else is left.
 */
export function orderRounds(uploads, rng = Math.random) {
  const pools = new Map();
  for (const u of uploads) {
    if (!pools.has(u.teamId)) pools.set(u.teamId, []);
    pools.get(u.teamId).push(u);
  }
  const counts = {};
  for (const [k, arr] of pools) { shuffle(arr, rng); counts[k] = arr.length; }
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const out = [];
  let prev = null;
  for (let i = 0; i < uploads.length; i++) {
    const cands = [...pools.keys()].filter((k) => counts[k] > 0 && k !== prev);
    let team;
    if (!cands.length) team = prev; // only the previous team is left: unavoidable
    else {
      const safe = cands.filter((k) => {
        counts[k]--;
        const ok = feasible(counts, k);
        counts[k]++;
        return ok;
      });
      if (safe.length) team = pick(safe);
      else {
        const max = Math.max(...cands.map((k) => counts[k]));
        team = pick(cands.filter((k) => counts[k] === max));
      }
    }
    out.push(pools.get(team).pop());
    counts[team]--;
    prev = team;
  }
  return out;
}

// ---------------------------------------------------------------- rounds

function beginRound(s, now) {
  s.locks = {};
  s.roundStartedAt = now;
  s.deadline = s.config.timerSec ? now + s.config.timerSec * 1000 : null;
}

// Give the current round a fresh clock (used when a saved game is resumed mid-round).
// Locks already in stay in: the phones that locked them still show "locked".
export function restartTimer(s, { now }) {
  if (s.phase !== PHASE.ROUND) return;
  s.roundStartedAt = now;
  s.deadline = s.config.timerSec ? now + s.config.timerSec * 1000 : null;
}

export function currentUpload(s) {
  if (s.phase !== PHASE.ROUND && s.phase !== PHASE.REVEAL) return null;
  const id = s.order[s.roundIndex];
  return s.uploads.find((u) => u.id === id) || null;
}

export function playingTeamIds(s) {
  const cur = currentUpload(s);
  return s.teams.filter((t) => !cur || t.id !== cur.teamId).map((t) => t.id);
}

/**
 * trim=false: requires canStart. trim=true: every team is cut down to the smallest team's count (>= 1);
 * the dropped uploads are returned so the caller can delete their photos.
 */
export function startGame(s, { rng = Math.random, trim = false, now } = {}) {
  if (s.phase !== PHASE.LOBBY) return { error: ERR.NOT_IN_LOBBY };
  const dropped = [];
  if (trim) {
    const n = trimTarget(s);
    if (n < 1) return { error: ERR.UNKNOWN };
    const keep = new Set();
    for (const t of s.teams) {
      const mine = shuffle(s.uploads.filter((u) => u.teamId === t.id), rng);
      mine.slice(0, n).forEach((u) => keep.add(u.id));
      mine.slice(n).forEach((u) => dropped.push(u.id));
    }
    s.uploads = s.uploads.filter((u) => keep.has(u.id));
  } else if (!canStart(s)) return { error: ERR.UNKNOWN };

  s.order = orderRounds(s.uploads, rng).map((u) => u.id);
  s.history = [];
  s.roundIndex = 0;
  s.phase = PHASE.ROUND;
  beginRound(s, now);
  return { ok: true, dropped };
}

export function allLocked(s) {
  if (s.phase !== PHASE.ROUND) return false;
  return playingTeamIds(s).every((id) => s.locks[id]);
}

export function submitGuess(s, { playerId, roundIndex, lat, lng, now } = {}) {
  if (s.phase !== PHASE.ROUND || roundIndex !== s.roundIndex) return { error: ERR.BAD_ROUND };
  const p = s.players.find((x) => x.id === playerId);
  if (!p || !p.teamId) return { error: ERR.UNKNOWN };
  const cur = currentUpload(s);
  if (!cur) return { error: ERR.BAD_ROUND };
  if (p.teamId === cur.teamId) return { error: ERR.SITTING_OUT };
  if (s.locks[p.teamId]) return { error: ERR.ALREADY_LOCKED };
  if (!validCoord(lat, lng)) return { error: ERR.UNKNOWN };
  s.locks[p.teamId] = { playerId, name: p.name, lat, lng, at: now ?? null };
  return { ok: true, teamId: p.teamId };
}

export function endRound(s, { now } = {}) {
  if (s.phase !== PHASE.ROUND) return { error: ERR.BAD_ROUND };
  const cur = currentUpload(s);
  const uploader = s.players.find((p) => p.id === cur.playerId);
  const guesses = playingTeamIds(s).map((teamId, i) => {
    const l = s.locks[teamId];
    if (!l) return { teamId, lat: null, lng: null, km: PENALTY_KM, penalty: true, lockedBy: null, _i: i };
    return {
      teamId, lat: l.lat, lng: l.lng,
      km: haversineKm({ lat: l.lat, lng: l.lng }, { lat: cur.lat, lng: cur.lng }),
      penalty: false, lockedBy: l.name, _i: i,
    };
  });
  guesses.sort((a, b) => a.km - b.km || a._i - b._i);
  guesses.forEach((g) => delete g._i);
  s.history.push({
    roundIndex: s.roundIndex,
    uploadId: cur.id,
    target: { lat: cur.lat, lng: cur.lng },
    guesses,
    uploaderTeamId: cur.teamId,
    uploaderName: uploader ? uploader.name : '',
    endedAt: now ?? null,
  });
  s.phase = PHASE.REVEAL;
  s.deadline = null;
  return { ok: true };
}

export function nextRound(s, { now } = {}) {
  if (s.phase !== PHASE.REVEAL) return { error: ERR.BAD_ROUND };
  if (s.roundIndex + 1 >= s.order.length) {
    s.phase = PHASE.FINAL;
    return { ok: true, final: true };
  }
  s.roundIndex += 1;
  s.phase = PHASE.ROUND;
  beginRound(s, now);
  return { ok: true };
}

// Same code, teams and players; photos and scores are wiped. Returns the upload ids whose photos can be deleted.
export function playAgain(s) {
  const removedUploadIds = s.uploads.map((u) => u.id);
  s.phase = PHASE.LOBBY;
  s.uploads = [];
  s.order = [];
  s.history = [];
  s.roundIndex = 0;
  s.roundStartedAt = null;
  s.deadline = null;
  s.locks = {};
  return { ok: true, removedUploadIds };
}

// ---------------------------------------------------------------- views

export function computeScores(s) {
  const total = {}, played = {};
  for (const t of s.teams) { total[t.id] = 0; played[t.id] = 0; }
  for (const r of s.history) for (const g of r.guesses) { total[g.teamId] += g.km; played[g.teamId] += 1; }
  return s.teams
    .map((t, i) => ({ teamId: t.id, totalKm: total[t.id], played: played[t.id], _i: i }))
    .sort((a, b) => a.totalKm - b.totalKm || a._i - b._i)
    .map(({ _i, ...rest }) => rest);
}

const publicResult = (r) => ({
  roundIndex: r.roundIndex,
  target: { ...r.target },
  guesses: r.guesses.map((g) => ({ ...g })),
  uploaderTeamId: r.uploaderTeamId,
  uploaderName: r.uploaderName,
});

export function toPublic(s, { now } = {}) {
  const inRound = s.phase === PHASE.ROUND || s.phase === PHASE.REVEAL;
  const cur = inRound ? currentUpload(s) : null;
  let round = null;
  if (cur) {
    const uploader = s.players.find((p) => p.id === cur.playerId);
    const locked = {};
    for (const [teamId, l] of Object.entries(s.locks)) locked[teamId] = l.name;
    round = {
      index: s.roundIndex,
      total: s.order.length,
      uploaderTeamId: cur.teamId,
      uploaderName: uploader ? uploader.name : '',
      remainingMs: s.phase === PHASE.ROUND && s.deadline != null ? Math.max(0, s.deadline - now) : null,
      locked,
    };
  }
  const showReveal = (s.phase === PHASE.REVEAL || s.phase === PHASE.FINAL) && s.history.length;
  return {
    v: VERSION,
    code: s.code,
    phase: s.phase,
    config: { ...s.config },
    teams: s.teams.map((t) => ({ ...t })),
    players: s.players.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId, connected: !!p.connected })),
    uploads: s.uploads.map((u) => ({ id: u.id, teamId: u.teamId, playerId: u.playerId, source: u.source })),
    round,
    reveal: showReveal ? publicResult(s.history[s.history.length - 1]) : null,
    scores: computeScores(s),
    history: s.history.map(publicResult),
  };
}

export function youFor(s, playerId) {
  const p = s.players.find((x) => x.id === playerId);
  if (!p) return { playerId, name: '', teamId: null, myUploadIds: [] };
  return {
    playerId: p.id,
    name: p.name,
    teamId: p.teamId,
    myUploadIds: s.uploads.filter((u) => u.playerId === p.id).map((u) => u.id),
  };
}

export function awards(s) {
  let closest = null;
  for (const r of s.history) {
    for (const g of r.guesses) {
      if (g.penalty) continue;
      if (!closest || g.km < closest.km) {
        closest = {
          teamId: g.teamId, km: g.km, roundIndex: r.roundIndex, lockedBy: g.lockedBy,
          uploaderTeamId: r.uploaderTeamId, uploaderName: r.uploaderName,
        };
      }
    }
  }
  const averages = {};
  for (const sc of computeScores(s)) averages[sc.teamId] = sc.played ? sc.totalKm / sc.played : 0;
  return { closest, averages };
}
