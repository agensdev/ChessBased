import assert from 'node:assert/strict';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';
import type { ExplorerResponse } from '../src/types';
import type { GameMeta } from '../src/personal-explorer';
import { generateReport, type LineAggregationMode, type OpeningLine } from '../src/report';

type MoveCounts = { white: number; draws: number; black: number };

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function uciLineToSanLabel(ucis: readonly string[]): string {
  const chess = Chess.default();
  const out: string[] = [];
  for (const uci of ucis) {
    const move = parseUci(uci);
    if (!move) break;
    out.push(makeSan(chess, move));
    chess.play(move);
  }
  return out.join(' ');
}

function buildQueryFn(games: readonly GameMeta[]): (fen: string) => ExplorerResponse | null {
  const positions = new Map<string, Map<string, MoveCounts>>();

  for (const game of games) {
    if (!game.mv) continue;
    const ucis = game.mv.split(/\s+/).filter(Boolean);
    if (ucis.length === 0) continue;

    const chess = Chess.default();
    for (const uci of ucis) {
      const move = parseUci(uci);
      if (!move) break;

      const key = positionKey(makeFen(chess.toSetup()));
      let moveMap = positions.get(key);
      if (!moveMap) {
        moveMap = new Map();
        positions.set(key, moveMap);
      }
      let counts = moveMap.get(uci);
      if (!counts) {
        counts = { white: 0, draws: 0, black: 0 };
        moveMap.set(uci, counts);
      }
      if (game.re === 'w') counts.white++;
      else if (game.re === 'd') counts.draws++;
      else counts.black++;

      chess.play(move);
    }
  }

  return (fen: string): ExplorerResponse | null => {
    const moveMap = positions.get(positionKey(fen));
    if (!moveMap || moveMap.size === 0) return null;
    const moves = [...moveMap.entries()]
      .map(([uci, c]) => ({
        uci,
        san: uci,
        white: c.white,
        draws: c.draws,
        black: c.black,
        averageRating: 0,
      }))
      .sort((a, b) => (b.white + b.draws + b.black) - (a.white + a.draws + a.black));
    return { moves };
  };
}

function makeGame(idx: number, mv: string, result: 'w' | 'b' | 'd'): GameMeta {
  const day = String((idx % 28) + 1).padStart(2, '0');
  return {
    tc: 'blitz',
    ur: 1600,
    or: 1600,
    mo: '2026-02',
    da: `2026-02-${day}`,
    re: result,
    uw: true,
    mv,
    gl: `https://example.test/game/${idx}`,
    op: 'opponent',
  };
}

function addBatch(
  games: GameMeta[],
  startIdx: number,
  ucis: readonly string[],
  wins: number,
  losses: number,
): number {
  const mv = ucis.join(' ');
  let idx = startIdx;
  for (let i = 0; i < wins; i++) games.push(makeGame(idx++, mv, 'w'));
  for (let i = 0; i < losses; i++) games.push(makeGame(idx++, mv, 'b'));
  return idx;
}

function findLineByEndPosition(lines: readonly OpeningLine[], endKey: string): OpeningLine {
  const hit = lines.find(l => positionKey(l.endFen) === endKey);
  assert(hit, `Expected a line ending in position ${endKey}`);
  return hit;
}

function runScenario(mode: LineAggregationMode, games: readonly GameMeta[], targetPosKey: string): OpeningLine {
  const queryFn = buildQueryFn(games);
  const report = generateReport(games, queryFn, undefined, undefined, undefined, 'white', mode);
  const line = findLineByEndPosition(report.whiteOpenings, targetPosKey);
  const weakFamilies = report.whiteFamilyReport?.weakFamilies ?? [];
  const weak = weakFamilies.find(f => positionKey(f.baseLine.endFen) === targetPosKey);
  assert(weak, `Expected target line to be in weak families for mode=${mode}`);
  return line;
}

function main(): void {
  // Two transposed move orders that reach the same Lucchini Gambit position.
  const lineA = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f7f5'];
  const lineB = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'g1f3', 'f7f5'];
  // Control line to raise baseline, so Lucchini shows as a weakness.
  const control = ['d2d4', 'd7d5', 'c2c4', 'e7e6'];

  const lineALabel = uciLineToSanLabel(lineA);
  const lineBLabel = uciLineToSanLabel(lineB);
  const lineANormalizedLabel = uciLineToSanLabel(lineA.slice(0, 5));
  const lineBNormalizedLabel = uciLineToSanLabel(lineB.slice(0, 5));

  const games: GameMeta[] = [];
  let idx = 1;
  // 100 games total for each transposed branch:
  // A: 25W / 75L, B: 5W / 95L
  idx = addBatch(games, idx, lineA, 25, 75);
  idx = addBatch(games, idx, lineB, 5, 95);
  // Strong control branch (100 games, 90W / 10L).
  idx = addBatch(games, idx, control, 90, 10);
  void idx;

  // Report opening lines for white are normalized to end on white's move.
  // So target the position after 5 plies (before ...f5 is played).
  const chess = Chess.default();
  for (const uci of lineA.slice(0, 5)) {
    const move = parseUci(uci);
    assert(move, `Invalid UCI in lineA: ${uci}`);
    chess.play(move);
  }
  const targetPosKey = positionKey(makeFen(chess.toSetup()));

  const lineMode = runScenario('line', games, targetPosKey);
  const positionMode = runScenario('position', games, targetPosKey);

  assert.equal(lineMode.wdl.total, 100, 'line mode should keep one representative path at this node');
  assert(
    (lineMode.wdl.wins === 25 && lineMode.wdl.losses === 75)
      || (lineMode.wdl.wins === 5 && lineMode.wdl.losses === 95),
    'line mode should reflect one path (25/75 or 5/95)',
  );

  assert.equal(positionMode.wdl.wins, 30, 'position mode should pool both paths');
  assert.equal(positionMode.wdl.losses, 170, 'position mode should pool both paths');
  assert.equal(positionMode.wdl.total, 200, 'position mode total should pool both paths');
  assert.notDeepEqual(lineMode.wdl, positionMode.wdl, 'line vs position should differ in this scenario');

  assert(lineMode.transpositionLabels.length > 0, 'expected transposition labels to be attached');
  assert(
    lineMode.transpositionLabels.includes(lineANormalizedLabel) || lineMode.transpositionLabels.includes(lineBNormalizedLabel),
    'expected the alternate move order to be listed as a transposition',
  );

  console.log('Transposition test (100 + 100 games) passed.');
  console.log(`Line A: ${lineALabel} -> 25W/75L`);
  console.log(`Line B: ${lineBLabel} -> 5W/95L`);
  console.log('Observed result at the normalized weakness node (before ...f5):');
  console.log(`- Line mode (single representative path): ${lineMode.wdl.wins}W ${lineMode.wdl.losses}L (${lineMode.wdl.total})`);
  console.log(`- Position mode (transposition pooled): ${positionMode.wdl.wins}W ${positionMode.wdl.losses}L (${positionMode.wdl.total})`);
  console.log(`Representative line label: ${lineMode.label}`);
  console.log(`Alternative transpositions: ${lineMode.transpositionLabels.join(' | ')}`);
}

main();
