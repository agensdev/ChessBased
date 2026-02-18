import { sortTimeClasses } from './personal-explorer';
import type { GameMeta } from './personal-explorer';
import type { ExplorerMove, ExplorerResponse } from './types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';
import { findOpeningByFen } from './opening-index';

// ── Types ──

export interface WDL {
  wins: number;
  draws: number;
  losses: number;
  total: number;
}

export interface CriticalMoveDrop {
  ply: number; // 1-based ply in the line
  moveSan: string;
  moveUci: string;
  parentScorePct: number;
  childScorePct: number;
  dropPct: number;
  games: number;
}

export interface VulnerableResponse {
  moveSan: string;
  moveUci: string;
  games: number;
  frequencyPct: number;
  scorePct: number;
  vulnerability: number;
}

export interface VulnerabilityContext {
  ply: number; // 1-based ply of the user move after which responses are measured
  moveSan: string;
}

export interface OpeningLine {
  label: string;
  displayLabel: string;
  moves: string[];   // SAN
  ucis: string[];    // UCI
  wdl: WDL;
  winRate: number;
  endFen: string;
  color: 'white' | 'black';
  openingName: string | null;
  eco: string | null;
  rawScorePct: number;
  adjustedScorePct: number;
  scoreCiPct: number;
  confidence: 'high' | 'medium' | 'low';
  deltaVsExpectedPct: number | null;
  impact: number;
  exampleLinks: {
    wins: string[];
    losses: string[];
    draws: string[];
    all: string[];
  };
  criticalDrops: CriticalMoveDrop[];
  vulnerabilityContext: VulnerabilityContext | null;
  vulnerableResponses: VulnerableResponse[];
}

export interface MonthlyRating {
  month: string;
  avgRating: number;
  gameCount: number;
}

export interface TimeControlStats {
  timeClass: string;
  wdl: WDL;
  winRate: number;
}

export interface ReportData {
  totalGames: number;
  overall: WDL;
  overallWinRate: number;
  asWhite: WDL;
  asBlack: WDL;
  byTimeControl: TimeControlStats[];
  ratingTrend: MonthlyRating[];
  whiteOpenings: OpeningLine[];
  blackOpenings: OpeningLine[];
  weaknessQueue: OpeningLine[];
  bestScoreOpenings: OpeningLine[];
  bestOpenings: OpeningLine[];
  worstOpenings: OpeningLine[];
}

// ── Helpers ──

function emptyWDL(): WDL {
  return { wins: 0, draws: 0, losses: 0, total: 0 };
}

function userResult(game: GameMeta): 'win' | 'draw' | 'loss' {
  if (game.re === 'd') return 'draw';
  if (game.re === 'w') return game.uw ? 'win' : 'loss';
  return game.uw ? 'loss' : 'win';
}

function addResult(wdl: WDL, result: 'win' | 'draw' | 'loss'): void {
  if (result === 'win') wdl.wins++;
  else if (result === 'draw') wdl.draws++;
  else wdl.losses++;
  wdl.total++;
}

function winRate(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return Math.round((wdl.wins / wdl.total) * 100);
}

function scoreRate(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return (wdl.wins + wdl.draws * 0.5) / wdl.total;
}

