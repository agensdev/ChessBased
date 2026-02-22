import openingsRaw from './data/openings.json';

interface OpeningEntry {
  eco: string;
  name: string;
  pgn: string;
  fen: string;
}

export interface OpeningLookup {
  eco: string;
  name: string;
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function pgnPly(pgn: string): number {
  return pgn
    .replace(/\d+\.\s*/g, '')
    .trim()
    .split(/\s+/)
    .filter(t => t && t !== '*')
    .length;
}

const openings = openingsRaw as OpeningEntry[];
const openingByFenKey = new Map<string, OpeningEntry>();

for (const opening of openings) {
  const key = positionKey(opening.fen);
  const existing = openingByFenKey.get(key);
  // Prefer the deepest named line if multiple names map to same position.
  if (!existing || pgnPly(opening.pgn) > pgnPly(existing.pgn)) {
    openingByFenKey.set(key, opening);
  }
}

export function findOpeningByFen(fen: string): OpeningLookup | null {
  const hit = openingByFenKey.get(positionKey(fen));
  if (!hit) return null;
  return { eco: hit.eco, name: hit.name };
}

// ECO → shortest opening entry (family name, e.g. "Sicilian Defense" not "Sicilian Defense: Najdorf Variation")
const openingByEco = new Map<string, OpeningEntry>();
for (const opening of openings) {
  const existing = openingByEco.get(opening.eco);
  if (!existing || opening.name.length < existing.name.length) {
    openingByEco.set(opening.eco, opening);
  }
}

export function findOpeningByEco(eco: string): string | null {
  return openingByEco.get(eco)?.name ?? null;
}

export function findPgnByEco(eco: string): { name: string; pgn: string } | null {
  const entry = openingByEco.get(eco);
  if (!entry) return null;
  return { name: entry.name, pgn: entry.pgn };
}

