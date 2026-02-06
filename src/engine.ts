export interface EvalScore {
  type: 'cp' | 'mate';
  value: number; // centipawns or moves to mate (negative = black advantage)
  depth: number;
}

type EvalCallback = (score: EvalScore) => void;

const SEARCH_DEPTH = 18;
const STOP_TIMEOUT_MS = 10_000;

// --- Deferred promise helper ---

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// --- Engine state ---

let worker: Worker | null = null;
let idle: Deferred<void> = deferred(); // resolves when engine is idle (no search running)
let searching = false;
let queued: { fen: string; onUpdate: EvalCallback } | null = null;
let currentCallback: EvalCallback | null = null;
let stopTimeout: ReturnType<typeof setTimeout> | null = null;
let stopping: Promise<void> | null = null; // non-null while waiting for stop to complete

// Start idle
idle.resolve();

function send(cmd: string): void {
  worker?.postMessage(cmd);
}

function onMessage(e: MessageEvent): void {
  const line: string = e.data;

  if (line === 'readyok') {
    return; // handled by waitReady
  }

  if (line.startsWith('info') && line.includes(' score ') && currentCallback) {
    const score = parseScore(line);
    if (score) currentCallback(score);
  }

  if (line.startsWith('bestmove')) {
    searching = false;
    if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null; }
    idle.resolve();

    // If a new eval was queued while we waited, start it now
    if (queued) {
      const { fen, onUpdate } = queued;
      queued = null;
      startSearch(fen, onUpdate);
    }
  }
}

function parseScore(line: string): EvalScore | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const depth = depthMatch ? parseInt(depthMatch[1]) : 0;

  if (cpMatch) return { type: 'cp', value: parseInt(cpMatch[1]), depth };
  if (mateMatch) return { type: 'mate', value: parseInt(mateMatch[1]), depth };
  return null;
}

function waitReady(): Promise<void> {
  const d = deferred<void>();
  const handler = (e: MessageEvent) => {
    if (e.data === 'readyok') {
      worker!.removeEventListener('message', handler);
      d.resolve();
    }
  };
  worker!.addEventListener('message', handler);
  send('isready');
  return d.promise;
}

function createWorker(): Worker {
  const w = new Worker('/stockfish.js');
  w.addEventListener('message', onMessage);

  w.addEventListener('error', () => {
    console.warn('Stockfish worker crashed, restarting…');
    const pending = queued || (searching && currentCallback
      ? { fen: '', onUpdate: currentCallback }
      : null);
    teardown(w);

    initEngine();
    if (pending && pending.fen) {
      evaluate(pending.fen, pending.onUpdate);
    }
  });

  return w;
}

function teardown(w: Worker): void {
  w.removeEventListener('message', onMessage);
  try { w.terminate(); } catch (_) { /* already dead */ }
  worker = null;
  searching = false;
  currentCallback = null;
  queued = null;
  if (stopTimeout) { clearTimeout(stopTimeout); stopTimeout = null; }
  stopping = null;
  idle = deferred();
  idle.resolve();
}

async function stopCurrent(): Promise<void> {
  if (!searching) return;

  // If already stopping, just wait for that to finish
  if (stopping) { await stopping; return; }

  send('stop');

  // Race: either bestmove arrives or we timeout and reset
  const timeout = new Promise<'timeout'>((res) => {
    stopTimeout = setTimeout(() => res('timeout'), STOP_TIMEOUT_MS);
  });

  stopping = (async () => {
    const result = await Promise.race([
      idle.promise.then(() => 'done' as const),
      timeout,
    ]);

    if (result === 'timeout') {
      console.warn('Stockfish stop timed out, resetting worker…');
      if (worker) teardown(worker);
      initEngine();
      await waitReady();
    }
    stopping = null;
  })();

  await stopping;
}

async function startSearch(fen: string, onUpdate: EvalCallback): Promise<void> {
  // Normalize scores to white's perspective
  const blackToMove = fen.split(' ')[1] === 'b';
  currentCallback = (score: EvalScore) => {
    onUpdate({
      ...score,
      value: blackToMove ? -score.value : score.value,
    });
  };

  // Fresh deferred for this search
  idle = deferred();
  searching = true;

  send(`position fen ${fen}`);
  send(`go depth ${SEARCH_DEPTH}`);
}

// --- Public API ---

export function initEngine(): void {
  if (worker) return;
  worker = createWorker();
  send('uci');
  send('isready');
}

export async function evaluate(fen: string, onUpdate: EvalCallback): Promise<void> {
  if (!worker) initEngine();

  // If a search is running, queue this and stop the current one.
  // If something is already queued, replace it (only latest matters).
  if (searching) {
    queued = { fen, onUpdate };
    await stopCurrent();
    // stopCurrent resolves → bestmove handler picks up queued work
    return;
  }

  await startSearch(fen, onUpdate);
}

/** Convert eval score to white's winning chance 0..1 (0.5 = equal) */
export function winningChance(score: EvalScore): number {
  if (score.type === 'mate') {
    return score.value > 0 ? 1 : 0;
  }
  // Lichess winning chances formula
  return 1 / (1 + Math.exp(-0.00368208 * score.value));
}

export function formatScore(score: EvalScore): string {
  if (score.type === 'mate') {
    return `M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  const sign = pawns > 0 ? '+' : '';
  return `${sign}${pawns.toFixed(1)}`;
}

export function destroyEngine(): void {
  if (worker) {
    send('quit');
    teardown(worker);
  }
}
