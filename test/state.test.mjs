import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../js/state.js';
import { haversineKm } from '../js/geo.js';
import { PHASE, ERR, PENALTY_KM } from '../js/protocol.js';

// deterministic rng (mulberry32)
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A lobby with T teams, each with 2 players, each team holding R photos (optionally `counts` per team).
function lobby({ T = 3, R = 2, timerSec = 60, counts = null } = {}) {
  const s = G.createGame({ code: 'KQZP', teamCount: T, photosPerTeam: R, timerSec });
  let n = 0;
  for (let i = 0; i < T; i++) {
    for (const who of ['a', 'b']) G.addOrUpdatePlayer(s, { playerId: `p${i}${who}`, name: `P${i}${who}`, teamId: `t${i}` });
    const k = counts ? counts[i] : R;
    for (let j = 0; j < k; j++) {
      const r = G.addUpload(s, { uploadId: `u${n++}`, playerId: `p${i}a`, lat: 10.1234567 + n * 1.3719, lng: 20.7654321 + n * 0.5137, source: 'exif' });
      assert.ok(r.ok, JSON.stringify(r));
    }
  }
  return s;
}

const teamSeq = (s) => s.order.map((id) => s.uploads.find((u) => u.id === id).teamId);

test('createGame clamps config and names teams', () => {
  const s = G.createGame({ code: 'AAAA', teamCount: 99, photosPerTeam: 0, timerSec: 45, teamNames: ['  red  ', 'red'] });
  assert.equal(s.config.teamCount, 8);
  assert.equal(s.config.photosPerTeam, 1);
  assert.equal(s.config.timerSec, 45, 'custom seconds are kept');
  assert.equal(s.teams[0].name, 'RED');
  assert.equal(s.teams[1].name, 'RED 2');
  assert.equal(s.teams[2].name, 'BEAVERS');
  assert.equal(s.phase, PHASE.LOBBY);
});

test('createGame timer: 0 = off, custom rounded and clamped, junk -> default', () => {
  const t = (timerSec) => G.createGame({ code: 'AAAA', timerSec }).config.timerSec;
  assert.equal(t(45), 45);
  assert.equal(t(30), 30);
  assert.equal(t(5), 10);
  assert.equal(t(9999), 600);
  assert.equal(t(0), 0);
  assert.equal(t(44.6), 45);
  assert.equal(t('90'), 90);
  assert.equal(t('abc'), 60);
  assert.equal(t(null), 60);
  assert.equal(t(undefined), 60);
  assert.equal(t(NaN), 60);
});

test('uploads: cap per team, lobby only, owner-only delete, team switch withdraws', () => {
  const s = lobby({ T: 2, R: 2 });
  assert.equal(G.addUpload(s, { uploadId: 'x', playerId: 'p0a', lat: 1, lng: 1 }).error, ERR.TEAM_FULL);
  assert.equal(G.addUpload(s, { uploadId: 'y', playerId: 'nobody', lat: 1, lng: 1 }).error, ERR.UNKNOWN);
  assert.equal(G.removeUpload(s, 'p0b', 'u0').error, ERR.UNKNOWN);
  assert.ok(G.removeUpload(s, 'p0a', 'u0').ok);
  assert.ok(G.addUpload(s, { uploadId: 'x', playerId: 'p0b', lat: 1, lng: 1, source: 'manual' }).ok);
  assert.ok(G.addUpload(s, { uploadId: 'x', playerId: 'p0b', lat: 1, lng: 1 }).duplicate, 'retry is idempotent');
  assert.equal(G.addUpload(s, { uploadId: 'bad', playerId: 'p1a', lat: 99, lng: 1 }).error, ERR.UNKNOWN);
  const r = G.addOrUpdatePlayer(s, { playerId: 'p1a', teamId: 't0' });
  assert.deepEqual(r.removedUploadIds.sort(), ['u2', 'u3'].sort());
  assert.equal(G.uploadsByTeam(s).t1, 0);
});

test('canStart / canStartTrim', () => {
  const full = lobby({ T: 3, R: 2 });
  assert.ok(G.canStart(full));
  const partial = lobby({ T: 3, R: 3, counts: [3, 1, 2] });
  assert.ok(!G.canStart(partial));
  assert.ok(G.canStartTrim(partial));
  assert.equal(G.trimTarget(partial), 1);
  const empty = lobby({ T: 3, R: 3, counts: [3, 0, 2] });
  assert.ok(!G.canStartTrim(empty));
  assert.equal(G.startGame(empty, { trim: true, now: 0 }).error, ERR.UNKNOWN);
  assert.equal(G.startGame(partial, { now: 0 }).error, ERR.UNKNOWN);
});

