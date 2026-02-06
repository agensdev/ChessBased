import type { ExplorerResponse, AppConfig } from './types';

const BASE_URL = 'https://explorer.lichess.ovh/lichess';

let pending: Promise<ExplorerResponse> | null = null;

async function fetchExplorer(
  fen: string,
  config: AppConfig,
): Promise<ExplorerResponse> {
  const params = new URLSearchParams({
    fen,
    ratings: config.ratings.join(','),
    speeds: config.speeds.join(','),
    topGames: '0',
    recentGames: '0',
  });

  const res = await fetch(`${BASE_URL}?${params}`);

  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return fetchExplorer(fen, config);
  }

  if (!res.ok) {
    throw new Error(`Explorer API error: ${res.status}`);
  }

  return res.json();
}

export async function queryExplorer(
  fen: string,
  config: AppConfig,
): Promise<ExplorerResponse> {
  // Sequential queue: wait for any in-flight request
  if (pending) {
    await pending;
  }

  const request = fetchExplorer(fen, config);
  pending = request;

  try {
    const result = await request;
    return result;
  } finally {
    if (pending === request) {
      pending = null;
    }
  }
}
