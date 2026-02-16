import { parsePgn, startingPosition, walk, Box } from 'chessops/pgn';
import type { PgnNodeData } from 'chessops/pgn';
import type { Position } from 'chessops';
import { parseSan, makeSan } from 'chessops/san';
import { makeFen, parseFen } from 'chessops/fen';
import { makeUci, parseUci } from 'chessops';
import { Chess } from 'chessops/chess';
import type { ExplorerMove, ExplorerResponse } from './types';

// ── Types ──

export type ExplorerMode = 'database' | 'personal';
export type Platform = 'lichess' | 'chesscom';

const TC_ORDER: Record<string, number> = { bullet: 0, blitz: 1, rapid: 2, classical: 3, daily: 4 };

export function sortTimeClasses(tcs: string[]): string[] {
  return tcs.sort((a, b) => (TC_ORDER[a] ?? 99) - (TC_ORDER[b] ?? 99));
}

interface PersonalConfig {
  platform: Platform;
  username: string;
  lastImportTimestamp: number;
  gameCount: number;
  lastCompletedArchive?: string;
}

/** Compact per-game metadata. Short keys to reduce JSON size. */
export interface GameMeta {
  tc: string;   // time class: bullet/blitz/rapid/classical/daily
  ur: number;   // user's rating
  or: number;   // opponent rating
  mo: string;   // month: YYYY-MM
  re: 'w' | 'd' | 'b'; // game result (white won / draw / black won)
  uw: boolean;  // user was white
  gl?: string;  // game link (URL)
  op?: string;  // opponent name
}

/** Full database stored in IndexedDB */
interface PersonalDBV2 {
  v: 2;
  games: GameMeta[];
  positions: Record<string, Record<string, number[]>>; // posKey → uci → gameIndices
  fingerprints?: string[];  // game fingerprints for dedup (parallel to games[])
}

export interface PersonalFilters {
  timeClasses?: string[];   // e.g. ['blitz', 'rapid']
  minRating?: number;
  maxRating?: number;
  sinceMonth?: string;      // YYYY-MM
  untilMonth?: string;      // YYYY-MM
  color?: 'white' | 'black'; // only games where user played this color
}

export interface LichessFilters {
  perfType?: string[];
  rated?: boolean;
}

export interface ChesscomFilters {
  // Chess.com has no server-side filtering; all games are imported
  // and can be filtered post-import via setPersonalFilters()
}

// ── Constants ──

const MAX_PLY = 40;
const DB_NAME = 'chessbased';
const DB_VERSION = 2;
const STORE_NAME = 'personal-games-v2';
const OLD_STORE_NAME = 'personal-games';

// ── Storage Keys ──

const CONFIG_KEY = 'chessbased-personal-config';
const LEGACY_GAMES_KEY = 'chessbased-personal-games';

// ── Module State ──

let explorerMode: ExplorerMode = 'database';
let personalConfig: PersonalConfig | null = null;
let personalDB: PersonalDBV2 | null = null;
let dbReady = false;

// Active filters + precomputed matching game set
let activeFilters: PersonalFilters = {};
let filteredGameSet: Set<number> | null = null; // null = no filter (show all)

