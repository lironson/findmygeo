// End-to-end: plays a full findmygeo game in real Chromium (1 host TV + 4 phones over WebRTC).
//
// HOW TO RUN
//   1. Static server for the project root:      python3 -m http.server 8123         (from the repo root)
//   2. Local PeerJS signalling server:          npx peer --port 9000                (add `--host 127.0.0.1` if IPv6 is off)
//   3. Playwright (any scratch dir):            npm i playwright@1  &&  npx playwright install chromium
//   4. node e2e/play.spec.mjs                   (resolve `playwright` via NODE_PATH=<scratch>/node_modules if needed;
//                                                ESM ignores NODE_PATH, so run it from a dir that has node_modules/playwright,
//                                                or symlink node_modules next to this file)
//
// ENV (all optional)
//   E2E_BASE     http://localhost:8123            where the static site lives
//   E2E_PEER     peerHost=localhost&peerPort=9000&peerPath=/&peerSecure=0   signalling server query string
//   E2E_SHOTS    <repo>/.screens/e2e              screenshot output dir
//   E2E_CHROMIUM path to a chromium binary        (otherwise Playwright's own)
//   E2E_PROXY    http://127.0.0.1:3128            HTTPS proxy for the CDN scripts / map tiles (defaults to $HTTPS_PROXY)
//   E2E_HEADED=1 show the browsers
//   E2E_VERBOSE=1 echo every console warning/error from every page
//
// Exits 0 when every assertion passes, 1 otherwise. Screenshots (light + dark for every step) land in E2E_SHOTS.
// The game uses a 30 s custom timer and one round is left to expire on purpose, so a run takes about two minutes.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ANIMAL_NAMES, DEFAULT_TEAM_NAMES } from '../js/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'fixtures');
const BASE = process.env.E2E_BASE || 'http://localhost:8123';
const PEER = process.env.E2E_PEER || 'peerHost=localhost&peerPort=9000&peerPath=/&peerSecure=0';
const SHOTS = process.env.E2E_SHOTS || path.join(ROOT, '.screens', 'e2e');
const PROXY = process.env.E2E_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ tiny assertion harness
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
const log = (...a) => console.log('   ·', ...a);

// ------------------------------------------------------------------ browser + pages
const args = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
if (PROXY) args.push(`--proxy-server=${PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1');
const browser = await chromium.launch({
  headless: !process.env.E2E_HEADED,
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args,
});

const consoleProblems = [];
function watch(page, who) {
  page.on('console', (m) => {
    if (process.env.E2E_VERBOSE && /error|warning/.test(m.type())) console.log(`   [${who}] ${m.type()}: ${m.text()}`);
    if (m.type() !== 'error') return;
    const t = m.text();
    const loc = m.location()?.url || '';
    // map tiles / fonts / favicon from third parties are not ours to fix
    if (/arcgisonline|gstatic|googleapis|favicon/.test(loc + t)) return;
    consoleProblems.push(`[${who}] console.error: ${t} (${loc})`);
  });
  page.on('pageerror', (e) => consoleProblems.push(`[${who}] pageerror: ${e.message}`));
}

async function newPage(who, mobile) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true }
    : { viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.who = who;
  watch(page, who);
  return page;
}

// ------------------------------------------------------------------ helpers
async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('fmg-theme', t); } catch (e) {}
    window.dispatchEvent(new CustomEvent('fmg-theme', { detail: t }));
  }, theme);
}
async function settle(page, extra = 0) {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-tile')].every((t) => t.complete), null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready);
  if (extra) await page.waitForTimeout(extra);
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    bw: document.body.scrollWidth,
  }));
  check(`no horizontal scroll on ${label}`, o.sw <= o.cw + 1 && o.bw <= o.cw + 1, `scrollWidth ${o.sw} / ${o.cw}`);
}
// screenshot in light + dark, leave the page light
async function shoot(page, name, { extra = 0, scrollCheck = false } = {}) {
  for (const th of ['light', 'dark']) {
    await setTheme(page, th);
    await settle(page, extra);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${th}.png`) });
    if (scrollCheck && th === 'light') await noHScroll(page, `${page.who} @ ${name}`);
  }
  await setTheme(page, 'light');
  await settle(page);
}
const kmNum = (txt) => {
  const m = String(txt).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
function haversine(a, b) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dp = (b.lat - a.lat) * rad;
  let dl = (b.lng - a.lng) * rad;
  dl = Math.atan2(Math.sin(dl), Math.cos(dl));
  const s = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const savedGame = (page) => page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('findmygeo');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const g = r.result.transaction('game').objectStore('game').get('current');
    g.onsuccess = () => res(g.result);
    g.onerror = () => rej(g.error);
  };
}));
const photoLoaded = (page) => page.waitForFunction(() => {
  const i = document.querySelector('.photo-well img');
  return i && i.complete && i.naturalWidth > 0;
});
const online4 = (page, timeout = 40000) => page.waitForFunction(
  () => /4\s*\/\s*4/.test(document.querySelector('header.masthead').textContent), null, { timeout });

