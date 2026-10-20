// Networking: thin, defensive wrapper around PeerJS (global `Peer`, never touched at import time).
//
//   hostRoom(code, handlers)  -> the TV. Owns peer id PEER_PREFIX + code, accepts any number of phones.
//   joinRoom(code, handlers)  -> a phone. Reconnects forever (backoff), queues sends while down.
//
// A phone that drops and comes back arrives on the host as a NEW DataConnection with a NEW connId;
// we only surface onConnect / onDisconnect. Mapping connId -> playerId is host.js's job (via HELLO).

import { PEER_PREFIX, CODE_ALPHABET, CODE_LENGTH, MSG } from './protocol.js';

const HEARTBEAT_MS = 5000;     // phone -> host PING cadence
const DEAD_AFTER_MS = 12000;   // phone: no traffic for this long = connection is dead
const HOST_STALE_MS = 20000;   // host: drop a phone that has been silent this long
const CONNECT_TIMEOUT_MS = 15000;
const NOT_FOUND_RETRY_MS = 5000;
const MAX_BACKOFF_MS = 10000;
const MAX_QUEUE = 40;

export function makeRoomCode() {
  const buf = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

// Local signaling server override: ?peerHost=192.168.1.5&peerPort=9000&peerPath=/myapp&peerSecure=0
export function peerOptions() {
  const o = { debug: 1 };
  let q;
  try { q = new URLSearchParams(location.search); } catch (e) { return o; }
  const host = q.get('peerHost');
  if (host) {
    o.host = host;
    const port = q.get('peerPort');
    if (port) o.port = Number(port);
    let path = q.get('peerPath');
    if (path) {
      if (!path.startsWith('/')) path = '/' + path;
      if (!path.endsWith('/')) path += '/';
      o.path = path;
    }
    const sec = q.get('peerSecure');
    o.secure = sec != null ? sec === '1' : location.protocol === 'https:';
  }
  return o;
}

function safeSend(conn, data) {
  try {
    if (conn && conn.open) { conn.send(data); return true; }
  } catch (e) { console.warn('[net] send failed', e); }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------

export function hostRoom(code, { onConnect, onMessage, onDisconnect } = {}) {
  const id = PEER_PREFIX + code;
  const conns = new Map();          // connId -> { conn, last }
  let nextId = 1;
  let closed = false;
  let opened = false;
  let peer = null;
  let retry = 0;
  let retryTimer = null;
  let sweepTimer = null;

  return new Promise((resolve, reject) => {
    const api = {
      code,
      send(connId, m) {
        const c = conns.get(connId);
        return c ? safeSend(c.conn, m) : false;
      },
      broadcast(m) {
        for (const c of conns.values()) safeSend(c.conn, m);
      },
      connIds() { return [...conns.keys()]; },
      close() {
        closed = true;
        clearTimeout(retryTimer);
        clearInterval(sweepTimer);
        for (const c of conns.values()) { try { c.conn.close(); } catch (e) {} }
        conns.clear();
        try { peer && peer.destroy(); } catch (e) {}
        peer = null;
      },
    };

    const schedule = (fn) => {
      if (closed || retryTimer) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry++);
      retryTimer = setTimeout(() => { retryTimer = null; if (!closed) fn(); }, delay);
    };

    function accept(conn) {
      const connId = 'c' + nextId++;
      const info = { conn, last: Date.now() };
      let live = false;
      let ended = false;

      const end = () => {
        if (ended) return;
        ended = true;
        conns.delete(connId);
        try { conn.close(); } catch (e) {}
        if (live) { try { onDisconnect && onDisconnect(connId); } catch (e) { console.error(e); } }
      };
      info.end = end;

      const opened_ = () => {
        if (live || ended) return;
        live = true;
        conns.set(connId, info);
        try { onConnect && onConnect(connId); } catch (e) { console.error(e); }
      };

      conn.on('open', opened_);
      conn.on('data', (data) => {
        info.last = Date.now();
        if (data && data.t === MSG.PING) { safeSend(conn, { t: MSG.PONG }); return; }
        if (data && data.t === MSG.PONG) return;
        if (!live) opened_();
        try { onMessage && onMessage(connId, data); } catch (e) { console.error(e); }
      });
      conn.on('close', end);
      conn.on('error', end);
      if (conn.open) opened_();
    }

    function start() {
      if (closed) return;
      const mine = new Peer(id, peerOptions());
      peer = mine;

      mine.on('open', () => {
        retry = 0;
        if (!opened) { opened = true; resolve(api); }
      });
      mine.on('connection', accept);
      mine.on('disconnected', () => {
        // Lost the signaling server (existing data connections keep working). Keep trying to get back.
        if (closed || peer !== mine) return;
        schedule(() => {
          try { mine.reconnect(); } catch (e) { restart(); }
        });
      });
      mine.on('close', () => {
        if (closed || peer !== mine || !opened) return;
        restart();
      });
      mine.on('error', (err) => {
        if (peer !== mine) return;
        if (!opened) {
          try { mine.destroy(); } catch (e) {}
          peer = null;
          reject(err && err.type === 'unavailable-id' ? new Error('ROOM_TAKEN') : err);
          return;
        }
        console.warn('[net] host peer error', err && err.type, err);
        if (err && err.type === 'unavailable-id') restart();   // our id is still held server-side; retry shortly
        else if (mine.destroyed) restart();
      });
    }

    function restart() {
      if (closed) return;
      const old = peer;
      peer = null;
      try { old && old.destroy(); } catch (e) {}
      schedule(start);
    }

    // Drop phones that went silent (they ping every HEARTBEAT_MS).
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const c of [...conns.values()]) if (now - c.last > HOST_STALE_MS) c.end();
    }, HEARTBEAT_MS);

    start();
  });
}