test('orderRounds: never back-to-back when possible (property test)', () => {
  let cases = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const rng = seeded(seed);
    const T = 2 + Math.floor(rng() * 7);
    const R = 1 + Math.floor(rng() * 10);
    const ups = [];
    for (let t = 0; t < T; t++) for (let r = 0; r < R; r++) ups.push({ id: `${t}-${r}`, teamId: `t${t}` });
    const out = G.orderRounds(ups, rng);
    assert.equal(out.length, ups.length);
    assert.equal(new Set(out.map((u) => u.id)).size, ups.length, 'permutation');
    for (let i = 1; i < out.length; i++) {
      assert.notEqual(out[i].teamId, out[i - 1].teamId, `seed ${seed} T${T} R${R} idx ${i}`);
    }
    cases++;
  }
  assert.equal(cases, 400);
});

test('orderRounds: uneven counts are still adjacent-free whenever mathematically possible', () => {
  for (let seed = 1; seed <= 600; seed++) {
    const rng = seeded(seed * 7919);
    const T = 2 + Math.floor(rng() * 5);
    const counts = Array.from({ length: T }, () => Math.floor(rng() * 6));
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) continue;
    const ups = [];
    counts.forEach((c, t) => { for (let r = 0; r < c; r++) ups.push({ id: `${t}-${r}`, teamId: `t${t}` }); });
    const out = G.orderRounds(ups, rng);
    assert.equal(out.length, n);
    const adj = out.filter((u, i) => i && u.teamId === out[i - 1].teamId).length;
    if (Math.max(...counts) <= Math.ceil(n / 2)) assert.equal(adj, 0, `seed ${seed} counts ${counts}`);
  }
});

test('orderRounds: impossible input degrades gracefully (greedy, minimal repeats)', () => {
  const ups = [];
  for (let i = 0; i < 5; i++) ups.push({ id: `a${i}`, teamId: 'A' });
  ups.push({ id: 'b0', teamId: 'B' });
  const out = G.orderRounds(ups, seeded(3));
  assert.equal(out.length, 6);
  assert.equal(new Set(out.map((u) => u.id)).size, 6);
  const adj = out.filter((u, i) => i && u.teamId === out[i - 1].teamId).length;
  assert.equal(adj, 3, 'best possible for 5xA + 1xB is 3 repeats');
  assert.deepEqual(G.orderRounds([], seeded(1)), []);
  assert.equal(G.orderRounds([{ id: 'x', teamId: 'A' }], seeded(1)).length, 1);
});

test('orderRounds actually varies with the seed', () => {
  const ups = [];
  for (let t = 0; t < 4; t++) for (let r = 0; r < 3; r++) ups.push({ id: `${t}-${r}`, teamId: `t${t}` });
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) seen.add(G.orderRounds(ups, seeded(seed)).map((u) => u.id).join());
  assert.ok(seen.size > 20, `only ${seen.size} distinct orders`);
});

test('startGame builds order, no repeats, and every team guesses (T-1)*R rounds', () => {
  for (const [T, R] of [[2, 1], [2, 4], [3, 3], [5, 2], [8, 3], [4, 10]]) {
    const s = lobby({ T, R });
    const r = G.startGame(s, { rng: seeded(T * 100 + R), now: 1000 });
    assert.ok(r.ok);
    assert.equal(s.phase, PHASE.ROUND);
    assert.equal(s.order.length, T * R);
    const seq = teamSeq(s);
    seq.forEach((t, i) => i && assert.notEqual(t, seq[i - 1]));
    const sat = {};
    while (s.phase !== PHASE.FINAL) {
      assert.equal(s.phase, PHASE.ROUND);
      const cur = G.currentUpload(s);
      sat[cur.teamId] = (sat[cur.teamId] || 0) + 1;
      G.endRound(s, { now: 2000 });
      G.nextRound(s, { now: 3000 });
    }
    for (const sc of G.computeScores(s)) assert.equal(sc.played, (T - 1) * R, `T${T} R${R}`);
    for (const t of s.teams) assert.equal(sat[t.id], R, 'each team sits out exactly R rounds');
  }
});