// phone helpers --------------------------------------------------------------------------
const lockBtn = (p) => p.getByRole('button', { name: /^(lock it in|locked)$/i });
async function phoneMode(page, timeout = 20000) {
  // resolves 'guess' | 'out' once the round screen is up
  const h = await page.waitForFunction(() => {
    const t = document.body.textContent;
    if (/LOCK IT IN|LOCKED|Locking/.test(t) && document.querySelector('.leaflet-container')) return 'guess';
    if (/Your team's photo\./.test(t) && /The others are guessing/.test(t)) return 'out';
    return false;
  }, null, { timeout });
  return h.jsonValue();
}
async function pinOnMap(page, fx, fy) {
  const map = page.locator('.map.fmg-picker').last();
  await map.waitFor();
  await page.waitForTimeout(300);
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

// ================================================================================== the game
const NAMES = ['Ana', 'Ben', 'Cat', 'Dev'];
const TEAMS = ['MOOSE', 'LOONS', 'BEAVERS'];
const TEAM_OF = { Ana: 'MOOSE', Ben: 'LOONS', Cat: 'BEAVERS', Dev: 'MOOSE' };   // team 1,2,3,1
const LOCKER = { MOOSE: 'Ana', LOONS: 'Ben', BEAVERS: 'Cat' };
const PIN_AT = { MOOSE: [0.25, 0.45], LOONS: [0.55, 0.4], BEAVERS: [0.8, 0.6] }; // distinct spots per team

const host = await newPage('host', false);
const ph = {};
for (const n of NAMES) ph[n] = await newPage(n, true);

try {
  // ---------------------------------------------------------------- host setup
  await host.goto(`${BASE}/?${PEER}`);
  await host.getByRole('button', { name: /open the room/i }).waitFor();
  // random animal names: initial placeholders come from ANIMAL_NAMES, one initial per team
  const rolled = await host.locator('input[aria-label^="Team "]').evaluateAll((els) => els.map((e) => e.placeholder));
  const stickers = await host.locator('.sticker.lg').allTextContents();
  check('setup rolls random animal team names', rolled.length === 4 && rolled.every((n) => ANIMAL_NAMES.includes(n)) && rolled.join() !== DEFAULT_TEAM_NAMES.slice(0, 4).join(), rolled.join());
  check('setup stickers show distinct initials', new Set(stickers).size === 4 && stickers.join() === rolled.map((n) => n[0]).join(), stickers.join(''));
  const before = await host.locator('input[aria-label="Team 1 name"]').inputValue();
  await host.getByRole('button', { name: /shuffle names/i }).click();
  const after = await host.locator('input[aria-label^="Team "]').evaluateAll((els) => els.map((e) => e.value));
  check('SHUFFLE NAMES re-rolls the untouched names', after.length === 4 && new Set(after).size === 4 && after.every((n) => ANIMAL_NAMES.includes(n)), `${before} -> ${after.join()}`);
  await shoot(host, 'host-setup-random');
  // the game below expects MOOSE / LOONS / BEAVERS: type them in (typed names survive a shuffle)
  for (const [i, nm] of TEAMS.entries()) {
    const inp = host.locator(`input[aria-label="Team ${i + 1} name"]`);
    await inp.clear();
    await inp.fill(nm);
  }
  await host.getByRole('button', { name: /shuffle names/i }).click();
  const typed = await host.locator('input[aria-label^="Team "]').evaluateAll((els) => els.slice(0, 3).map((e) => e.value));
  check('SHUFFLE NAMES leaves typed names alone', typed.join() === TEAMS.join(), typed.join());
  // 3 teams, 1 photo, 30s via CUSTOM
  await host.getByLabel('Fewer teams').click();
  await host.getByLabel('Fewer photos').click();
  await host.getByLabel('Fewer photos').click();
  const customField = host.locator('input[aria-label="Custom timer in seconds"]');
  check('custom timer field is hidden for presets', !(await customField.isVisible()));
  await host.locator('.seg button[data-sec="custom"]').click();
  check('custom timer field shows after clicking CUSTOM', await customField.isVisible());
  check('CUSTOM is pressed and presets are not', (await host.locator('.seg button[aria-pressed="true"]').allTextContents()).join() === 'CUSTOM');
  await customField.fill('5');
  await customField.blur();
  check('custom timer clamps up to 10 on blur', (await customField.inputValue()) === '10');
  await customField.fill('30');
  await customField.blur();
  check('custom timer previews as 0:30', /=\s*0:30/.test(await host.locator('.seg').locator('xpath=..').textContent()));
  await shoot(host, 'host-setup-custom');
  await host.locator('.seg button[data-sec="60"]').click();
  check('picking a preset hides the custom field', !(await customField.isVisible()));
  await host.locator('.seg button[data-sec="custom"]').click();
  check('CUSTOM remembers the last custom value', (await customField.inputValue()) === '30');
  await shoot(host, 'host-setup');
  await host.getByRole('button', { name: /open the room/i }).click();

  await host.locator('header.masthead .label .num').first().waitFor();
  const code = (await host.locator('header.masthead .label .num').first().textContent()).trim();
  check('host opens a 4-letter room', /^[A-Z]{4}$/.test(code), code);
  check('host lobby shows a QR code', (await host.locator('.qr svg, .qr img').count()) > 0);
  const shownUrl = await host.locator('div.num.muted').first().textContent();
  check('join URL passes peer* params through', shownUrl.includes(`join=${code}`) && shownUrl.includes('peerHost=localhost'), shownUrl);

  // ---------------------------------------------------------------- phones join
  const joinUrl = `${BASE}/?join=${code}&${PEER}`;
  for (const n of NAMES) await ph[n].goto(joinUrl);
  for (const n of NAMES) await ph[n].locator('input[aria-label="Your name"]').fill(n);
  for (const n of NAMES) await ph[n].getByRole('button', { name: /let.s go/i }).waitFor();
  await shoot(ph.Ana, 'phone-join', { scrollCheck: true });
  for (const n of NAMES) await ph[n].getByRole('button', { name: /let.s go/i }).click();
  for (const n of NAMES) await ph[n].locator('button.team-chip', { hasText: TEAM_OF[n] }).first().waitFor();
  for (const n of NAMES) await ph[n].locator('button.team-chip', { hasText: TEAM_OF[n] }).first().click();
  for (const n of NAMES) await ph[n].getByText(/Your team:/).waitFor();
  check('all four phones joined their team', true);
  await online4(host);
  check('host shows 4/4 online', true);

  // ---------------------------------------------------------------- uploads
  // Ana: EXIF -> confirm
  await ph.Ana.locator('input[type=file]').setInputFiles(path.join(FIX, 'photo_a_vancouver.jpg'));
  await ph.Ana.getByRole('button', { name: /that.s the spot/i }).waitFor();
  check('Ana (EXIF photo) gets the "Found location" confirm', (await ph.Ana.getByText(/Found location in photo/i).count()) === 1);
  await ph.Ana.waitForTimeout(800);
  await shoot(ph.Ana, 'phone-exif-confirm', { scrollCheck: true });
  await ph.Ana.getByRole('button', { name: /that.s the spot/i }).click();
  await ph.Ana.locator('.thumb').first().waitFor();

  // Ben: no GPS -> manual pin
  await ph.Ben.locator('input[type=file]').setInputFiles(path.join(FIX, 'photo_e_no_gps.jpg'));
  await ph.Ben.getByText(/No location in this photo/i).waitFor();
  const pinBtn = ph.Ben.getByRole('button', { name: /pin it here/i });
  check('Ben (no GPS) cannot confirm before pinning', await pinBtn.isDisabled());
  await ph.Ben.waitForTimeout(500);
  const bmap = ph.Ben.locator('.map.fmg-picker').last();
  await bmap.scrollIntoViewIfNeeded();
  const bb = await bmap.boundingBox();
  await ph.Ben.mouse.click(bb.x + bb.width * 0.62, bb.y + bb.height * 0.42);
  await ph.Ben.waitForFunction(() => !![...document.querySelectorAll('button')].find((b) => /pin it here/i.test(b.textContent) && !b.disabled));
  check('Ben can confirm once the pin is dropped', true);
  await ph.Ben.waitForTimeout(600);
  await shoot(ph.Ben, 'phone-manual-pin', { scrollCheck: true });
  await ph.Ben.getByRole('button', { name: /pin it here/i }).click();
  await ph.Ben.locator('.thumb').first().waitFor();

  // Cat: Tokyo EXIF
  await ph.Cat.locator('input[type=file]').setInputFiles(path.join(FIX, 'photo_c_tokyo.jpg'));
  await ph.Cat.getByRole('button', { name: /that.s the spot/i }).click();
  await ph.Cat.locator('.thumb').first().waitFor();

  await ph.Ana.getByText(/Your team is set/).waitFor();
  await ph.Ana.waitForTimeout(500);
  await shoot(ph.Ana, 'phone-lobby-upload', { scrollCheck: true });
  check('uploader sees EXIF badge on thumb', /EXIF/.test(await ph.Ana.locator('.thumb-badge').first().textContent()));
  check('Ben sees MANUAL badge on thumb', /MANUAL/.test(await ph.Ben.locator('.thumb-badge').first().textContent()));
  check('Dev (no upload) sees team progress 1/1', (await ph.Dev.getByText(/1\/1 photos/).count()) === 1);

  const startBtn = host.getByRole('button', { name: /^start game$/i });
  await host.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => /^start game$/i.test(x.textContent.trim())); return b && !b.disabled; });
  check('host START enabled once every team has its photo', await startBtn.isEnabled());
  await host.waitForTimeout(500);
  await shoot(host, 'host-lobby');

  {
    const g = await savedGame(host);
    const byName = Object.fromEntries(g.uploads.map((u) => [g.players.find((p) => p.id === u.playerId).name, u]));
    check('Ana upload stored as exif near Vancouver', byName.Ana?.source === 'exif' && Math.abs(byName.Ana.lat - 49.2827) < 0.01 && Math.abs(byName.Ana.lng + 123.1207) < 0.01, JSON.stringify(byName.Ana));
    check('Ben upload stored as manual', byName.Ben?.source === 'manual', JSON.stringify(byName.Ben));
    check('Cat upload stored as exif near Tokyo', byName.Cat?.source === 'exif' && Math.abs(byName.Cat.lat - 35.6586) < 0.01, JSON.stringify(byName.Cat));
  }

  // ---------------------------------------------------------------- play 3 rounds
  await startBtn.click();
  const rounds = [];   // { sitter, rows: {team:{km,penalty}}, totals: {team: km} }
  let shotGuess = false, shotOut = false;

  for (let r = 0; r < 3; r++) {
    const R = `R${r + 1}`;
    log(`round ${r + 1}`);
    await host.locator('.timer').waitFor();
    await photoLoaded(host);
    const sitTag = await host.locator('.tag.accent').first().textContent();
    const sitter = sitTag.replace(/ sits this one out/i, '').trim();
    check(`${R}: host shows photo + "${sitter} sits this one out"`, TEAMS.includes(sitter), sitTag);
    check(`${R}: host timer visible`, /^\d:\d\d$/.test((await host.locator('.timer').textContent()).trim()));
    if (r === 0) {
      const t0 = (await host.locator('.timer').textContent()).trim();
      check('R1: custom 30s timer starts at or below 0:30', t0 <= '0:30' && t0 >= '0:20', t0);
    }

    const mode = {};
    for (const n of NAMES) mode[n] = await phoneMode(ph[n]);
    for (const n of NAMES) {
      const shouldOut = TEAM_OF[n] === sitter;
      check(`${R}: ${n} (${TEAM_OF[n]}) is ${shouldOut ? 'sitting out' : 'guessing'}`, mode[n] === (shouldOut ? 'out' : 'guess'), mode[n]);
      if (shouldOut) {
        check(`${R}: ${n} sit-out screen has no LOCK button and no map`,
          (await ph[n].getByRole('button', { name: /lock/i }).count()) === 0 && (await ph[n].locator('.leaflet-container').count()) === 0);
      } else {
        await photoLoaded(ph[n]);
      }
    }
    check(`${R}: guessing phones received the round photo`, true);

    // --- Ben reloads mid-round 1: must rejoin his team automatically
    if (r === 0) {
      const expect = mode.Ben;
      await ph.Ben.reload();
      const m2 = await phoneMode(ph.Ben, 30000);
      check('R1: Ben reload -> rejoins automatically, same team/screen (no re-entry)', m2 === expect, `${expect} -> ${m2}`);
      check('R1: Ben still named Ben after reload', (await ph.Ben.locator('header.masthead').textContent()).includes('Ben'));
      if (m2 === 'guess') {
        await photoLoaded(ph.Ben);
        check('R1: Ben receives the round photo again after reload', true);
        mode.Ben = 'guess';
      }
      await online4(host);
      check('R1: host shows 4/4 online after Ben reload', true);
    }

    // --- guessing teams: who locks
    const guessing = TEAMS.filter((t) => t !== sitter);
    // Round 2 is the penalty round: the last non-MOOSE guessing team pins but never locks.
    const penaltyTeam = r === 1 ? [...guessing].reverse().find((t) => t !== 'MOOSE') : null;

    for (const n of NAMES) {
      if (mode[n] !== 'guess') continue;
      const [fx, fy] = PIN_AT[TEAM_OF[n]];
      await pinOnMap(ph[n], fx + 0.02 * r, fy + 0.03 * r);
    }
    const pinner = NAMES.find((n) => mode[n] === 'guess');
    await ph[pinner].waitForFunction(() => /Happy with it/i.test(document.body.textContent));
    check(`${R}: ${pinner} sees "lock it in" prompt after pinning; button enabled`, await lockBtn(ph[pinner]).isEnabled());
    if (!shotGuess) {
      shotGuess = true;
      await ph[pinner].waitForTimeout(700);
      await shoot(ph[pinner], 'phone-guess', { scrollCheck: true });
      await shoot(host, 'host-round');
    }
    if (!shotOut && NAMES.some((n) => mode[n] === 'out')) {
      shotOut = true;
      await shoot(ph[NAMES.find((n) => mode[n] === 'out')], 'phone-sitting-out', { scrollCheck: true });
    }

    let firstLockedTeam = null;
    for (const t of guessing) {
      if (t === penaltyTeam) continue;
      const n = LOCKER[t];
      await lockBtn(ph[n]).click();
      const lastLock = !penaltyTeam && t === guessing[guessing.length - 1];   // that lock ends the round straight away
      if (!lastLock) {
        await host.getByText(new RegExp(`LOCKED · ${n}`, 'i')).waitFor();
        check(`${R}: host shows ${t} locked by ${n}`, true);
      }
      if (!firstLockedTeam) firstLockedTeam = t;
      if (n === 'Ana') {
        await ph.Dev.getByText('Locked by Ana').waitFor();
        check(`${R}: Dev's phone shows "Locked by Ana"`, true);
        check(`${R}: Dev's lock button is now disabled`, await ph.Dev.getByRole('button', { name: /^locked$/i }).isDisabled());
      }
    }

    // --- round 2: reload the HOST in the middle of a round (one team locked, penalty team only pinned)
    if (r === 1) {
      await host.waitForTimeout(600);
      await host.reload();
      const resumeBtn = host.getByRole('button', { name: /resume game/i });
      await resumeBtn.waitFor({ timeout: 20000 });
      check('R2: host reload mid-round -> setup offers "Resume game CODE"', (await resumeBtn.textContent()).includes(code));
      await resumeBtn.click();
      await host.locator('.timer').waitFor({ timeout: 20000 });
      check('R2: host resume lands back in round 2', /Round\s*2\s*\/\s*3/i.test(await host.locator('h2.h2').first().textContent()));
      await photoLoaded(host);
      check('R2: host photo restored after resume', true);
      await online4(host);
      check('R2: all 4 phones reconnected to the resumed host', true);
      let same = true;
      for (const n of NAMES) {
        const m = await phoneMode(ph[n], 20000);
        if (m !== mode[n]) { same = false; log(`${n}: ${mode[n]} -> ${m}`); }
      }
      check('R2: phones still on the same screens after host resume', same);
      if (firstLockedTeam) {
        const n = LOCKER[firstLockedTeam];
        await host.waitForTimeout(500);
        check(`R2: ${firstLockedTeam}'s lock (by ${n}) survived the host reload`, (await host.getByText(new RegExp(`LOCKED · ${n}`, 'i')).count()) === 1);
      }
      await host.waitForTimeout(500);
      await shoot(host, 'host-round-resumed');
    }

    // --- wait for reveal (all locked, or 30 s timer for the penalty round)
    const t0 = Date.now();
    await host.getByRole('button', { name: /next round|see results/i }).waitFor({ timeout: 70000 });
    const took = (Date.now() - t0) / 1000;
    if (r === 1) check('R2: round ended by the timer (penalty round)', took > 10, `${took.toFixed(1)}s after resume`);
    else check(`${R}: round ended as soon as every guessing team locked`, took < 10, `${took.toFixed(1)}s`);

    for (const n of NAMES) await ph[n].getByText(/Waiting on the host/i).waitFor();
    check(`${R}: reveal shown on all four phones`, true);
    await host.waitForTimeout(1500);
    const nLines = await host.locator('path.dim-line').count(), nLabels = await host.locator('.dim-label').count();
    const want = penaltyTeam ? 1 : 2;
    check(`${R}: reveal map has 1 target, ${want} dashed line(s) and km label(s) on the TV`,
      (await host.locator('.pin-target').count()) === 1 && nLines === want && nLabels === want, `lines=${nLines} labels=${nLabels}`);

    // read host reveal table
    const rows = await host.$$eval('table.board tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => (c.querySelector('.h2') || c).textContent.trim())));
    const data = { sitter, rows: {}, totals: {} };
    for (const c of rows) {
      const team = c[1];
      data.totals[team] = kmNum(c[4]);
      if (c[2] === 'sat this one out') continue;
      data.rows[team] = { km: kmNum(c[3]), penalty: /penalty/i.test(c[3]), text: c[3], lockedBy: c[2] };
    }
    rounds.push(data);
    log(JSON.stringify(data.rows));

    if (penaltyTeam) {
      const pr = data.rows[penaltyTeam];
      check(`${R}: ${penaltyTeam} (never locked) got 20,000 km penalty on the TV`, pr && pr.penalty && pr.km === 20000, pr?.text);
      check(`${R}: penalty team's phone reveal says no pin / penalty`, (await ph[LOCKER[penaltyTeam]].getByText(/No pin\. Penalty/i).count()) >= 1);
    }
    for (const n of NAMES) {
      const t = TEAM_OF[n];
      if (t === sitter) continue;
      const shown = await ph[n].locator('.big-num').first().textContent();
      check(`${R}: ${n}'s phone reveal km == TV row for ${t}`, Math.abs(kmNum(shown) - data.rows[t].km) < 0.11, `${shown} vs ${data.rows[t].text}`);
    }

    if (r === 0) {
      await shoot(host, 'host-reveal', { extra: 1500 });
      await shoot(ph[NAMES.find((n) => TEAM_OF[n] !== sitter)], 'phone-reveal', { extra: 1500, scrollCheck: true });
      await shoot(ph[NAMES.find((n) => TEAM_OF[n] === sitter)], 'phone-reveal-sitter', { extra: 800, scrollCheck: true });

      // --- reload the HOST during the reveal; resume; reveal comes back; phones reconnect
      await host.reload();
      const resumeBtn = host.getByRole('button', { name: /resume game/i });
      await resumeBtn.waitFor({ timeout: 20000 });
      await resumeBtn.click();
      await host.getByRole('button', { name: /next round/i }).waitFor({ timeout: 20000 });
      check('R1: host reload during reveal -> resume restores the reveal', (await host.locator('table.board tbody tr').count()) === 3);
      await online4(host);
      check('R1: phones reconnected after host reload during reveal', true);
      for (const n of NAMES) await ph[n].getByText(/Waiting on the host/i).waitFor();
      check('R1: phones still on the reveal screen after host resume', true);
      const rows2 = await host.$$eval('table.board tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => (c.querySelector('.h2') || c).textContent.trim())));
      check('R1: reveal table identical after resume', JSON.stringify(rows2.map((x) => [x[1], x[3], x[4]])) === JSON.stringify(rows.map((x) => [x[1], x[3], x[4]])));
    }

    await host.getByRole('button', { name: r === 2 ? /see results/i : /next round/i }).click();
  }

  // ---------------------------------------------------------------- final
  await host.getByText(/WIN\./).waitFor({ timeout: 20000 });
  for (const n of NAMES) await ph[n].getByText(/Look up\. The TV has the victory lap/i).waitFor();
  check('final screen on host and all four phones', true);
  await host.waitForTimeout(800);
  await shoot(host, 'host-final');
  await shoot(ph.Cat, 'phone-final', { scrollCheck: true });
  await shoot(ph.Dev, 'phone-final-dev', { scrollCheck: true });

  const finalRows = await host.$$eval('table.board tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => (c.querySelector('.h2') || c).textContent.trim())));
  const finalTotals = {};
  for (const c of finalRows) finalTotals[c[1]] = kmNum(c[2]);
  log('final totals', JSON.stringify(finalTotals));
  const expectSum = {};
  for (const rd of rounds) for (const [t, v] of Object.entries(rd.rows)) expectSum[t] = (expectSum[t] || 0) + v.km;
  for (const t of TEAMS) {
    check(`final total for ${t} == sum of reveal km (within rounding)`, Math.abs(finalTotals[t] - expectSum[t]) <= 1.6, `${finalTotals[t]} vs ${expectSum[t].toFixed(1)}`);
  }
  const ptName = Object.keys(rounds[1].rows).find((t) => rounds[1].rows[t].penalty);
  const others = rounds.filter((_, i) => i !== 1).reduce((s, rd) => s + (rd.rows[ptName]?.km || 0), 0);
  check(`penalty team ${ptName}: final total = other rounds + 20,000`, Math.abs(finalTotals[ptName] - (others + 20000)) <= 1.6, `${finalTotals[ptName]} vs ${(others + 20000).toFixed(1)}`);
  check('final leaderboard sorted lowest km first', Object.values(finalTotals).every((v, i, a) => i === 0 || a[i - 1] <= v));
  check('final: winner banner names the lowest-km team', (await host.locator('.display').filter({ hasText: /WIN\./ }).textContent()).includes(finalRows[0][1]));

  // exact check against the host's own saved state (haversine recomputed here)
  const g = await savedGame(host);
  let exactOk = true, why = '';
  for (const h of g.history) {
    for (const gu of h.guesses) {
      const want = gu.penalty ? 20000 : haversine({ lat: gu.lat, lng: gu.lng }, h.target);
      if (Math.abs(want - gu.km) > 0.01) { exactOk = false; why = `round ${h.roundIndex} ${gu.teamId} ${gu.km} vs ${want}`; }
    }
  }
  check('every stored km equals an independent haversine (penalty = 20000)', exactOk, why);
  const tgt = Object.fromEntries(g.history.map((h) => [h.uploaderName, h.target]));
  check('targets: Ana = Vancouver (EXIF), Cat = Tokyo (EXIF), Ben = his manual pin',
    Math.abs(tgt.Ana.lat - 49.2827) < 0.01 && Math.abs(tgt.Cat.lat - 35.6586) < 0.01 && Math.abs(tgt.Ben.lat - 49.2827) > 1 && Math.abs(tgt.Ben.lat - 35.6586) > 1, JSON.stringify(tgt.Ben));
} catch (e) {
  check('script ran to completion', false, e.stack || String(e));
  try { await host.screenshot({ path: path.join(SHOTS, '_failure-host.png') }); } catch (_) {}
  for (const n of NAMES) { try { await ph[n].screenshot({ path: path.join(SHOTS, `_failure-${n}.png`) }); } catch (_) {} }
}

check('no unexpected console errors / page errors on any page', consoleProblems.length === 0, consoleProblems.slice(0, 8).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n')); process.exit(1); }