// ---------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------

export async function joinRoom(code, { onMessage, onStatus } = {}) {
  const hostId = PEER_PREFIX + code;
  let peer = null;
  let conn = null;
  let closed = false;
  let status = null;
  let everOpen = false;
  let gen = 0;                 // bumped whenever the current attempt is abandoned; stale handlers bail out
  let attempt = 0;
  let retryTimer = null;
  let connTimer = null;
  let hbTimer = null;
  let lastRx = 0;
  const queue = [];

  function setStatus(s) {
    if (s === status) return;
    status = s;
    try { onStatus && onStatus(s); } catch (e) { console.error(e); }
  }

  function dropConn() {
    clearTimeout(connTimer);
    connTimer = null;
    const c = conn;
    conn = null;
    if (c) { try { c.close(); } catch (e) {} }
  }

  function destroyPeer() {
    const p = peer;
    peer = null;
    if (p) { try { p.destroy(); } catch (e) {} }
  }

  function stopHb() { clearInterval(hbTimer); hbTimer = null; }

  function startHb() {
    stopHb();
    hbTimer = setInterval(() => {
      if (closed || !conn || !conn.open) return;
      if (Date.now() - lastRx > DEAD_AFTER_MS) { fail(); return; }
      safeSend(conn, { t: MSG.PING });
    }, HEARTBEAT_MS);
  }

  function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connectNow, ms);
  }

  // Abandon the current attempt and retry with backoff.
  function fail() {
    if (closed) return;
    gen++;
    stopHb();
    dropConn();
    if (status !== 'not-found') setStatus(everOpen ? 'reconnecting' : 'connecting');
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    attempt++;
    scheduleRetry(delay);
  }

  function notFound() {
    if (closed) return;
    gen++;
    stopHb();
    dropConn();
    setStatus('not-found');
    scheduleRetry(NOT_FOUND_RETRY_MS);
  }

  function flush() {
    while (queue.length && conn && conn.open) {
      const m = queue.shift();
      if (!safeSend(conn, m)) { queue.unshift(m); break; }
    }
  }

  function openConn(g, p) {
    if (g !== gen || closed) return;
    const c = p.connect(hostId, { reliable: true, serialization: 'binary' });
    conn = c;
    c.on('open', () => {
      if (g !== gen || closed) return;
      clearTimeout(connTimer);
      attempt = 0;
      everOpen = true;
      lastRx = Date.now();
      startHb();
      setStatus('open');      // caller sends HELLO here, before any queued message
      flush();
    });
    c.on('data', (d) => {
      if (g !== gen || closed) return;
      lastRx = Date.now();
      if (d && d.t === MSG.PONG) return;
      if (d && d.t === MSG.PING) { safeSend(c, { t: MSG.PONG }); return; }
      try { onMessage && onMessage(d); } catch (e) { console.error(e); }
    });
    c.on('close', () => { if (g === gen) fail(); });
    c.on('error', () => { if (g === gen) fail(); });
  }

  function onPeerError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable') { notFound(); return; }
    console.warn('[net] peer error', type, err);
    fail();
  }

  function connectNow() {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    gen++;
    const g = gen;
    dropConn();
    if (status !== 'not-found') setStatus(everOpen ? 'reconnecting' : 'connecting');

    if (!peer || peer.destroyed || peer.disconnected || !peer.open) {
      destroyPeer();
      const p = new Peer(peerOptions());
      peer = p;
      p.on('open', () => { if (peer === p && !closed) openConn(gen, p); });
      p.on('error', (err) => { if (peer === p && !closed) onPeerError(err); });
    } else {
      openConn(g, peer);
    }
    connTimer = setTimeout(() => { if (g === gen) fail(); }, CONNECT_TIMEOUT_MS);
  }

  function reconnectNow() {
    if (closed) return;
    attempt = 0;
    stopHb();
    connectNow();
  }

  function onWake() {
    if (closed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const healthy = status === 'open' && conn && conn.open && Date.now() - lastRx < DEAD_AFTER_MS;
    if (healthy) { safeSend(conn, { t: MSG.PING }); return; }
    reconnectNow();
  }

  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('online', onWake);

  setTimeout(connectNow, 0);

  return {
    send(m) {
      if (closed) return false;
      if (status === 'open' && conn && conn.open) {
        flush();
        if (queue.length === 0 && safeSend(conn, m)) return true;
        reconnectNow();
      }
      queue.push(m);
      while (queue.length > MAX_QUEUE) queue.shift();
      return false;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      stopHb();
      dropConn();
      destroyPeer();
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      queue.length = 0;
      setStatus('closed');
    },
  };
}
