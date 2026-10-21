// Shared contract between host (TV) and players (phones).
// Every message is a plain object { t: MSG.X, ...payload } sent over a PeerJS
// DataConnection (binary serialization, so ArrayBuffers travel as-is).

export const VERSION = 1;
export const PEER_PREFIX = 'findmygeo-';       // host peer id = PEER_PREFIX + CODE
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O
export const CODE_LENGTH = 4;

export const PENALTY_KM = 20000;               // no pin before the timer ran out
export const TIMER_OPTIONS = [30, 60, 90, 0];  // seconds, 0 = no limit
export const DEFAULT_TIMER = 60;
export const TIMER_MIN = 10, TIMER_MAX = 600;  // custom timer bounds, seconds
export const CUSTOM_TIMER_DEFAULT = 45;
export const MIN_TEAMS = 2, MAX_TEAMS = 8;
export const MIN_PHOTOS = 1, MAX_PHOTOS = 10;

export const DEFAULT_TEAM_NAMES = ['MOOSE', 'LOONS', 'BEAVERS', 'BEARS', 'GEESE', 'OTTERS', 'LYNX', 'ORCAS'];
// Random team-name pool (<= 12 chars: the name input's maxlength).
export const ANIMAL_NAMES = [
  'AARDVARKS', 'ALPACAS', 'ARMADILLOS', 'AXOLOTLS',
  'BADGERS', 'BISON', 'BONOBOS', 'BUDGIES',
  'CAPYBARAS', 'CHIPMUNKS', 'COYOTES', 'CROWS',
  'DINGOS', 'DONKEYS', 'DUCKS',
  'EMUS', 'ELKS', 'EAGLES',
  'FERRETS', 'FLAMINGOS', 'FROGS',
  'GECKOS', 'GOATS', 'GOPHERS',
  'HERONS', 'HEDGEHOGS', 'HIPPOS',
  'IBEXES', 'IGUANAS', 'IMPALAS',
  'JACKALS', 'JAGUARS', 'JELLYFISH',
  'KOALAS', 'KIWIS', 'KANGAROOS',
  'LLAMAS', 'LEMURS', 'LOBSTERS',
  'MOOSE', 'MEERKATS', 'MOLES',
  'NARWHALS', 'NEWTS', 'NUTHATCHES',
  'OCTOPUSES', 'OKAPIS', 'OSTRICHES',
  'PUFFINS', 'PENGUINS', 'PORCUPINES',
  'QUOKKAS', 'QUAILS',
  'RACCOONS', 'RAVENS', 'REINDEER',
  'SLOTHS', 'SEALS', 'STOATS',
  'TAPIRS', 'TOUCANS', 'TORTOISES',
  'URCHINS', 'UNICORNS',
  'VULTURES', 'VOLES', 'VICUNAS',
  'WALRUSES', 'WOMBATS', 'WOLVERINES',
  'YAKS', 'YABBIES',
  'ZEBRAS', 'ZEBUS',
];

// n distinct names, preferably with distinct first letters (stickers show the initial).
// `avoid`: names already taken (never repeated; their initials are used last).
export function pickTeamNames(n, rng = Math.random, avoid = []) {
  const shuf = (a) => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const taken = new Set(avoid.map((a) => String(a).trim().toUpperCase()));
  const byLetter = {};
  for (const nm of ANIMAL_NAMES) if (!taken.has(nm)) (byLetter[nm[0]] ??= []).push(nm);
  const seen = new Set([...taken].map((a) => a[0]));
  const letters = Object.keys(byLetter);
  const order = [...shuf(letters.filter((l) => !seen.has(l))), ...shuf(letters.filter((l) => seen.has(l)))];
  const out = order.slice(0, n).map((l) => byLetter[l][Math.floor(rng() * byLetter[l].length)]);
  if (out.length < n) {  // more teams than letters: repeat initials rather than names
    const rest = shuf(ANIMAL_NAMES.filter((nm) => !taken.has(nm) && !out.includes(nm)));
    out.push(...rest.slice(0, n - out.length));
  }
  return out;
}

export const TEAM_COLORS = ['#A5D9DA', '#B5B0F2', '#FA6767', '#FACE05', '#F0A8CB', '#7FC8A9', '#FFC01F', '#8EC3D9'];

