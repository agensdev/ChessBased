import type { RepertoireEntry } from './types';

export const FREE_PLAY_NAME = 'Free play';
export const FULL_REPERTOIRE_NAME = 'Full repertoire';

const STORAGE_KEY = 'chessbased-systems';

type RepertoireStore = Record<string, RepertoireEntry>;

interface RepertoireData {
  systems: Record<string, RepertoireStore>;
  active: string;
}

let data: RepertoireData = { systems: { [FREE_PLAY_NAME]: {} }, active: FREE_PLAY_NAME };

function getStore(): RepertoireStore {
  return data.systems[data.active] ?? {};
}

function getMergedStore(): RepertoireStore {
  const merged: RepertoireStore = {};
  for (const [name, store] of Object.entries(data.systems)) {
    if (name === FREE_PLAY_NAME) continue;
    for (const [key, entry] of Object.entries(store)) {
      if (!merged[key]) {
        merged[key] = { lockedMoves: [...entry.lockedMoves] };
      } else {
        for (const uci of entry.lockedMoves) {
          if (!merged[key].lockedMoves.includes(uci)) {
            merged[key].lockedMoves.push(uci);
          }
        }
      }
    }
  }
  return merged;
}

export function getActiveStore(): Readonly<RepertoireStore> {
  if (data.active === FULL_REPERTOIRE_NAME) return getMergedStore();
  return getStore();
}

export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

function ensureFreePlay(): void {
  if (!data.systems[FREE_PLAY_NAME]) {
    data.systems[FREE_PLAY_NAME] = {};
  }
  // Ensure Free Play is first by re-ordering keys
  const { [FREE_PLAY_NAME]: fp, ...rest } = data.systems;
  data.systems = { [FREE_PLAY_NAME]: fp, ...rest };
}

export function loadRepertoire(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      data = JSON.parse(raw);
    } else {
      // Migrate from old single-repertoire format
      const oldRaw = localStorage.getItem('chessbased-repertoire');
      if (oldRaw) {
        const oldStore = JSON.parse(oldRaw);
        data = { systems: { Default: oldStore }, active: 'Default' };
        localStorage.removeItem('chessbased-repertoire');
      }
    }
  } catch {
    data = { systems: { [FREE_PLAY_NAME]: {} }, active: FREE_PLAY_NAME };
  }
  ensureFreePlay();
  persist();
}

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function getLockedMoves(fen: string): string[] {
  if (data.active === FREE_PLAY_NAME) return [];
  if (data.active === FULL_REPERTOIRE_NAME) {
    const key = positionKey(fen);
    return getMergedStore()[key]?.lockedMoves ?? [];
  }
  const key = positionKey(fen);
  return getStore()[key]?.lockedMoves ?? [];
}

export function lockMove(fen: string, uci: string): boolean {
  let createdRepertoire = false;
  if (data.active === FREE_PLAY_NAME || data.active === FULL_REPERTOIRE_NAME) {
    createRepertoire();
    createdRepertoire = true;
  }
  const store = getStore();
  const key = positionKey(fen);
  if (!store[key]) {
    store[key] = { lockedMoves: [] };
  }
  if (!store[key].lockedMoves.includes(uci)) {
    store[key].lockedMoves.push(uci);
  }
  persist();
  return createdRepertoire;
}

export function unlockMove(fen: string, uci: string): void {
  if (data.active === FREE_PLAY_NAME || data.active === FULL_REPERTOIRE_NAME) return;
  const store = getStore();
  const key = positionKey(fen);
  if (!store[key]) return;
  store[key].lockedMoves = store[key].lockedMoves.filter((m) => m !== uci);
  if (store[key].lockedMoves.length === 0) {
    delete store[key];
  }
  persist();
}

export function isMoveLocked(fen: string, uci: string): boolean {
  return getLockedMoves(fen).includes(uci);
}

// Repertoire management

export function getRepertoireNames(): string[] {
  return Object.keys(data.systems);
}

export function getActiveRepertoire(): string {
  return data.active;
}

export function getStoreByName(name: string): Readonly<RepertoireStore> {
  return data.systems[name] ?? {};
}

export function switchRepertoire(name: string): void {
  if (name === FULL_REPERTOIRE_NAME) {
    data.active = name;
    persist();
    return;
  }
  if (!data.systems[name]) return;
  data.active = name;
  persist();
}

export function createRepertoire(name?: string): string {
  const finalName = name?.trim() || generateUniqueName();
  if (data.systems[finalName]) return finalName;
  data.systems[finalName] = {};
  data.active = finalName;
  persist();
  return finalName;
}

function generateUniqueName(): string {
  const names = Object.keys(data.systems);
  if (!names.includes('Untitled')) return 'Untitled';
  let i = 2;
  while (names.includes(`Untitled ${i}`)) i++;
  return `Untitled ${i}`;
}

export function deleteRepertoire(name: string): void {
  if (name === FREE_PLAY_NAME || name === FULL_REPERTOIRE_NAME) return;
  if (!data.systems[name]) return;
  delete data.systems[name];
  if (data.active === name) {
    data.active = FREE_PLAY_NAME;
  }
  persist();
}

export function renameRepertoire(oldName: string, newName: string): boolean {
  if (oldName === FREE_PLAY_NAME || oldName === FULL_REPERTOIRE_NAME) return false;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === FREE_PLAY_NAME || trimmed === FULL_REPERTOIRE_NAME) return false;
  if (!data.systems[oldName] || data.systems[trimmed]) return false;
  data.systems[trimmed] = data.systems[oldName];
  delete data.systems[oldName];
  if (data.active === oldName) {
    data.active = trimmed;
  }
  persist();
  return true;
}
