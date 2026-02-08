import type {
  AppConfig,
  ExplorerResponse,
  GamePhase,
  MoveHistoryEntry,
} from './types';
import {
  initBoard,
  playBotMove,
  getFen,
  getTurn,
  isGameOver,
  isViewingHistory,
  truncateToView,
  resetBoard,
  setOrientation,
} from './board';
import { queryExplorer } from './explorer';
import { selectBotMove } from './bot';

let phase: GamePhase = 'USER_TURN';
let config: AppConfig;

let currentExplorerData: ExplorerResponse | null = null;
let currentExplorerFen: string = '';

// Cache explorer responses to avoid re-fetching when navigating
const explorerCache = new Map<string, ExplorerResponse>();

type PhaseListener = (phase: GamePhase) => void;
type ExplorerListener = () => void;
type MoveListener = () => void;

let onPhaseChange: PhaseListener | null = null;
let onExplorerUpdate: ExplorerListener | null = null;
let onMoveUpdate: MoveListener | null = null;

export function setListeners(
  phaseCb: PhaseListener,
  explorerCb: ExplorerListener,
  moveCb: MoveListener,
): void {
  onPhaseChange = phaseCb;
  onExplorerUpdate = explorerCb;
  onMoveUpdate = moveCb;
}

function setPhase(p: GamePhase): void {
  phase = p;
  onPhaseChange?.(p);
}

export function getPhase(): GamePhase {
  return phase;
}

export function getExplorerData(): { data: ExplorerResponse | null; fen: string } {
  return { data: currentExplorerData, fen: currentExplorerFen };
}

/** Returns the color the bot plays, or null if manual mode */
function botColor(): 'white' | 'black' | null {
  if (config.playerColor === 'white') return 'black';
  if (config.playerColor === 'black') return 'white';
  return null;
}

/** Should the bot play right now? */
function shouldBotPlay(): boolean {
  const bot = botColor();
  return bot !== null && getTurn() === bot;
}

export function startGame(
  boardElement: HTMLElement,
  appConfig: AppConfig,
): void {
  config = appConfig;
  currentExplorerData = null;
  currentExplorerFen = '';
  explorerCache.clear();

  const boardColor = config.playerColor === 'both' ? 'white' : config.playerColor;
  initBoard(boardElement, boardColor, onUserMove);
  setPhase('USER_TURN');

  if (shouldBotPlay()) {
    doBotTurn();
  } else {
    fetchExplorerForFen(getFen());
  }
}

export function newGame(appConfig: AppConfig): void {
  config = appConfig;
  currentExplorerData = null;
  currentExplorerFen = '';
  explorerCache.clear();

  const boardColor = config.playerColor === 'both' ? 'white' : config.playerColor;
  resetBoard(boardColor);
  setPhase('USER_TURN');
  onMoveUpdate?.();
  onExplorerUpdate?.();

  if (shouldBotPlay()) {
    doBotTurn();
  } else {
    fetchExplorerForFen(getFen());
  }
}

export async function fetchExplorerForFen(fen: string): Promise<ExplorerResponse | null> {
  // Check cache first
  const cached = explorerCache.get(fen);
  if (cached) {
    currentExplorerData = cached;
    currentExplorerFen = fen;
    onExplorerUpdate?.();
    return cached;
  }

  try {
    const data = await queryExplorer(fen, config);
    if (data) {
      explorerCache.set(fen, data);
    }
    currentExplorerData = data;
    currentExplorerFen = fen;
    onExplorerUpdate?.();
    return data;
  } catch {
    currentExplorerData = null;
    currentExplorerFen = fen;
    onExplorerUpdate?.();
    return null;
  }
}

async function onUserMove(_entry: MoveHistoryEntry): Promise<void> {
  onMoveUpdate?.();

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  if (shouldBotPlay()) {
    await doBotTurn();
  } else {
    setPhase('USER_TURN');
    await fetchExplorerForFen(getFen());
  }
}

async function doBotTurn(): Promise<void> {
  setPhase('BOT_THINKING');

  const data = await fetchExplorerForFen(getFen());

  if (!data || data.moves.length === 0) {
    setPhase('OUT_OF_BOOK');
    return;
  }

  const selected = selectBotMove(data.moves, getFen(), config.topMoves, config.botWeighting === 'weighted', config.botMinPlayRatePct);
  if (!selected) {
    setPhase('OUT_OF_BOOK');
    return;
  }

  const delay = 300 + Math.random() * 400;
  await new Promise((r) => setTimeout(r, delay));

  playBotMove(selected.uci);
  onMoveUpdate?.();

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  setPhase('USER_TURN');
  await fetchExplorerForFen(getFen());
}

export async function playExplorerMove(uci: string): Promise<void> {
  if (isViewingHistory()) {
    if (!truncateToView()) return;
  }

  const entry = playBotMove(uci);
  if (!entry) return;

  onMoveUpdate?.();

  if (isGameOver()) {
    setPhase('GAME_OVER');
    return;
  }

  if (shouldBotPlay()) {
    await doBotTurn();
  } else {
    setPhase('USER_TURN');
    await fetchExplorerForFen(getFen());
  }
}

export async function continueFromHere(): Promise<void> {
  if (!isViewingHistory()) return;
  if (!truncateToView()) return;

  onMoveUpdate?.();

  if (shouldBotPlay()) {
    await doBotTurn();
  } else {
    setPhase('USER_TURN');
    await fetchExplorerForFen(getFen());
  }
}

export function getExplorerCache(): Map<string, ExplorerResponse> {
  return explorerCache;
}

export function updateConfig(newConfig: AppConfig): void {
  const oldColor = config.playerColor;
  const explorerParamsChanged =
    JSON.stringify(newConfig.ratings) !== JSON.stringify(config.ratings) ||
    JSON.stringify(newConfig.speeds) !== JSON.stringify(config.speeds);
  config = newConfig;

  if (explorerParamsChanged) {
    explorerCache.clear();
    fetchExplorerForFen(getFen());
  }

  // Update board orientation if mode changed
  if (newConfig.playerColor !== oldColor) {
    const boardColor = newConfig.playerColor === 'both' ? 'white' : newConfig.playerColor;
    setOrientation(boardColor);

    // If the bot should now play in the current position, trigger it
    if (!isViewingHistory() && !isGameOver() && shouldBotPlay() && phase !== 'BOT_THINKING') {
      doBotTurn();
    }
  }
}
