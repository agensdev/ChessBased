import { Chess } from 'chessops';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Opening {
  eco: string;
  name: string;
  pgn: string;
  fen: string;
}

const TSV_FILES = ['a', 'b', 'c', 'd', 'e'];
const BASE_URL = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';

async function fetchTsv(letter: string): Promise<string> {
  const url = `${BASE_URL}/${letter}.tsv`;
  console.log(`Fetching ${url}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.text();
}

function computeFen(pgn: string): string | null {
  const chess = Chess.default();
  const moves = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/);

  for (const san of moves) {
    if (!san || san === '*') continue;
    const move = parseSan(chess, san);
    if (!move) {
      console.warn(`  Illegal move "${san}" in PGN: ${pgn}`);
      return null;
    }
    chess.play(move);
  }

  return makeFen(chess.toSetup());
}

function parseTsvLine(line: string): { eco: string; name: string; pgn: string } | null {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  return { eco: parts[0], name: parts[1], pgn: parts[2] };
}

async function main() {
  const openings: Opening[] = [];
  let skipped = 0;

  for (const letter of TSV_FILES) {
    const tsv = await fetchTsv(letter);
    const lines = tsv.split('\n');

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parsed = parseTsvLine(line);
      if (!parsed) continue;

      const fen = computeFen(parsed.pgn);
      if (!fen) {
        skipped++;
        continue;
      }

      openings.push({
        eco: parsed.eco,
        name: parsed.name,
        pgn: parsed.pgn,
        fen,
      });
    }
  }

  const outPath = join(__dirname, '..', 'src', 'data', 'openings.json');
  writeFileSync(outPath, JSON.stringify(openings));
  console.log(`\nWrote ${openings.length} openings to ${outPath} (${skipped} skipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
