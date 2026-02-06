import { parsePgn, startingPosition, walk, Box } from 'chessops/pgn';
import type { PgnNodeData } from 'chessops/pgn';
import type { Position } from 'chessops';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { makeUci } from 'chessops';
import { lockMove, positionKey } from './repertoire';

export interface ImportResult {
  positions: number;
  moves: number;
  errors: string[];
}

export function importPgn(pgn: string): ImportResult {
  const games = parsePgn(pgn);
  const seen = new Set<string>();
  let moveCount = 0;
  const errors: string[] = [];

  for (let gi = 0; gi < games.length; gi++) {
    const game = games[gi];
    const posResult = startingPosition(game.headers);
    if (!posResult.isOk) {
      errors.push(`Game ${gi + 1}: invalid starting position`);
      continue;
    }

    walk(game.moves, new Box(posResult.value), (ctx, node: PgnNodeData) => {
      const pos: Position = ctx.value;
      const move = parseSan(pos, node.san);
      if (!move) {
        errors.push(`Game ${gi + 1}: illegal move "${node.san}"`);
        return;
      }

      const fen = makeFen(pos.toSetup());
      const uci = makeUci(move);
      const key = `${positionKey(fen)}|${uci}`;
      if (!seen.has(key)) {
        seen.add(key);
        lockMove(fen, uci);
        moveCount++;
      }

      pos.play(move);
    });
  }

  return {
    positions: new Set([...seen].map(k => k.split('|')[0])).size,
    moves: moveCount,
    errors,
  };
}