// ── IndexedDB ──

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Clean up old store
      if (db.objectStoreNames.contains(OLD_STORE_NAME)) {
        db.deleteObjectStore(OLD_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadDBFromIDB(): Promise<PersonalDBV2 | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get('data');
      req.onsuccess = () => {
        const val = req.result;
        if (val && val.v === 2) resolve(val);
        else resolve(null);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

async function saveDBToIDB(data: PersonalDBV2): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(data, 'data');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function clearIDB(): Promise<void> {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch { /* ignore */ }
}

// ── Config ──

function loadConfig(): PersonalConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveConfig(cfg: PersonalConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// ── Init ──

export async function initPersonalExplorer(): Promise<void> {
  personalConfig = loadConfig();
  // Clean up legacy localStorage data
  try { localStorage.removeItem(LEGACY_GAMES_KEY); } catch { /* ignore */ }
  personalDB = await loadDBFromIDB();
  dbReady = true;
}

// ── Public API ──

export function getExplorerMode(): ExplorerMode {
  return explorerMode;
}

export function setExplorerMode(mode: ExplorerMode): void {
  explorerMode = mode;
}

export function hasPersonalData(): boolean {
  return personalDB != null && personalDB.games.length > 0;
}

export function getPersonalConfig(): PersonalConfig | null {
  if (!personalConfig) personalConfig = loadConfig();
  return personalConfig;
}

export function isDBReady(): boolean {
  return dbReady;
}

export function getPersonalGames(): readonly GameMeta[] | null {
  return personalDB?.games ?? null;
}

export async function clearPersonalData(): Promise<void> {
  localStorage.removeItem(CONFIG_KEY);
  try { localStorage.removeItem(LEGACY_GAMES_KEY); } catch { /* ignore */ }
  await clearIDB();
  personalConfig = null;
  personalDB = null;
  filteredGameSet = null;
  activeFilters = {};
}

// ── Filters ──

export function getPersonalFilters(): PersonalFilters {
  return { ...activeFilters };
}

export function setPersonalFilters(filters: PersonalFilters): void {
  activeFilters = { ...filters };
  recomputeFilteredSet();
}

function recomputeFilteredSet(): void {
  if (!personalDB) { filteredGameSet = null; return; }

  const hasAny =
    (activeFilters.timeClasses && activeFilters.timeClasses.length > 0) ||
    activeFilters.minRating != null ||
    activeFilters.maxRating != null ||
    activeFilters.sinceMonth ||
    activeFilters.untilMonth ||
    activeFilters.color;

  if (!hasAny) {
    filteredGameSet = null; // no filter = show all
    return;
  }

  const set = new Set<number>();
  const games = personalDB.games;
  for (let i = 0; i < games.length; i++) {
    if (gameMatchesFilters(games[i])) set.add(i);
  }
  filteredGameSet = set;
}

function gameMatchesFilters(g: GameMeta): boolean {
  if (activeFilters.timeClasses && activeFilters.timeClasses.length > 0) {
    if (!activeFilters.timeClasses.includes(g.tc)) return false;
  }
  if (activeFilters.minRating != null && g.ur < activeFilters.minRating) return false;
  if (activeFilters.maxRating != null && g.ur > activeFilters.maxRating) return false;
  if (activeFilters.sinceMonth && g.mo < activeFilters.sinceMonth) return false;
  if (activeFilters.untilMonth && g.mo > activeFilters.untilMonth) return false;
  if (activeFilters.color === 'white' && !g.uw) return false;
  if (activeFilters.color === 'black' && g.uw) return false;
  return true;
}

/** Get available time classes and rating range from imported data */
export function getPersonalStats(): { timeClasses: string[]; minRating: number; maxRating: number; months: string[] } | null {
  if (!personalDB || personalDB.games.length === 0) return null;
  const tcSet = new Set<string>();
  const monthSet = new Set<string>();
  let minR = Infinity, maxR = -Infinity;
  for (const g of personalDB.games) {
    tcSet.add(g.tc);
    monthSet.add(g.mo);
    if (g.ur < minR) minR = g.ur;
    if (g.ur > maxR) maxR = g.ur;
  }
  return {
    timeClasses: sortTimeClasses([...tcSet]),
    minRating: minR,
    maxRating: maxR,
    months: [...monthSet].sort(),
  };
}

/** Count of games matching current filters */
export function getFilteredGameCount(): number {
  if (!personalDB) return 0;
  if (!filteredGameSet) return personalDB.games.length;
  return filteredGameSet.size;
}

// ── Position Key ──

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

// ── Query ──

export function queryPersonalExplorer(fen: string): ExplorerResponse | null {
  if (!personalDB) return null;
  const key = positionKey(fen);
  const movesMap = personalDB.positions[key];
  if (!movesMap || Object.keys(movesMap).length === 0) return null;

  const setup = parseFen(fen);
  if (!setup.isOk) return null;
  const pos = Chess.fromSetup(setup.value);
  if (!pos.isOk) return null;
  const chess = pos.value;

  const games = personalDB.games;
  const explorerMoves: ExplorerMove[] = [];

  for (const [uci, indices] of Object.entries(movesMap)) {
    const move = parseUci(uci);
    if (!move) continue;
    let san: string;
    try { san = makeSan(chess, move); } catch { continue; }

    let w = 0, d = 0, b = 0;
    for (const idx of indices) {
      if (filteredGameSet && !filteredGameSet.has(idx)) continue;
      const g = games[idx];
      if (g.re === 'w') w++;
      else if (g.re === 'd') d++;
      else b++;
    }

    const total = w + d + b;
    if (total === 0) continue;

    explorerMoves.push({ uci, san, white: w, draws: d, black: b, averageRating: 0 });
  }

  explorerMoves.sort((a, b) => {
    const totalA = a.white + a.draws + a.black;
    const totalB = b.white + b.draws + b.black;
    return totalB - totalA;
  });

  return { moves: explorerMoves };
}

// ── PGN Processing ──

type GameResult = 'w' | 'd' | 'b';

function parseResult(header: string | undefined): GameResult | null {
  if (!header) return null;
  if (header === '1-0') return 'w';
  if (header === '0-1') return 'b';
  if (header === '1/2-1/2') return 'd';
  return null;
}

function detectTimeClass(headers: Map<string, string>): string {
  const event = headers.get('Event') ?? '';
  const eventLower = event.toLowerCase();
  if (eventLower.includes('bullet')) return 'bullet';
  if (eventLower.includes('blitz')) return 'blitz';
  if (eventLower.includes('rapid')) return 'rapid';
  if (eventLower.includes('daily') || eventLower.includes("let's play")) return 'daily';
  if (eventLower.includes('classical') || eventLower.includes('correspondence')) return 'classical';

  const tc = headers.get('TimeControl');
  if (!tc || tc === '-') return 'unknown';
  // Daily games on Chess.com use format like "1/259200"
  if (tc.includes('/')) return 'daily';
  const match = tc.match(/^(\d+)/);
  if (!match) return 'unknown';
  const base = parseInt(match[1]);
  if (base < 180) return 'bullet';
  if (base < 600) return 'blitz';
  if (base < 1800) return 'rapid';
  return 'classical';
}

function parseMonth(headers: Map<string, string>): string {
  const date = headers.get('UTCDate') ?? headers.get('Date') ?? '';
  // Format: "2026.01.26" → "2026-01"
  const parts = date.split('.');
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return 'unknown';
}

function parseRating(headers: Map<string, string>, isWhite: boolean): number {
  const key = isWhite ? 'WhiteElo' : 'BlackElo';
  const val = headers.get(key);
  return val ? parseInt(val) || 0 : 0;
}

function gameFingerprint(headers: Map<string, string>): string {
  // Chess.com: Link header is unique game URL; Lichess: Site header
  const link = headers.get('Link') ?? headers.get('Site') ?? '';
  if (link.includes('/game/') || link.includes('lichess.org/')) return link;
  // Fallback: composite key
  const w = headers.get('White') ?? '';
  const b = headers.get('Black') ?? '';
  const d = headers.get('UTCDate') ?? headers.get('Date') ?? '';
  const t = headers.get('UTCTime') ?? headers.get('StartTime') ?? '';
  return `${w}|${b}|${d}|${t}`;
}

export function processGamesIntoDB(
  pgnText: string,
  username: string,
  db: PersonalDBV2,
  knownGames?: Set<string>,
): number {
  const games = parsePgn(pgnText);
  let processed = 0;

  for (const game of games) {
    const result = parseResult(game.headers.get('Result'));
    if (!result) continue;

    // Dedup: skip games already in the database
    const fp = gameFingerprint(game.headers);
    if (knownGames) {
      if (knownGames.has(fp)) continue;
      knownGames.add(fp);
    }

    const whitePlayer = game.headers.get('White') ?? '';
    const blackPlayer = game.headers.get('Black') ?? '';
    const userIsWhite = whitePlayer.toLowerCase() === username.toLowerCase();
    const userIsBlack = blackPlayer.toLowerCase() === username.toLowerCase();
    if (!userIsWhite && !userIsBlack) continue;

    const tc = detectTimeClass(game.headers);

    const gameLink = game.headers.get('Link') ?? game.headers.get('Site') ?? '';
    const opponent = userIsWhite ? blackPlayer : whitePlayer;

    const meta: GameMeta = {
      tc,
      ur: parseRating(game.headers, userIsWhite),
      or: parseRating(game.headers, !userIsWhite),
      mo: parseMonth(game.headers),
      re: result,
      uw: userIsWhite,
      gl: gameLink || undefined,
      op: opponent || undefined,
    };

    const gameIdx = db.games.length;
    db.games.push(meta);
    if (!db.fingerprints) db.fingerprints = [];
    db.fingerprints.push(fp);

    const posResult = startingPosition(game.headers);
    if (!posResult.isOk) continue;

    let ply = 0;
    walk(game.moves, new Box(posResult.value), (ctx, node: PgnNodeData) => {
      if (ply >= MAX_PLY) return;
      const pos: Position = ctx.value;
      const move = parseSan(pos, node.san);
      if (!move) return;

      const fen = makeFen(pos.toSetup());
      const uci = makeUci(move);
      const key = positionKey(fen);

      if (!db.positions[key]) db.positions[key] = {};
      if (!db.positions[key][uci]) db.positions[key][uci] = [];
      db.positions[key][uci].push(gameIdx);

      pos.play(move);
      ply++;
    });

    processed++;
  }

  return processed;
}

function emptyDB(): PersonalDBV2 {
  return { v: 2, games: [], positions: {}, fingerprints: [] };
}

// ── Lichess Import ──

export async function importFromLichess(
  username: string,
  onProgress: (msg: string, count: number) => void,
  signal?: AbortSignal,
  filters?: LichessFilters,
): Promise<number> {
  // Lichess always does fresh import for now (since param filtering changes results)
  const db = emptyDB();

  let url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?pgnInBody=true&clocks=false&evals=false&opening=false`;
  if (filters?.perfType && filters.perfType.length > 0) {
    url += `&perfType=${filters.perfType.join(',')}`;
  }
  if (filters?.rated !== undefined) {
    url += `&rated=${filters.rated}`;
  }

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/x-chess-pgn' },
    signal,
  });

  if (resp.status === 404) throw new Error('User not found on Lichess');
  if (resp.status === 429) throw new Error('Rate limited — please wait a minute and try again');
  if (!resp.ok) throw new Error(`Lichess API error (${resp.status})`);

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('Streaming not supported');

  const decoder = new TextDecoder();
  let buffer = '';
  let totalGames = 0;

  while (true) {
    if (signal?.aborted) throw new Error('Import cancelled');
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split(/\n\n\n/);
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const count = processGamesIntoDB(trimmed, username, db);
      totalGames += count;
      onProgress('Downloading games...', totalGames);
    }
  }

  if (buffer.trim()) {
    const count = processGamesIntoDB(buffer.trim(), username, db);
    totalGames += count;
  }

  await saveDBToIDB(db);
  personalDB = db;
  filteredGameSet = null;
  recomputeFilteredSet();
  personalConfig = {
    platform: 'lichess',
    username,
    lastImportTimestamp: Date.now(),
    gameCount: totalGames,
  };
  saveConfig(personalConfig);

  return totalGames;
}

// ── Chess.com Import ──

export async function importFromChesscom(
  username: string,
  onProgress: (msg: string, count: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const existingConfig = loadConfig();
  const isSameUser = existingConfig?.platform === 'chesscom' &&
    existingConfig.username.toLowerCase() === username.toLowerCase();
  const lastArchive = isSameUser ? existingConfig?.lastCompletedArchive : undefined;

  // Incremental: reuse existing DB and skip completed archives
  // Force fresh import if DB lacks fingerprints (pre-dedup migration)
  const existingDB = isSameUser ? (personalDB ?? await loadDBFromIDB()) : null;
  const hasFingerprints = existingDB?.fingerprints && existingDB.fingerprints.length > 0;
  const isIncremental = isSameUser && existingConfig != null && hasFingerprints;
  const db = isIncremental && existingDB ? existingDB : emptyDB();
  let totalGames = isIncremental ? (existingConfig?.gameCount ?? 0) : 0;

  // Build dedup set from existing fingerprints
  const knownGames = new Set<string>(db.fingerprints ?? []);

  onProgress('Fetching game archives...', totalGames);
  const archResp = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`,
    { signal },
  );

  if (archResp.status === 404) throw new Error('User not found on Chess.com');
  if (!archResp.ok) throw new Error(`Chess.com API error (${archResp.status})`);

  const archData = await archResp.json() as { archives: string[] };
  const allArchives = archData.archives ?? [];
  if (allArchives.length === 0) throw new Error('No games found for this user');

  let startIndex = 0;
  if (isIncremental) {
    if (lastArchive) {
      const lastIdx = allArchives.indexOf(lastArchive);
      if (lastIdx >= 0) startIndex = lastIdx;
    } else {
      startIndex = Math.max(0, allArchives.length - 2);
    }
  }
  const archives = allArchives.slice(startIndex);
  const skipped = allArchives.length - archives.length;

  for (let i = 0; i < archives.length; i++) {
    if (signal?.aborted) throw new Error('Import cancelled');
    onProgress(`Downloading archive ${skipped + i + 1}/${allArchives.length}...`, totalGames);

    try {
      const pgnResp = await fetch(`${archives[i]}/pgn`, { signal });
      if (!pgnResp.ok) continue;
      const pgnText = await pgnResp.text();
      const count = processGamesIntoDB(pgnText, username, db, knownGames);
      totalGames += count;
    } catch (e) {
      if (signal?.aborted) throw new Error('Import cancelled');
      continue;
    }

    if (i < archives.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const completedArchive = allArchives.length >= 2
    ? allArchives[allArchives.length - 2]
    : undefined;

  await saveDBToIDB(db);
  personalDB = db;
  filteredGameSet = null;
  recomputeFilteredSet();
  personalConfig = {
    platform: 'chesscom',
    username,
    lastImportTimestamp: Date.now(),
    gameCount: db.games.length,
    lastCompletedArchive: completedArchive,
  };
  saveConfig(personalConfig);

  return db.games.length;
}
