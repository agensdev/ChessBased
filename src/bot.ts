import type { ExplorerMove } from './types';
import { getLockedMoves } from './repertoire';

function totalGames(move: ExplorerMove): number {
  return move.white + move.draws + move.black;
}

export function selectBotMove(
  moves: ExplorerMove[],
  fen: string,
  topN: number,
  weighted: boolean,
  minPlayRatePct: number,
): ExplorerMove | null {
  if (moves.length === 0) return null;

  const locked = getLockedMoves(fen);

  let candidates: ExplorerMove[];
  if (locked.length > 0) {
    candidates = moves.filter((m) => locked.includes(m.uci));
    if (candidates.length === 0) {
      candidates = filterCandidates(moves, topN, minPlayRatePct);
    }
  } else {
    candidates = filterCandidates(moves, topN, minPlayRatePct);
  }

  if (candidates.length === 0) return null;

  if (!weighted) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  const weights = candidates.map(totalGames);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  if (totalWeight === 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  let roll = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }

  return candidates[candidates.length - 1];
}

function filterCandidates(moves: ExplorerMove[], topN: number, minPlayRatePct: number): ExplorerMove[] {
  const top = moves.slice(0, topN);
  const grandTotal = top.reduce((s, m) => s + totalGames(m), 0);
  if (grandTotal === 0) return top.slice(0, 1);

  const filtered = top.filter((m) => (totalGames(m) / grandTotal) * 100 >= minPlayRatePct);
  return filtered.length > 0 ? filtered : top.slice(0, 1);
}