test('timer: deadline set from timerSec, null when off; remainingMs in toPublic', () => {
  const s = lobby({ T: 2, R: 1, timerSec: 30 });
  G.startGame(s, { now: 10_000, rng: seeded(1) });
  assert.equal(s.deadline, 40_000);
  assert.equal(G.toPublic(s, { now: 25_000 }).round.remainingMs, 15_000);
  assert.equal(G.toPublic(s, { now: 99_000 }).round.remainingMs, 0);
  G.restartTimer(s, { now: 50_000 });
  assert.equal(s.deadline, 80_000);
  const off = lobby({ T: 2, R: 1, timerSec: 0 });
  G.startGame(off, { now: 10_000, rng: seeded(1) });
  assert.equal(off.deadline, null);
  assert.equal(G.toPublic(off, { now: 20_000 }).round.remainingMs, null);
});

function started(opts = {}) {
  const s = lobby({ T: 3, R: 1, ...opts });
  G.startGame(s, { rng: seeded(5), now: 0 });
  return s;
}
const playersOfNot = (s, teamId) => s.players.filter((p) => p.teamId !== teamId);

test('submitGuess: first lock per team wins; sitting out rejected; bad round rejected', () => {
  const s = started();
  const cur = G.currentUpload(s);
  const sitter = s.players.find((p) => p.teamId === cur.teamId);
  const others = playersOfNot(s, cur.teamId);
  const g1 = others[0], g2 = others.find((p) => p.teamId !== g1.teamId);
  const other = s.players.find((p) => p.teamId === g1.teamId && p.id !== g1.id);

  assert.equal(G.submitGuess(s, { playerId: sitter.id, roundIndex: 0, lat: 0, lng: 0, now: 1 }).error, ERR.SITTING_OUT);
  assert.equal(G.submitGuess(s, { playerId: g1.id, roundIndex: 5, lat: 0, lng: 0, now: 1 }).error, ERR.BAD_ROUND);
  assert.equal(G.submitGuess(s, { playerId: 'ghost', roundIndex: 0, lat: 0, lng: 0, now: 1 }).error, ERR.UNKNOWN);
  assert.equal(G.submitGuess(s, { playerId: g1.id, roundIndex: 0, lat: 123, lng: 0, now: 1 }).error, ERR.UNKNOWN);
  assert.ok(G.submitGuess(s, { playerId: g1.id, roundIndex: 0, lat: 1, lng: 2, now: 1 }).ok);
  assert.equal(G.submitGuess(s, { playerId: other.id, roundIndex: 0, lat: 50, lng: 50, now: 2 }).error, ERR.ALREADY_LOCKED);
  assert.equal(s.locks[g1.teamId].lat, 1);
  assert.equal(s.locks[g1.teamId].name, g1.name);
  assert.ok(!G.allLocked(s));
  assert.ok(G.submitGuess(s, { playerId: g2.id, roundIndex: 0, lat: 3, lng: 4, now: 3 }).ok);
  assert.ok(G.allLocked(s));
  assert.equal(G.toPublic(s, { now: 5 }).round.locked[g1.teamId], g1.name);
});

test('scoring: haversine distances, penalty for missing pin, totals and sort', () => {
  const s = started();
  const cur = G.currentUpload(s);
  const [g1] = playersOfNot(s, cur.teamId);
  const target = { lat: cur.lat, lng: cur.lng };
  const guess = { lat: target.lat + 1, lng: target.lng };
  G.submitGuess(s, { playerId: g1.id, roundIndex: 0, ...guess, now: 1 });
  assert.ok(G.endRound(s, { now: 2 }).ok);
  assert.equal(s.phase, PHASE.REVEAL);
  const pub = G.toPublic(s, { now: 3 });
  assert.deepEqual(pub.reveal.target, target);
  assert.equal(pub.reveal.guesses.length, 2);
  const [best, worst] = pub.reveal.guesses;
  assert.equal(best.teamId, g1.teamId);
  assert.ok(Math.abs(best.km - haversineKm(guess, target)) < 1e-9);
  assert.ok(Math.abs(best.km - 111.2) < 0.5);
  assert.equal(best.lockedBy, g1.name);
  assert.equal(worst.penalty, true);
  assert.equal(worst.km, PENALTY_KM);
  assert.equal(worst.lat, null);
  const byTeam = Object.fromEntries(pub.scores.map((x) => [x.teamId, x]));
  assert.equal(byTeam[worst.teamId].totalKm, PENALTY_KM);
  assert.equal(byTeam[cur.teamId].totalKm, 0);
  assert.equal(byTeam[cur.teamId].played, 0);
  assert.equal(pub.scores[0].teamId, cur.teamId, 'ascending: the sitter has 0 so far');
  assert.equal(pub.scores[2].teamId, worst.teamId);
  // can't end twice / guess after reveal
  assert.equal(G.endRound(s, { now: 4 }).error, ERR.BAD_ROUND);
  assert.equal(G.submitGuess(s, { playerId: g1.id, roundIndex: 0, lat: 0, lng: 0, now: 5 }).error, ERR.BAD_ROUND);
});

