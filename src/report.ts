import { sortTimeClasses } from './personal-explorer';
import type { GameMeta } from './personal-explorer';
import type { ExplorerResponse } from './types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';

// ── Types ──

export interface WDL {
  wins: number;
  draws: number;
  losses: number;
  total: number;
}

export interface OpeningLine {
  label: string;
  moves: string[];   // SAN
  ucis: string[];     // UCI
  wdl: WDL;
  winRate: number;
  endFen: string;
  color: 'white' | 'black';
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

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

// ── Opening Tree Walk ──

type QueryFn = (fen: string) => ExplorerResponse | null;

const MIN_GAMES_FOR_LINE = 5;
const MIN_DEPTH = 2;  // at least 1 move per side
const MAX_DEPTH = 8;  // 4 moves per side

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

    lines.push({
      label,
      moves,
      ucis,
      wdl,
      winRate: winRate(wdl),
      endFen,
      color: isWhite ? 'white' : 'black',
    });
  }

  const chess = Chess.default();
  walk(chess, [], [], 0);

  // Sort by game count descending
  lines.sort((a, b) => b.wdl.total - a.wdl.total);
  return lines;
}

// ── Main Report Generation ──

export function generateReport(
  games: readonly GameMeta[],
  queryFn: QueryFn,
  syncColorFilter?: (color: 'white' | 'black' | null) => void,
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
  syncColorFilter?.('white');
  const whiteOpenings = walkOpenings(true, queryFn);
  syncColorFilter?.('black');
  const blackOpenings = walkOpenings(false, queryFn);
  syncColorFilter?.(null);

  // Key findings: lines with >= 10 games, top/bottom 3 by win rate
  const MIN_GAMES_FOR_FINDING = 10;
  const allLines = [
    ...whiteOpenings.filter(l => l.wdl.total >= MIN_GAMES_FOR_FINDING),
    ...blackOpenings.filter(l => l.wdl.total >= MIN_GAMES_FOR_FINDING),
  ];

  const sorted = [...allLines].sort((a, b) => b.winRate - a.winRate);
  const bestOpenings = sorted.slice(0, 3);
  const worstOpenings = sorted.length > 3
    ? sorted.slice(-3).reverse()
    : [];

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
    bestOpenings,
    worstOpenings,
  };
}