export const PHOTO_FULL_EDGE = 1600;  // long edge sent to host (TV)
export const PHOTO_GUESS_EDGE = 800;  // long edge forwarded to guessing phones
export const JPEG_QUALITY = 0.82;

export const PHASE = Object.freeze({
  SETUP: 'setup',     // host only, before the room exists
  LOBBY: 'lobby',     // joining + uploading
  ROUND: 'round',     // a photo is up, teams are pinning
  REVEAL: 'reveal',   // answer + distances for the round just played
  FINAL: 'final',     // leaderboard
});

export const MSG = Object.freeze({
  // player -> host
  HELLO: 'hello',                 // { playerId, name, teamId|null }  (sent on every (re)connect)
  JOIN_TEAM: 'join_team',         // { teamId }
  UPLOAD: 'upload',               // { uploadId, full: ArrayBuffer, guess: ArrayBuffer, lat, lng, source: 'exif'|'manual' }
  DELETE_UPLOAD: 'delete_upload', // { uploadId }
  GUESS: 'guess',                 // { roundIndex, lat, lng }

  // host -> player
  STATE: 'state',                 // { state: PublicState, you: You }
  ROUND_PHOTO: 'round_photo',     // { roundIndex, image: ArrayBuffer }  (800px jpeg, guessing teams only)
  ERROR: 'error',                 // { code: ERR.X, message }

  // either way
  PING: 'ping',
  PONG: 'pong',
});

export const ERR = Object.freeze({
  TEAM_FULL: 'team_full',         // team already has photosPerTeam uploads
  NOT_IN_LOBBY: 'not_in_lobby',
  SITTING_OUT: 'sitting_out',     // guess from the uploader's team
  ALREADY_LOCKED: 'already_locked',
  BAD_ROUND: 'bad_round',
  UNKNOWN: 'unknown',
});

/**
 * What the host broadcasts. Never contains image bytes, and never contains the
 * target coordinates of a photo before its reveal.
 *
 * @typedef {Object} PublicState
 * @property {number} v                 VERSION
 * @property {string} code              room code, e.g. "KQZP"
 * @property {string} phase             PHASE.*
 * @property {{teamCount:number, photosPerTeam:number, timerSec:number}} config
 * @property {{id:string, name:string, color:string}[]} teams      id is 't0'..'t7'
 * @property {{id:string, name:string, teamId:string|null, connected:boolean}[]} players
 * @property {{id:string, teamId:string, playerId:string, source:'exif'|'manual'}[]} uploads  lobby list
 * @property {?RoundInfo} round         set in ROUND and REVEAL
 * @property {?Reveal} reveal           set in REVEAL (and kept for the last round in FINAL)
 * @property {{teamId:string, totalKm:number, played:number}[]} scores  sorted ascending by totalKm
 * @property {RoundResult[]} history    one entry per finished round (used by FINAL)
 *
 * @typedef {Object} RoundInfo
 * @property {number} index             0-based
 * @property {number} total             teamCount * photosPerTeam (after any trim)
 * @property {string} uploaderTeamId    this team sits out
 * @property {string} uploaderName      player name who uploaded
 * @property {?number} remainingMs      ms left at the moment the snapshot was sent; null = no timer.
 *                                      Clients compute their own deadline = Date.now() + remainingMs.
 * @property {Object<string,string>} locked   teamId -> name of player who locked in
 *
 * @typedef {Object} Guess
 * @property {string} teamId
 * @property {?number} lat              null when the team never pinned (penalty)
 * @property {?number} lng
 * @property {number} km                distance, or PENALTY_KM
 * @property {boolean} penalty
 * @property {?string} lockedBy
 *
 * @typedef {Object} Reveal
 * @property {number} roundIndex
 * @property {{lat:number, lng:number}} target
 * @property {Guess[]} guesses          sorted ascending by km
 * @property {string} uploaderTeamId
 * @property {string} uploaderName
 *
 * @typedef {Reveal} RoundResult
 *
 * @typedef {Object} You                per-recipient part of a STATE message
 * @property {string} playerId
 * @property {string} name
 * @property {?string} teamId
 * @property {string[]} myUploadIds
 */

export const msg = (t, payload = {}) => ({ t, ...payload });
