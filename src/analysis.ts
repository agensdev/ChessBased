import type { ExplorerMove, PositionAnalysis, MoveBadge } from './types';
import { DEFAULT_THRESHOLDS } from './types';

interface MoveStats {
  uci: string;
  total: number;
  winPct: number;
  popularity: number; // % of total games across all moves
}

function computeStats(moves: ExplorerMove[], sideToMove: 'w' | 'b', minGames: number): MoveStats[] {
  const grandTotal = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
  const result: MoveStats[] = [];

  for (const m of moves) {
    const total = m.white + m.draws + m.black;
    if (total < minGames) continue;

    const wins = sideToMove === 'w' ? m.white : m.black;
    const winPct = (wins + 0.5 * m.draws) / total * 100;
    const popularity = grandTotal > 0 ? (total / grandTotal) * 100 : 0;

    result.push({ uci: m.uci, total, winPct, popularity });
  }

  return result;
}

export interface ParentContext {
  parentMoves: ExplorerMove[];
  playedUci: string;
  parentSide: 'w' | 'b';
}

export function analyzePosition(
  moves: ExplorerMove[],
  sideToMove: 'w' | 'b',
  parentContext?: ParentContext,
  evalWinPct?: number,
): PositionAnalysis {
  const thresholds = DEFAULT_THRESHOLDS;
  const stats = computeStats(moves, sideToMove, thresholds.minGames);
  const badges = new Map<string, MoveBadge>();

  if (stats.length === 0) {
    return { alert: null, bestMoveUci: null, bestWinPct: 0, moveBadges: badges };
  }

  // Check if the move that led to this position was a blunder
  let incomingWasBlunder = false;
  if (parentContext) {
    const parentStats = computeStats(parentContext.parentMoves, parentContext.parentSide, thresholds.minGames);
    if (parentStats.length > 0) {
      const parentSorted = [...parentStats].sort((a, b) => b.winPct - a.winPct);
      const parentBest = parentSorted[0];
      const played = parentStats.find(m => m.uci === parentContext.playedUci);
      if (played) {
        const deficit = parentBest.winPct - played.winPct;
        if (deficit >= thresholds.blunderDeficit) {
          incomingWasBlunder = true;
        }
      }
    }
  }

  const sorted = [...stats].sort((a, b) => b.winPct - a.winPct);
  const best = sorted[0];
  const avgWinPct = stats.reduce((s, m) => s + m.winPct, 0) / stats.length;

  // Use engine eval if available, otherwise fall back to comfort threshold
  const positionWinPct = evalWinPct ?? best.winPct;
  const isComfortable = positionWinPct >= thresholds.comfortThreshold;

  // Spread check gates whether any danger/opportunity alert fires
  const hasSpread = best.winPct - avgWinPct >= thresholds.spreadThreshold;

  // Classify using eval comparison when available:
  //   bestWinPct > evalWinPct → Opportunity (move outperforms the position's objective value)
  //   bestWinPct <= evalWinPct → Danger (best move just maintains, miss it and you lose ground)
  // Fallback without eval: comfortable position → Danger, otherwise → Opportunity
  let isDanger = false;
  let isOpportunity = false;

  if (hasSpread && !incomingWasBlunder) {
    if (evalWinPct != null) {
      isOpportunity = best.winPct > evalWinPct;
      isDanger = !isOpportunity;
    } else {
      isDanger = isComfortable;
      isOpportunity = !isDanger;
    }
  }

  // Trap: a popular move is a hidden mistake
  let trapUci: string | null = null;
  for (const m of stats) {
    if (m.popularity >= thresholds.popularThresholdPct && avgWinPct - m.winPct >= thresholds.blunderDeficit) {
      trapUci = m.uci;
      break;
    }
  }
  const isTrap = trapUci !== null;

  // Priority: danger > opportunity > trap
  let alert: PositionAnalysis['alert'] = null;
  if (isDanger) alert = 'danger';
  else if (isOpportunity) alert = 'opportunity';
  else if (isTrap) alert = 'trap';

  // Assign per-move badges
  for (const m of stats) {
    let badge: MoveBadge = 'book';

    if ((isDanger || isOpportunity) && m.uci === best.uci) {
      badge = 'best';
    } else if (m.uci === trapUci) {
      badge = 'trap';
    } else if (best.winPct - m.winPct >= thresholds.blunderDeficit) {
      badge = 'blunder';
    }

    badges.set(m.uci, badge);
  }

  return { alert, bestMoveUci: best.uci, bestWinPct: best.winPct, moveBadges: badges };
}

export function getBadgeForMove(analysis: PositionAnalysis, uci: string): MoveBadge {
  return analysis.moveBadges.get(uci) ?? null;
}