test('full game: totals sum, final phase, awards', () => {
  const s = lobby({ T: 2, R: 2 });
  G.startGame(s, { rng: seeded(9), now: 0 });
  const expected = { t0: 0, t1: 0 };
  let best = null;
  let r = 0;
  while (s.phase === PHASE.ROUND) {
    const cur = G.currentUpload(s);
    const guesser = s.players.find((p) => p.teamId !== cur.teamId);
    if (r === 2) { /* nobody pins this round: penalty */ expected[guesser.teamId] += PENALTY_KM; } else {
      const g = { lat: cur.lat + (r + 1) * 0.1, lng: cur.lng };
      G.submitGuess(s, { playerId: guesser.id, roundIndex: s.roundIndex, ...g, now: 1 });
      const km = haversineKm(g, cur);
      expected[guesser.teamId] += km;
      if (!best || km < best.km) best = { km, teamId: guesser.teamId, roundIndex: s.roundIndex };
    }
    G.endRound(s, { now: 2 });
    const n = G.nextRound(s, { now: 3 });
    assert.equal(!!n.final, s.phase === PHASE.FINAL);
    r++;
  }
  assert.equal(s.phase, PHASE.FINAL);
  assert.equal(r, 4);
  const pub = G.toPublic(s, { now: 9 });
  assert.equal(pub.phase, PHASE.FINAL);
  assert.equal(pub.history.length, 4);
  assert.ok(pub.reveal, 'last reveal kept for FINAL');
  assert.equal(pub.round, null);
  for (const sc of pub.scores) assert.ok(Math.abs(sc.totalKm - expected[sc.teamId]) < 1e-6);
  assert.ok(pub.scores[0].totalKm <= pub.scores[1].totalKm);
  const aw = G.awards(s);
  assert.equal(aw.closest.teamId, best.teamId);
  assert.ok(Math.abs(aw.closest.km - best.km) < 1e-9);
  assert.equal(aw.closest.roundIndex, best.roundIndex);
  for (const sc of pub.scores) assert.ok(Math.abs(aw.averages[sc.teamId] - sc.totalKm / 2) < 1e-6);
  assert.equal(G.nextRound(s, { now: 1 }).error, ERR.BAD_ROUND);
});

test('awards: null closest when every guess was a penalty', () => {
  const s = started();
  G.endRound(s, { now: 1 });
  assert.equal(G.awards(s).closest, null);
});

test('trim start keeps min count per team, returns dropped, stays fair', () => {
  const s = lobby({ T: 3, R: 4, counts: [4, 2, 3] });
  const all = s.uploads.map((u) => u.id);
  const r = G.startGame(s, { trim: true, rng: seeded(11), now: 0 });
  assert.ok(r.ok);
  assert.equal(r.dropped.length, 9 - 6);
  assert.equal(s.order.length, 6);
  const per = {};
  for (const t of teamSeq(s)) per[t] = (per[t] || 0) + 1;
  assert.deepEqual(per, { t0: 2, t1: 2, t2: 2 });
  for (const id of r.dropped) assert.ok(all.includes(id) && !s.order.includes(id));
  const seq = teamSeq(s);
  seq.forEach((t, i) => i && assert.notEqual(t, seq[i - 1]));
  while (s.phase !== PHASE.FINAL) { G.endRound(s, { now: 1 }); G.nextRound(s, { now: 2 }); }
  for (const sc of G.computeScores(s)) assert.equal(sc.played, 4);
});

