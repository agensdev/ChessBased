import { Chess, parseUci } from 'chessops';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { getActiveStore, getActiveOpening, FREE_PLAY_NAME, positionKey } from './repertoire';

export interface TreeNode {
  san: string;
  uci: string;
  fen: string;
  moveNumber: number;
  isBlack: boolean;
  children: TreeNode[];
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function buildRepertoireTree(): TreeNode[] {
  if (getActiveOpening() === FREE_PLAY_NAME) return [];

  const store = getActiveStore();
  const visited = new Set<string>();
  return buildChildren(STARTING_FEN, 1, false, store, visited);
}

export function buildTreeFromStore(store: Readonly<Record<string, { lockedMoves: string[] }>>): TreeNode[] {
  return buildChildren(STARTING_FEN, 1, false, store, new Set());
}

function buildChildren(
  fen: string,
  moveNumber: number,
  isBlackTurn: boolean,
  store: Readonly<Record<string, { lockedMoves: string[] }>>,
  visited: Set<string>,
): TreeNode[] {
  const key = positionKey(fen);
  const entry = store[key];
  if (!entry || entry.lockedMoves.length === 0) return [];

  // Prevent cycles
  if (visited.has(key)) return [];
  visited.add(key);

  const setup = parseFen(fen);
  if (!setup.isOk) return [];
  const pos = Chess.fromSetup(setup.value);
  if (!pos.isOk) return [];

  const nodes: TreeNode[] = [];

  for (const uci of entry.lockedMoves) {
    const move = parseUci(uci);
    if (!move) continue;

    const chess = pos.value.clone();
    const san = makeSan(chess, move);
    chess.play(move);
    const resultFen = makeFen(chess.toSetup());

    const nextMoveNumber = isBlackTurn ? moveNumber + 1 : moveNumber;
    const node: TreeNode = {
      san,
      uci,
      fen: resultFen,
      moveNumber,
      isBlack: isBlackTurn,
      children: buildChildren(resultFen, nextMoveNumber, !isBlackTurn, store, new Set(visited)),
    };
    nodes.push(node);
  }

  visited.delete(key);
  return nodes;
}
