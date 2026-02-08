type TabId = 'moves' | 'explorer' | 'repertoire';

interface SavedPosition {
  parent: HTMLElement;
  nextSibling: Node | null;
}

const TAB_CONFIG: { id: TabId; label: string }[] = [
  { id: 'moves', label: 'Moves' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'repertoire', label: 'Repertoire' },
];

const MOVES_ELEMENTS = ['controls', 'alert-banner', 'moves', 'move-actions'];
const EXPLORER_ELEMENTS = ['status', 'engine-lines', 'sidebar-tabs', 'tab-explorer', 'tab-lines'];
const REPERTOIRE_ELEMENTS = ['system-picker', 'config-inline'];

let activeTab: TabId = 'explorer';
let isMobile = false;
const savedPositions = new Map<string, SavedPosition>();

function savePosition(el: HTMLElement): void {
  savedPositions.set(el.id, {
    parent: el.parentElement!,
    nextSibling: el.nextSibling,
  });
}

function restorePosition(el: HTMLElement): void {
  const pos = savedPositions.get(el.id);
  if (!pos) return;
  if (pos.nextSibling && pos.nextSibling.parentNode === pos.parent) {
    pos.parent.insertBefore(el, pos.nextSibling);
  } else {
    pos.parent.appendChild(el);
  }
}

function moveElements(ids: string[], target: HTMLElement): void {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!savedPositions.has(id)) savePosition(el);
    target.appendChild(el);
  }
}

function restoreElements(ids: string[]): void {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    restorePosition(el);
  }
}

function buildTabBar(): void {
  const container = document.getElementById('mobile-tabs')!;
  container.innerHTML = '';
  for (const tab of TAB_CONFIG) {
    const btn = document.createElement('button');
    btn.className = 'mobile-tab-btn' + (tab.id === activeTab ? ' active' : '');
    btn.textContent = tab.label;
    btn.dataset.tab = tab.id;
    btn.addEventListener('click', () => switchTab(tab.id));
    container.appendChild(btn);
  }
}

function switchTab(id: TabId): void {
  activeTab = id;
  const buttons = document.querySelectorAll('.mobile-tab-btn');
  buttons.forEach((btn) => {
    (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.tab === id);
  });
  for (const tab of TAB_CONFIG) {
    const panel = document.getElementById(`mobile-panel-${tab.id}`);
    if (panel) panel.classList.toggle('active', tab.id === id);
  }
}

function enterMobile(): void {
  isMobile = true;
  buildTabBar();

  moveElements(MOVES_ELEMENTS, document.getElementById('mobile-panel-moves')!);
  moveElements(EXPLORER_ELEMENTS, document.getElementById('mobile-panel-explorer')!);
  moveElements(REPERTOIRE_ELEMENTS, document.getElementById('mobile-panel-repertoire')!);

  switchTab(activeTab);
}

function exitMobile(): void {
  isMobile = false;

  restoreElements(MOVES_ELEMENTS);
  restoreElements(EXPLORER_ELEMENTS);
  restoreElements(REPERTOIRE_ELEMENTS);

  document.getElementById('mobile-tabs')!.innerHTML = '';
  for (const tab of TAB_CONFIG) {
    document.getElementById(`mobile-panel-${tab.id}`)?.classList.remove('active');
  }
}

export function initMobileTabs(): void {
  const mql = window.matchMedia('(max-width: 900px)');

  const handleChange = (e: MediaQueryList | MediaQueryListEvent) => {
    if (e.matches && !isMobile) {
      enterMobile();
    } else if (!e.matches && isMobile) {
      exitMobile();
    }
  };

  handleChange(mql);
  mql.addEventListener('change', handleChange);
}