function scorePct(wdl: WDL): number {
  return Math.round(scoreRate(wdl) * 100);
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

// ── Opening Tree Walk ──

type QueryFn = (fen: string) => ExplorerResponse | null;
type MoveGameIndicesFn = (fen: string, uci: string) => number[];
type GameByIndexFn = (idx: number) => GameMeta | undefined;

const MIN_GAMES_FOR_LINE = 5;
const MIN_DEPTH = 2;  // at least 1 move per side
const MAX_DEPTH = 8;  // 4 moves per side
const PRIOR_WEIGHT = 12;
const MIN_GAMES_FOR_CRITICAL_DROP = 5;
const MIN_DROP_PCT = 4;
const MAX_CRITICAL_DROPS = 3;
const MIN_GAMES_FOR_VULNERABLE_RESPONSE = 3;
const MAX_VULNERABLE_RESPONSES = 5;

function walkOpenings(
  isWhite: boolean,
  queryFn: QueryFn,
): OpeningLine[] {
  const lines: OpeningLine[] = [];
  const visited = new Set<string>(); // dedup transpositions

  function walk(
    chess: Chess,
    moves: string[],
    ucis: string[],
    depth: number,
  ): void {
    const fen = makeFen(chess.toSetup());
    const key = positionKey(fen);

    // Skip positions already explored via a different move order (transpositions)
    if (visited.has(key)) return;
    visited.add(key);

    const data = queryFn(fen);
    if (!data || data.moves.length === 0) {
      if (depth >= MIN_DEPTH) {
        collectLine(moves, ucis, fen);
      }
      return;
    }

    // Follow all moves (both user and opponent) with enough games.
    let anyFollowed = false;
    for (const m of data.moves) {
      const total = m.white + m.draws + m.black;
      if (total < MIN_GAMES_FOR_LINE) continue;

      const move = parseUci(m.uci);
      if (!move) continue;
      let san: string;
      try { san = makeSan(chess, move); } catch { continue; }

      anyFollowed = true;

      const next = chess.clone();
      next.play(move);

      if (depth >= MAX_DEPTH) {
        const afterFen = makeFen(next.toSetup());
        collectLine([...moves, san], [...ucis, m.uci], afterFen);
        continue;
      }

      walk(next, [...moves, san], [...ucis, m.uci], depth + 1);
    }

    if (!anyFollowed && depth >= MIN_DEPTH) {
      collectLine(moves, ucis, fen);
    }
  }

  function collectLine(moves: string[], ucis: string[], endFen: string): void {
    const label = moves.join(' ');
    if (lines.some(l => l.label === label)) return;
    // Also dedup by end position (transpositions that diverged at the last move)
    if (lines.some(l => l.endFen === endFen)) return;

    // W/D/L: use the specific last move's stats from its parent position
    const wdl = emptyWDL();
    if (ucis.length > 0) {
      const parentChess = Chess.default();
      for (let i = 0; i < ucis.length - 1; i++) {
        const m = parseUci(ucis[i]);
        if (m) parentChess.play(m);
      }
      const parentFen = makeFen(parentChess.toSetup());
      const parentData = queryFn(parentFen);
      if (parentData) {
        const lastUci = ucis[ucis.length - 1];
        const moveData = parentData.moves.find(m => m.uci === lastUci);
        if (moveData) {
          wdl.total = moveData.white + moveData.draws + moveData.black;
          if (isWhite) {
            wdl.wins = moveData.white;
            wdl.draws = moveData.draws;
            wdl.losses = moveData.black;
          } else {
            wdl.wins = moveData.black;
            wdl.draws = moveData.draws;
            wdl.losses = moveData.white;
          }
        }
      }
    }

    // Fallback: sum all continuations at end position
    if (wdl.total === 0) {
      const data = queryFn(endFen);
      if (data) {
        for (const m of data.moves) {
          wdl.total += m.white + m.draws + m.black;
          if (isWhite) {
            wdl.wins += m.white;
            wdl.draws += m.draws;
            wdl.losses += m.black;
          } else {
            wdl.wins += m.black;
            wdl.draws += m.draws;
            wdl.losses += m.white;
          }
        }
      }
    }

    const openingInfo = findOpeningForLine(endFen, ucis);
    const displayLabel = openingInfo
      ? openingInfo.name
      : label;

    lines.push({
      label,
      displayLabel,
      moves,
      ucis,
      wdl,
      winRate: winRate(wdl),
      endFen,
      color: isWhite ? 'white' : 'black',
      openingName: openingInfo?.name ?? null,
      eco: openingInfo?.eco ?? null,
      rawScorePct: scorePct(wdl),
      adjustedScorePct: scorePct(wdl),
      scoreCiPct: 0,
      confidence: 'low',
      deltaVsExpectedPct: null,
      impact: 0,
      exampleLinks: { wins: [], losses: [], draws: [], all: [] },
      criticalDrops: [],
      vulnerabilityContext: null,
      vulnerableResponses: [],
    });
  }

  const chess = Chess.default();
  walk(chess, [], [], 0);

  // Sort by game count descending
  lines.sort((a, b) => b.wdl.total - a.wdl.total);
  return lines;
}

function findOpeningForLine(endFen: string, ucis: string[]): { name: string; eco: string } | null {
  // Prefer the deepest known opening name reached along the line.
  const chess = Chess.default();
  let best: { name: string; eco: string } | null = null;

  for (const uci of ucis) {
    const move = parseUci(uci);
    if (!move) break;
    chess.play(move);
    const hit = findOpeningByFen(makeFen(chess.toSetup()));
    if (hit) best = hit;
  }

  if (best) return best;
  const endHit = findOpeningByFen(endFen);
  return endHit ? { name: endHit.name, eco: endHit.eco } : null;
}

function confidenceFromGames(total: number): 'high' | 'medium' | 'low' {
  if (total >= 40) return 'high';
  if (total >= 15) return 'medium';
  return 'low';
}

function expectedScore(userRating: number, oppRating: number): number | null {
  if (userRating <= 0 || oppRating <= 0) return null;
  return 1 / (1 + Math.pow(10, (oppRating - userRating) / 400));
}

function moveTotal(move: ExplorerMove): number {
  return move.white + move.draws + move.black;
}

function moveScoreRate(move: ExplorerMove, isWhite: boolean): number {
  const total = moveTotal(move);
  if (total === 0) return 0;
  const wins = isWhite ? move.white : move.black;
  return (wins + move.draws * 0.5) / total;
}

function aggregateScoreRate(data: ExplorerResponse, isWhite: boolean): number | null {
  let points = 0;
  let total = 0;

  for (const move of data.moves) {
    const games = moveTotal(move);
    if (games === 0) continue;
    const wins = isWhite ? move.white : move.black;
    points += wins + move.draws * 0.5;
    total += games;
  }

  if (total === 0) return null;
  return points / total;
}

function isUserMoveIndex(color: 'white' | 'black', moveIdx: number): boolean {
  return color === 'white' ? moveIdx % 2 === 0 : moveIdx % 2 === 1;
}

function buildLineFens(ucis: string[]): string[] | null {
  const chess = Chess.default();
  const fens = [makeFen(chess.toSetup())];

  for (const uci of ucis) {
    const move = parseUci(uci);
    if (!move) return null;
    chess.play(move);
    fens.push(makeFen(chess.toSetup()));
  }

  return fens;
}

function computeCriticalDrops(line: OpeningLine, queryFn: QueryFn): CriticalMoveDrop[] {
  if (line.ucis.length === 0) return [];
  const fens = buildLineFens(line.ucis);
  if (!fens) return [];

  const isWhite = line.color === 'white';
  const drops: CriticalMoveDrop[] = [];

  for (let i = 0; i < line.ucis.length; i++) {
    if (!isUserMoveIndex(line.color, i)) continue;

    const parentFen = fens[i];
    const data = queryFn(parentFen);
    if (!data || data.moves.length === 0) continue;

    const selected = data.moves.find(m => m.uci === line.ucis[i]);
    if (!selected) continue;

    const selectedGames = moveTotal(selected);
    if (selectedGames < MIN_GAMES_FOR_CRITICAL_DROP) continue;

    const parentScore = aggregateScoreRate(data, isWhite);
    if (parentScore == null) continue;

    const childScore = moveScoreRate(selected, isWhite);
    const drop = parentScore - childScore;
    const dropPct = Math.round(drop * 1000) / 10;
    if (dropPct < MIN_DROP_PCT) continue;

    drops.push({
      ply: i + 1,
      moveSan: line.moves[i] ?? selected.san,
      moveUci: line.ucis[i],
      parentScorePct: Math.round(parentScore * 1000) / 10,
      childScorePct: Math.round(childScore * 1000) / 10,
      dropPct,
      games: selectedGames,
    });
  }

  drops.sort((a, b) => b.dropPct - a.dropPct || b.games - a.games || a.ply - b.ply);
  return drops.slice(0, MAX_CRITICAL_DROPS);
}

function computeVulnerableResponses(
  line: OpeningLine,
  globalScore: number,
  queryFn: QueryFn,
): { context: VulnerabilityContext | null; responses: VulnerableResponse[] } {
  if (line.ucis.length === 0) return { context: null, responses: [] };
  const fens = buildLineFens(line.ucis);
  if (!fens) return { context: null, responses: [] };

  let contextMoveIdx = -1;
  for (let i = 0; i < line.ucis.length; i++) {
    if (isUserMoveIndex(line.color, i)) contextMoveIdx = i;
  }
  if (contextMoveIdx < 0) return { context: null, responses: [] };

  const contextPly = contextMoveIdx + 1;
  const contextFen = fens[contextPly];
  const data = queryFn(contextFen);
  if (!data || data.moves.length === 0) {
    return {
      context: {
        ply: contextPly,
        moveSan: line.moves[contextMoveIdx] ?? '',
      },
      responses: [],
    };
  }

  const isWhite = line.color === 'white';
  const nodeGames = data.moves.reduce((sum, move) => sum + moveTotal(move), 0);
  if (nodeGames === 0) {
    return {
      context: {
        ply: contextPly,
        moveSan: line.moves[contextMoveIdx] ?? '',
      },
      responses: [],
    };
  }

  const rows: VulnerableResponse[] = [];
  for (const move of data.moves) {
    const games = moveTotal(move);
    if (games < MIN_GAMES_FOR_VULNERABLE_RESPONSE) continue;

    const score = moveScoreRate(move, isWhite);
    const freq = games / nodeGames;
    const vulnerability = freq * Math.max(0, globalScore - score);
    if (vulnerability <= 0) continue;

    rows.push({
      moveSan: move.san,
      moveUci: move.uci,
      games,
      frequencyPct: Math.round(freq * 100),
      scorePct: Math.round(score * 100),
      vulnerability: Math.round(vulnerability * 10000) / 10000,
    });
  }

  rows.sort((a, b) => b.vulnerability - a.vulnerability || b.games - a.games);

  return {
    context: {
      ply: contextPly,
      moveSan: line.moves[contextMoveIdx] ?? '',
    },
    responses: rows.slice(0, MAX_VULNERABLE_RESPONSES),
  };
}

function getParentFenAndLastUci(ucis: string[]): { fen: string; uci: string } | null {
  if (ucis.length === 0) return null;
  const chess = Chess.default();
  for (let i = 0; i < ucis.length - 1; i++) {
    const move = parseUci(ucis[i]);
    if (!move) return null;
    chess.play(move);
  }
  return {
    fen: makeFen(chess.toSetup()),
    uci: ucis[ucis.length - 1],
  };
}

function buildLineExamples(
  indices: number[],
  getGameByIndex: GameByIndexFn,
): { wins: string[]; losses: string[]; draws: string[]; all: string[] } {
  const rows: { href: string; result: 'win' | 'draw' | 'loss'; month: string; idx: number }[] = [];

  for (const idx of indices) {
    const g = getGameByIndex(idx);
    if (!g?.gl) continue;
    rows.push({
      href: g.gl,
      result: userResult(g),
      month: g.mo ?? '',
      idx,
    });
  }

  // Most recent first (month desc, then index desc as stable fallback)
  rows.sort((a, b) => {
    const am = a.month && a.month !== 'unknown' ? a.month : '';
    const bm = b.month && b.month !== 'unknown' ? b.month : '';
    if (am !== bm) return bm.localeCompare(am);
    return b.idx - a.idx;
  });

  const all = rows.map(r => r.href);
  const wins = rows.filter(r => r.result === 'win').map(r => r.href);
  const losses = rows.filter(r => r.result === 'loss').map(r => r.href);
  const draws = rows.filter(r => r.result === 'draw').map(r => r.href);

  return { wins, losses, draws, all };
}

function adjustedScore(raw: number, total: number, globalScore: number): number {
  return total > 0
    ? ((raw * total) + (globalScore * PRIOR_WEIGHT)) / (total + PRIOR_WEIGHT)
    : globalScore;
}

function lineKey(line: OpeningLine): string {
  return `${line.color}|${line.label}`;
}

function pickTopLines(
  sorted: OpeningLine[],
  count: number,
  avoid: Set<string> = new Set(),
): OpeningLine[] {
  const out: OpeningLine[] = [];
  const used = new Set<string>();

  for (const line of sorted) {
    const key = lineKey(line);
    if (avoid.has(key) || used.has(key)) continue;
    out.push(line);
    used.add(key);
    if (out.length >= count) break;
  }

  // Backfill in case avoid-filter removed too many.
  if (out.length < count) {
    for (const line of sorted) {
      const key = lineKey(line);
      if (used.has(key)) continue;
      out.push(line);
      used.add(key);
      if (out.length >= count) break;
    }
  }

  return out;
}

function thirdStickout(
  sorted: OpeningLine[],
  valueOf: (line: OpeningLine) => number,
): number {
  if (sorted.length < 3) return Number.NEGATIVE_INFINITY;
  if (sorted.length === 3) return Number.POSITIVE_INFINITY;
  return valueOf(sorted[2]) - valueOf(sorted[3]);
}

function enrichOpeningLines(
  lines: OpeningLine[],
  globalScore: number,
  queryFn: QueryFn,
  moveGameIndicesFn?: MoveGameIndicesFn,
  gameByIndexFn?: GameByIndexFn,
): void {
  for (const line of lines) {
    const total = line.wdl.total;
    const raw = scoreRate(line.wdl);
    const adj = adjustedScore(raw, total, globalScore);
    const ci = total > 0 ? 1.96 * Math.sqrt((adj * (1 - adj)) / total) : 0;

    line.rawScorePct = Math.round(raw * 100);
    line.adjustedScorePct = Math.round(adj * 100);
    line.scoreCiPct = Math.round(ci * 1000) / 10;
    line.confidence = confidenceFromGames(total);
    line.impact = Math.round(Math.max(0, globalScore - adj) * total * 100) / 100;
    line.criticalDrops = computeCriticalDrops(line, queryFn);
    const vulnerability = computeVulnerableResponses(line, globalScore, queryFn);
    line.vulnerabilityContext = vulnerability.context;
    line.vulnerableResponses = vulnerability.responses;

    if (!moveGameIndicesFn || !gameByIndexFn || line.ucis.length === 0) continue;
    const parent = getParentFenAndLastUci(line.ucis);
    if (!parent) continue;
    const indices = moveGameIndicesFn(parent.fen, parent.uci);
    if (indices.length === 0) continue;

    const expected: number[] = [];
    for (const idx of indices) {
      const g = gameByIndexFn(idx);
      if (!g) continue;
      const e = expectedScore(g.ur, g.or);
      if (e == null) continue;
      expected.push(e);
    }
    if (expected.length > 0) {
      const expectedAvg = expected.reduce((a, b) => a + b, 0) / expected.length;
      line.deltaVsExpectedPct = Math.round((raw - expectedAvg) * 100);
    }

    line.exampleLinks = buildLineExamples(indices, gameByIndexFn);
  }
}

// ── Main Report Generation ──

export function generateReport(
  games: readonly GameMeta[],
  queryFn: QueryFn,
  syncColorFilter?: (color: 'white' | 'black' | null) => void,
  moveGameIndicesFn?: MoveGameIndicesFn,
  gameByIndexFn?: GameByIndexFn,
  sideFilter?: 'white' | 'black',
): ReportData {
  const overall = emptyWDL();
  const asWhite = emptyWDL();
  const asBlack = emptyWDL();
  const tcMap = new Map<string, WDL>();
  const monthMap = new Map<string, { totalRating: number; count: number }>();

  // Single pass through games
  for (const game of games) {
    const result = userResult(game);
    addResult(overall, result);

    if (game.uw) {
      addResult(asWhite, result);
    } else {
      addResult(asBlack, result);
    }

    // By time control
    let tcWdl = tcMap.get(game.tc);
    if (!tcWdl) {
      tcWdl = emptyWDL();
      tcMap.set(game.tc, tcWdl);
    }
    addResult(tcWdl, result);

    // Monthly rating
    if (game.ur > 0) {
      const existing = monthMap.get(game.mo);
      if (existing) {
        existing.totalRating += game.ur;
        existing.count++;
      } else {
        monthMap.set(game.mo, { totalRating: game.ur, count: 1 });
      }
    }
  }

  // Time control stats
  const byTimeControl: TimeControlStats[] = [];
  for (const [tc, wdl] of tcMap) {
    byTimeControl.push({ timeClass: tc, wdl, winRate: winRate(wdl) });
  }
  const tcOrder = Object.fromEntries(sortTimeClasses([...tcMap.keys()]).map((k, i) => [k, i]));
  byTimeControl.sort((a, b) => (tcOrder[a.timeClass] ?? 99) - (tcOrder[b.timeClass] ?? 99));

  // Rating trend
  const ratingTrend: MonthlyRating[] = [];
  for (const [month, data] of monthMap) {
    ratingTrend.push({
      month,
      avgRating: Math.round(data.totalRating / data.count),
      gameCount: data.count,
    });
  }
  ratingTrend.sort((a, b) => a.month.localeCompare(b.month));

  // Opening trees — filter by color so we only see games where the user played that side
  const globalScore = scoreRate(overall);
  let whiteOpenings: OpeningLine[] = [];
  let blackOpenings: OpeningLine[] = [];

  if (sideFilter !== 'black') {
    syncColorFilter?.('white');
    whiteOpenings = walkOpenings(true, queryFn);
    enrichOpeningLines(whiteOpenings, globalScore, queryFn, moveGameIndicesFn, gameByIndexFn);
  }

  if (sideFilter !== 'white') {
    syncColorFilter?.('black');
    blackOpenings = walkOpenings(false, queryFn);
    enrichOpeningLines(blackOpenings, globalScore, queryFn, moveGameIndicesFn, gameByIndexFn);
  }

  syncColorFilter?.(null);

  // Key findings: lines with >= 10 games, best by adjusted score, weak by impact
  const MIN_GAMES_FOR_FINDING = 10;
  const allLines = [
    ...whiteOpenings.filter(l => l.wdl.total >= MIN_GAMES_FOR_FINDING),
    ...blackOpenings.filter(l => l.wdl.total >= MIN_GAMES_FOR_FINDING),
  ];

  // Positive training value for "what works":
  // How far above baseline this line is, scaled by how often it occurs.
  const highlightStrength = (line: OpeningLine): number => {
    const raw = scoreRate(line.wdl);
    const adj = adjustedScore(raw, line.wdl.total, globalScore);
    return Math.max(0, adj - globalScore) * line.wdl.total;
  };

  const scoreSorted = [...allLines]
    .sort((a, b) =>
      b.adjustedScorePct - a.adjustedScorePct ||
      b.rawScorePct - a.rawScorePct ||
      b.wdl.total - a.wdl.total
    );

  const weightedSorted = [...allLines]
    .sort((a, b) =>
      highlightStrength(b) - highlightStrength(a) ||
      b.adjustedScorePct - a.adjustedScorePct ||
      b.rawScorePct - a.rawScorePct ||
      b.wdl.total - a.wdl.total
    );

  const scoreStickout = thirdStickout(scoreSorted, l => l.adjustedScorePct);
  const weightedStickout = thirdStickout(weightedSorted, l => highlightStrength(l));

  const scoreTarget = weightedStickout > scoreStickout ? 2 : 3;
  const weightedTarget = weightedStickout > scoreStickout ? 3 : 2;

  let bestScoreOpenings: OpeningLine[];
  let bestOpenings: OpeningLine[];

  if (scoreTarget >= weightedTarget) {
    bestScoreOpenings = pickTopLines(scoreSorted, scoreTarget);
    bestOpenings = pickTopLines(
      weightedSorted,
      weightedTarget,
      new Set(bestScoreOpenings.map(lineKey)),
    );
  } else {
    bestOpenings = pickTopLines(weightedSorted, weightedTarget);
    bestScoreOpenings = pickTopLines(
      scoreSorted,
      scoreTarget,
      new Set(bestOpenings.map(lineKey)),
    );
  }

  const worstOpenings = [...allLines]
    .filter(l => l.impact > 0)
    .sort((a, b) =>
      b.impact - a.impact ||
      a.adjustedScorePct - b.adjustedScorePct ||
      b.wdl.total - a.wdl.total
    )
    .slice(0, 3);

  const weaknessQueue = [...whiteOpenings, ...blackOpenings]
    .filter(l => l.wdl.total >= 8 && l.impact > 0)
    .sort((a, b) =>
      b.impact - a.impact ||
      a.adjustedScorePct - b.adjustedScorePct ||
      b.wdl.total - a.wdl.total
    )
    .slice(0, 5);

  return {
    totalGames: games.length,
    overall,
    overallWinRate: winRate(overall),
    asWhite,
    asBlack,
    byTimeControl,
    ratingTrend,
    whiteOpenings,
    blackOpenings,
    weaknessQueue,
    bestScoreOpenings,
    bestOpenings,
    worstOpenings,
  };
}
