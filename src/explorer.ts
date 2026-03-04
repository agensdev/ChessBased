import type { ExplorerResponse, AppConfig } from './types';

const BASE_URL = 'https://explorer.lichess.ovh/lichess';

let pending: { promise: Promise<ExplorerResponse>; fen: string } | null = null;

const MAX_RETRIES = 5;

let onRetry: ((attempt: number, maxRetries: number, delaySec: number) => void) | null = null;

export function setRetryListener(cb: (attempt: number, maxRetries: number, delaySec: number) => void): void {
  onRetry = cb;
}

async function fetchExplorer(
  fen: string,
  config: AppConfig,
  attempt = 0,
): Promise<ExplorerResponse> {
  const params = new URLSearchParams({
    fen,
    ratings: config.ratings.join(','),
    speeds: config.speeds.join(','),
    topGames: '0',
    recentGames: '0',
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}?${params}`);
  } catch {
    // CORS block on 429 or network error — fetch throws TypeError
    if (attempt >= MAX_RETRIES) {
      throw new Error('network:Could not connect to the Lichess database');
    }
    const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
    onRetry?.(attempt + 1, MAX_RETRIES, delay / 1000);
    await new Promise((r) => setTimeout(r, delay));
    return fetchExplorer(fen, config, attempt + 1);
  }

  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) {
      throw new Error('ratelimit:Lichess database is busy — try again shortly');
    }
    const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
    onRetry?.(attempt + 1, MAX_RETRIES, delay / 1000);
    await new Promise((r) => setTimeout(r, delay));
    return fetchExplorer(fen, config, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`error:Lichess explorer error (${res.status})`);
  }

  return res.json();
}

export async function queryExplorer(
  fen: string,
  config: AppConfig,
): Promise<ExplorerResponse> {
  // Deduplicate: if the same FEN is already in-flight, reuse it
  if (pending) {
    if (pending.fen === fen) {
      return pending.promise;
    }
    // Wait for previous request to finish before starting a new one
    await pending.promise.catch(() => {});
  }

  const promise = fetchExplorer(fen, config);
  pending = { promise, fen };

  try {
    const result = await promise;
    return result;
  } finally {
    if (pending?.promise === promise) {
      pending = null;
    }
  }
}
