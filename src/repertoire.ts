import type { OpeningEntry } from './types';

export const FREE_PLAY_NAME = 'Free play';
export const FULL_REPERTOIRE_NAME = 'Full repertoire';

const STORAGE_KEY = 'chessbased-systems';

type OpeningStore = Record<string, OpeningEntry>;

interface RepertoireData {
  systems: Record<string, OpeningStore>;
  active: string;
}

let data: RepertoireData = { systems: { [FREE_PLAY_NAME]: {} }, active: FREE_PLAY_NAME };

function getStore(): OpeningStore {
  return data.systems[data.active] ?? {};
}

function getMergedStore(): OpeningStore {
  const merged: OpeningStore = {};
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

export function getActiveStore(): Readonly<OpeningStore> {
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
    createOpening();
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

// Opening management

export function getOpeningNames(): string[] {
  return Object.keys(data.systems);
}

export function getActiveOpening(): string {
  return data.active;
}

export function getOpeningStore(name: string): Readonly<OpeningStore> {
  return data.systems[name] ?? {};
}

export function switchOpening(name: string): void {
  if (name === FULL_REPERTOIRE_NAME) {
    data.active = name;
    persist();
    return;
  }
  if (!data.systems[name]) return;
  data.active = name;
  persist();
}

export function createOpening(name?: string): string {
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

export function deleteOpening(name: string): void {
  if (name === FREE_PLAY_NAME || name === FULL_REPERTOIRE_NAME) return;
  if (!data.systems[name]) return;
  delete data.systems[name];
  if (data.active === name) {
    data.active = FREE_PLAY_NAME;
  }
  persist();
}

export function renameOpening(oldName: string, newName: string): boolean {
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

// Merge openings

export type MergeStrategy = 'into-a' | 'into-b' | 'as-new';

function mergeStores(a: OpeningStore, b: OpeningStore): OpeningStore {
  const merged: OpeningStore = {};
  for (const [key, entry] of Object.entries(a)) {
    merged[key] = { lockedMoves: [...entry.lockedMoves] };
  }
  for (const [key, entry] of Object.entries(b)) {
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
  return merged;
}

function generateMergeName(a: string, b: string): string {
  const base = `${a} + ${b}`;
  const names = Object.keys(data.systems);
  if (!names.includes(base)) return base;
  let i = 2;
  while (names.includes(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

export function mergeMultiple(names: string[], keepName: string | null): string {
  if (names.length < 2) return data.active;

  const stores = names.map(n => data.systems[n]).filter(Boolean);
  if (stores.length < 2) return data.active;

  const merged = stores.reduce(mergeStores);

  if (keepName && names.includes(keepName)) {
    data.systems[keepName] = merged;
    for (const n of names) {
      if (n !== keepName) delete data.systems[n];
    }
    data.active = keepName;
  } else {
    const baseName = names.slice(0, 2).join(' + ');
    const allNames = Object.keys(data.systems);
    let finalName = baseName;
    if (allNames.includes(finalName)) {
      let i = 2;
      while (allNames.includes(`${baseName} (${i})`)) i++;
      finalName = `${baseName} (${i})`;
    }
    data.systems[finalName] = merged;
    for (const n of names) delete data.systems[n];
    data.active = finalName;
  }

  persist();
  return data.active;
}

export function mergeOpenings(nameA: string, nameB: string, strategy: MergeStrategy): string {
  const storeA = data.systems[nameA];
  const storeB = data.systems[nameB];
  if (!storeA || !storeB) return data.active;

  const merged = mergeStores(storeA, storeB);

  switch (strategy) {
    case 'into-a':
      data.systems[nameA] = merged;
      delete data.systems[nameB];
      data.active = nameA;
      break;
    case 'into-b':
      data.systems[nameB] = merged;
      delete data.systems[nameA];
      data.active = nameB;
      break;
    case 'as-new': {
      const newName = generateMergeName(nameA, nameB);
      data.systems[newName] = merged;
      data.active = newName;
      break;
    }
  }

  persist();
  return data.active;
}
