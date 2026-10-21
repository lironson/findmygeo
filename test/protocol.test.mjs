import test from 'node:test';
import assert from 'node:assert/strict';
import { ANIMAL_NAMES, pickTeamNames, MAX_TEAMS, MIN_TEAMS } from '../js/protocol.js';

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

test('ANIMAL_NAMES: unique, uppercase, fit a team-name input', () => {
  assert.equal(new Set(ANIMAL_NAMES).size, ANIMAL_NAMES.length);
  for (const n of ANIMAL_NAMES) {
    assert.ok(n.length >= 1 && n.length <= 12, n);
    assert.equal(n, n.toUpperCase());
  }
  assert.ok(new Set(ANIMAL_NAMES.map((n) => n[0])).size >= 24, 'spans most of the alphabet');
});

test('pickTeamNames: n distinct names, all <= 12 chars', () => {
  for (let n = 0; n <= 30; n++) {
    const out = pickTeamNames(n, seeded(n + 1));
    assert.equal(out.length, n);
    assert.equal(new Set(out).size, n);
    for (const nm of out) assert.ok(ANIMAL_NAMES.includes(nm) && nm.length <= 12, nm);
  }
});

test('pickTeamNames: distinct first letters for 2..8 teams, many seeds', () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (let n = MIN_TEAMS; n <= MAX_TEAMS; n++) {
      const out = pickTeamNames(n, seeded(seed));
      assert.equal(new Set(out.map((x) => x[0])).size, n, out.join());
    }
  }
});

test('pickTeamNames: more teams than letters repeats initials, never names', () => {
  const letters = new Set(ANIMAL_NAMES.map((n) => n[0])).size;
  const out = pickTeamNames(letters + 3, seeded(7));
  assert.equal(new Set(out).size, letters + 3);
  assert.equal(new Set(out.map((x) => x[0])).size, letters);
});

test('pickTeamNames: different seeds give different sets; same seed repeats', () => {
  const sets = new Set();
  for (let seed = 1; seed <= 20; seed++) sets.add(pickTeamNames(4, seeded(seed)).join());
  assert.ok(sets.size >= 15, `only ${sets.size} distinct sets`);
  assert.deepEqual(pickTeamNames(5, seeded(42)), pickTeamNames(5, seeded(42)));
});

test('pickTeamNames: avoid list is never repeated and its initials come last', () => {
  const avoid = ['moose', 'KOALAS'];
  for (let seed = 1; seed <= 50; seed++) {
    const out = pickTeamNames(6, seeded(seed), avoid);
    assert.ok(!out.includes('MOOSE') && !out.includes('KOALAS'));
    assert.ok(out.every((x) => x[0] !== 'M' && x[0] !== 'K'), out.join());
    assert.equal(new Set(out.map((x) => x[0])).size, 6);
  }
});
