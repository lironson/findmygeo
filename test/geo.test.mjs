import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, greatCirclePoints, formatKm, fitLngs, PENALTY_KM } from '../js/geo.js';

const LONDON = { lat: 51.5074, lng: -0.1278 };
const PARIS = { lat: 48.8566, lng: 2.3522 };
const VANCOUVER = { lat: 49.2827, lng: -123.1207 };
const TOKYO = { lat: 35.6586, lng: 139.7454 };

describe('haversineKm', () => {
  test('London to Paris is about 343.5 km', () => {
    assert.ok(Math.abs(haversineKm(LONDON, PARIS) - 343.5) <= 1);
  });

  test('same point is 0', () => {
    assert.equal(haversineKm(PARIS, PARIS), 0);
  });

  test('antipodes are about half the circumference (20015 km)', () => {
    const d = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    assert.ok(Math.abs(d - 20015) <= 5, `got ${d}`);
    const d2 = haversineKm({ lat: 45, lng: 10 }, { lat: -45, lng: -170 });
    assert.ok(Math.abs(d2 - 20015) <= 5, `got ${d2}`);
  });

  test('Vancouver to Tokyo is about 7560 km (within 1%)', () => {
    const d = haversineKm(VANCOUVER, TOKYO);
    assert.ok(Math.abs(d - 7560) <= 7560 * 0.01, `got ${d}`);
  });

  test('is symmetric', () => {
    assert.equal(haversineKm(LONDON, TOKYO), haversineKm(TOKYO, LONDON));
    assert.equal(haversineKm(VANCOUVER, PARIS), haversineKm(PARIS, VANCOUVER));
  });

  test('returns a finite non-negative number', () => {
    const d = haversineKm(VANCOUVER, { lat: -33.8568, lng: 151.2153 });
    assert.ok(Number.isFinite(d) && d >= 0);
  });
});

// Longitudes may be unwrapped (e.g. -220.25 for 139.75), so compare modulo 360.
const sameLng = (x, y) => Math.abs((((x - y) % 360) + 540) % 360 - 180) < 1e-9;

describe('greatCirclePoints', () => {
  test('returns n+1 points, endpoints equal the inputs', () => {
    const pts = greatCirclePoints(VANCOUVER, TOKYO, 64);
    assert.equal(pts.length, 65);
    assert.ok(Math.abs(pts[0][0] - VANCOUVER.lat) < 1e-9);
    assert.ok(sameLng(pts[0][1], VANCOUVER.lng));
    assert.ok(Math.abs(pts[64][0] - TOKYO.lat) < 1e-9);
    assert.ok(sameLng(pts[64][1], TOKYO.lng));
  });

  test('default n is 64', () => {
    assert.equal(greatCirclePoints(LONDON, PARIS).length, 65);
  });

  test('honours a custom n', () => {
    assert.equal(greatCirclePoints(LONDON, PARIS, 10).length, 11);
  });

  test('Vancouver to Tokyo: no longitude jump of 180 or more between neighbours (antimeridian unwrapped)', () => {
    const pts = greatCirclePoints(VANCOUVER, TOKYO, 64);
    for (let i = 1; i < pts.length; i++) {
      const jump = Math.abs(pts[i][1] - pts[i - 1][1]);
      assert.ok(jump < 180, `lng jump ${jump} between ${i - 1} and ${i}`);
    }
  });

  test('every point is a [lat, lng] pair of finite numbers', () => {
    for (const [lat, lng] of greatCirclePoints(VANCOUVER, TOKYO)) {
      assert.ok(Number.isFinite(lat) && Number.isFinite(lng));
    }
  });
});

describe('formatKm', () => {
  test('under 10 km gets one decimal', () => {
    assert.equal(formatKm(0.42), '0.4');
  });

  test('between 10 and 1000 keeps one decimal', () => {
    assert.equal(formatKm(12.3), '12.3');
  });

  test('thousands get an integer with a thousands separator', () => {
    assert.equal(formatKm(1204.4), '1,204');
  });

  test('penalty-sized numbers use a thousands separator', () => {
    assert.equal(formatKm(PENALTY_KM), '20,000');
  });
});

describe('fitLngs', () => {
  const SYDNEY = { lat: -33.8568, lng: 151.2153 };
  const span = (pts) => Math.max(...pts.map((p) => p.lng)) - Math.min(...pts.map((p) => p.lng));

  test('Vancouver, Tokyo and Sydney end up on one side of the Pacific (span < 180)', () => {
    const out = fitLngs([VANCOUVER, TOKYO, SYDNEY]);
    assert.equal(out.length, 3);
    assert.ok(span(out) < 180, `span ${span(out)}`);
    assert.ok(span([VANCOUVER, TOKYO, SYDNEY]) > 180);
  });

  test('London and Paris come back unchanged', () => {
    assert.deepEqual(fitLngs([LONDON, PARIS]), [LONDON, PARIS]);
  });

  test('a single point is unchanged, the empty array gives []', () => {
    assert.deepEqual(fitLngs([TOKYO]), [TOKYO]);
    assert.deepEqual(fitLngs([]), []);
  });

  test('order and lat are kept, and every lng is congruent to its input mod 360', () => {
    const input = [VANCOUVER, TOKYO, SYDNEY, LONDON];
    const out = fitLngs(input);
    assert.equal(out.length, input.length);
    out.forEach((p, i) => {
      assert.equal(p.lat, input[i].lat);
      assert.ok(sameLng(p.lng, input[i].lng), `${p.lng} vs ${input[i].lng}`);
    });
  });

  test('does not mutate the input', () => {
    const input = [{ ...VANCOUVER }, { ...TOKYO }];
    fitLngs(input);
    assert.equal(input[1].lng, TOKYO.lng);
  });
});

describe('PENALTY_KM', () => {
  test('is 20000', () => {
    assert.equal(PENALTY_KM, 20000);
  });
});