test('toPublic never leaks target coordinates before reveal', () => {
  const s = lobby({ T: 3, R: 2 });
  const lobbyJson = JSON.stringify(G.toPublic(s, { now: 0 }));
  assert.ok(!/"lat"|"lng"/.test(lobbyJson), 'no coordinates in lobby');
  G.startGame(s, { rng: seeded(2), now: 0 });
  while (s.phase !== PHASE.FINAL) {
    const cur = G.currentUpload(s);
    if (s.phase === PHASE.ROUND) {
      const pub = G.toPublic(s, { now: 1 });
      const json = JSON.stringify(pub);
      assert.ok(!pub.reveal || pub.reveal.roundIndex !== s.roundIndex, 'current round not revealed');
      assert.ok(!json.includes(String(cur.lat)) && !json.includes(String(cur.lng)), 'target leaked in ROUND');
      for (const u of s.uploads.filter((u) => !s.history.some((h) => h.uploadId === u.id))) {
        assert.ok(!json.includes(String(u.lat)), 'future target leaked');
      }
      assert.ok(!('lat' in pub.uploads[0]));
      G.endRound(s, { now: 2 });
    } else {
      const pub = G.toPublic(s, { now: 3 });
      assert.deepEqual(pub.reveal.target, { lat: cur.lat, lng: cur.lng });
      G.nextRound(s, { now: 4 });
    }
  }
});

test('youFor lists only your own uploads', () => {
  const s = lobby({ T: 2, R: 2 });
  assert.deepEqual(G.youFor(s, 'p0a').myUploadIds, ['u0', 'u1']);
  assert.deepEqual(G.youFor(s, 'p0b').myUploadIds, []);
  assert.equal(G.youFor(s, 'p1a').teamId, 't1');
  assert.deepEqual(G.youFor(s, 'ghost'), { playerId: 'ghost', name: '', teamId: null, myUploadIds: [] });
});

test('player connect flags, late joiner may pick a team mid-game but not switch', () => {
  const s = lobby({ T: 2, R: 1 });
  assert.ok(G.setPlayerConnected(s, 'p0a', false));
  assert.ok(!G.setPlayerConnected(s, 'p0a', false));
  assert.equal(G.toPublic(s, { now: 0 }).players.find((p) => p.id === 'p0a').connected, false);
  G.resetConnections(s);
  assert.ok(s.players.every((p) => !p.connected));
  G.startGame(s, { rng: seeded(1), now: 0 });
  G.addOrUpdatePlayer(s, { playerId: 'late', name: 'Late' });
  assert.equal(s.players.find((p) => p.id === 'late').teamId, null);
  G.addOrUpdatePlayer(s, { playerId: 'late', teamId: 't1' });
  assert.equal(s.players.find((p) => p.id === 'late').teamId, 't1');
  G.addOrUpdatePlayer(s, { playerId: 'late', teamId: 't0' });
  assert.equal(s.players.find((p) => p.id === 'late').teamId, 't1', 'no switching mid-game');
  assert.equal(G.addUpload(s, { uploadId: 'zz', playerId: 'late', lat: 1, lng: 1 }).error, ERR.NOT_IN_LOBBY);
});

test('playAgain keeps teams and players, wipes uploads and scores', () => {
  const s = lobby({ T: 2, R: 1 });
  G.startGame(s, { rng: seeded(4), now: 0 });
  while (s.phase !== PHASE.FINAL) { G.endRound(s, { now: 1 }); G.nextRound(s, { now: 2 }); }
  const players = s.players.map((p) => ({ ...p }));
  const r = G.playAgain(s);
  assert.equal(r.removedUploadIds.length, 2);
  assert.equal(s.phase, PHASE.LOBBY);
  assert.equal(s.code, 'KQZP');
  assert.deepEqual(s.players, players);
  assert.equal(s.uploads.length, 0);
  assert.equal(s.history.length, 0);
  assert.ok(G.computeScores(s).every((x) => x.totalKm === 0 && x.played === 0));
  assert.equal(G.toPublic(s, { now: 0 }).reveal, null);
  assert.ok(!G.canStart(s));
  // a second game works
  for (const t of ['t0', 't1']) assert.ok(G.addUpload(s, { uploadId: `n${t}`, playerId: `p${t.slice(1)}a`, lat: 5, lng: 6 }).ok);
  assert.ok(G.canStart(s));
  assert.ok(G.startGame(s, { rng: seeded(8), now: 5 }).ok);
});

test('state survives a JSON round trip (persistence)', () => {
  const s = started();
  const copy = JSON.parse(JSON.stringify(s));
  assert.deepEqual(G.toPublic(copy, { now: 1 }), G.toPublic(s, { now: 1 }));
});
