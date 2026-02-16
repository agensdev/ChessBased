import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import {
  getPersonalConfig, getPersonalGames, queryPersonalExplorer, hasPersonalData,
  getPersonalStats, getPersonalFilters, setPersonalFilters, queryPersonalMoveGameIndices,
  type GameMeta, type PersonalFilters,
} from './personal-explorer';
import { generateReport, type ReportData, type OpeningLine, type WDL } from './report';
import { loadConfig } from './config';
import type { MoveHistoryEntry } from './types';

type ReportNavigateCallback = (
  moves: MoveHistoryEntry[],
  fen: string,
  orientation: 'white' | 'black',
  filters: PersonalFilters,
) => void;

let reportNavigateCallback: ReportNavigateCallback | null = null;

export function setReportNavigateCallback(cb: ReportNavigateCallback): void {
  reportNavigateCallback = cb;
}

let reportOpen = false;
let reportCg: Api | null = null;
let savedFilters: PersonalFilters = {};
let reportFilters: ReportFilters = {};
let reportCurrentRating: number | null = null;
const REPORT_OPEN_SESSION_KEY = 'chessbased-report-open';
const REPORT_GUIDE_OPEN_KEY = 'chessbased-report-guide-open';
const CURRENT_RATING_WINDOW = 100;

// Line navigation state
let selectedLine: OpeningLine | null = null;
let lineViewIndex = 0;           // 0 = starting pos, moves.length = end pos
let lineFens: string[] = [];     // FEN at each ply (index 0 = starting, length = moves.length + 1)
let lineLastMoves: (Key[] | undefined)[] = []; // lastMove highlight per ply
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let theoryOverlayEl: HTMLElement | null = null;
let lineGameResultFilter: 'all' | 'win' | 'draw' | 'loss' = 'all';

interface ReportFilters {
  timeClasses?: string[];
  minRating?: number;
  maxRating?: number;
  sinceMonth?: string;
  untilMonth?: string;
  color?: 'white' | 'black';
}

export function isReportPageOpen(): boolean {
  return reportOpen;
}

export function shouldRestoreReportPage(): boolean {
  try {
    return sessionStorage.getItem(REPORT_OPEN_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function persistReportOpenState(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(REPORT_OPEN_SESSION_KEY, '1');
    else sessionStorage.removeItem(REPORT_OPEN_SESSION_KEY);
  } catch {
    // Ignore storage errors
  }
}

function getReportGuideOpenState(): boolean {
  try {
    const raw = localStorage.getItem(REPORT_GUIDE_OPEN_KEY);
    if (raw == null) return true;
    return raw === '1';
  } catch {
    return true;
  }
}

function persistReportGuideOpenState(open: boolean): void {
  try {
    localStorage.setItem(REPORT_GUIDE_OPEN_KEY, open ? '1' : '0');
  } catch {
    // Ignore storage errors
  }
}

export function closeReportPage(): void {
  if (!reportOpen) return;
  reportOpen = false;
  persistReportOpenState(false);
  // Restore explorer filters
  setPersonalFilters(savedFilters);
  const page = document.getElementById('report-page');
  if (page) {
    page.classList.add('hidden');
    page.innerHTML = '';
  }
  if (reportCg) {
    reportCg.destroy();
    reportCg = null;
  }
  theoryOverlayEl = null;
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  document.getElementById('app')!.style.display = '';
}

export function openReportPage(): void {
  if (reportOpen) return;
  reportOpen = true;
  persistReportOpenState(true);
  // Save current explorer filters so we can restore on close
  savedFilters = getPersonalFilters();
  // Initialize report filters from main config speeds
  const appConfig = loadConfig();
  reportCurrentRating = inferCurrentRating(getPersonalGames() ?? [], appConfig.speeds);
  reportFilters = {
    timeClasses: [...appConfig.speeds],
    minRating: reportCurrentRating != null ? reportCurrentRating - CURRENT_RATING_WINDOW : undefined,
    maxRating: reportCurrentRating != null ? reportCurrentRating + CURRENT_RATING_WINDOW : undefined,
  };

  document.getElementById('app')!.style.display = 'none';
  const page = document.getElementById('report-page')!;
  page.classList.remove('hidden');
  page.innerHTML = '';

  const config = getPersonalConfig();
  const games = getPersonalGames();

  if (!hasPersonalData() || !games || !config) {
    renderEmptyState(page);
    return;
  }

  renderPage(page, games, config.username);
}

function renderEmptyState(page: HTMLElement): void {
  page.innerHTML = `
    <div class="report-header">
      <button class="report-back-btn">&larr; Back to trainer</button>
      <span class="report-title">Game Report</span>
      <span></span>
    </div>
    <div class="report-content">
      <div class="report-empty">
        <p>No games imported yet.</p>
        <p>Import your games from the <b>My Games</b> tab to see your report.</p>
      </div>
    </div>
  `;
  page.querySelector('.report-back-btn')!.addEventListener('click', closeReportPage);
}

// ── Filter Logic ──

function filterGames(games: readonly GameMeta[], filters: ReportFilters): GameMeta[] {
  if (!hasActiveFilters(filters)) return [...games];
  return games.filter(g => {
    if (filters.timeClasses && filters.timeClasses.length > 0) {
      if (!filters.timeClasses.includes(g.tc)) return false;
    }
    if (filters.minRating != null && g.ur < filters.minRating) return false;
    if (filters.maxRating != null && g.ur > filters.maxRating) return false;
    if (filters.sinceMonth && g.mo < filters.sinceMonth) return false;
    if (filters.untilMonth && g.mo > filters.untilMonth) return false;
    if (filters.color === 'white' && !g.uw) return false;
    if (filters.color === 'black' && g.uw) return false;
    return true;
  });
}

function hasActiveFilters(f: ReportFilters): boolean {
  return !!(
    (f.timeClasses && f.timeClasses.length > 0) ||
    f.minRating != null ||
    f.maxRating != null ||
    f.sinceMonth ||
    f.untilMonth ||
    f.color
  );
}

function inferCurrentRating(games: readonly GameMeta[], preferredTimeClasses: string[]): number | null {
  const validAll = games.filter(g => g.ur > 0);
  if (validAll.length === 0) return null;

  let pool = validAll;
  if (preferredTimeClasses.length > 0) {
    const preferred = validAll.filter(g => preferredTimeClasses.includes(g.tc));
    if (preferred.length > 0) pool = preferred;
  }

  const monthPool = pool.filter(g => g.mo && g.mo !== 'unknown');
  if (monthPool.length > 0) {
    const latestMonth = monthPool.reduce((max, g) => g.mo > max ? g.mo : max, monthPool[0].mo);
    const latestGames = monthPool.filter(g => g.mo === latestMonth);
    if (latestGames.length > 0) {
      const avg = latestGames.reduce((sum, g) => sum + g.ur, 0) / latestGames.length;
      return Math.round(avg);
    }
  }

  // Fallback when month is unknown: average over last chunk
  const recent = pool.slice(-30);
  const avg = recent.reduce((sum, g) => sum + g.ur, 0) / recent.length;
  return Math.round(avg);
}

function isUsingCurrentRatingWindow(filters: ReportFilters): boolean {
  if (reportCurrentRating == null) return false;
  return filters.minRating === reportCurrentRating - CURRENT_RATING_WINDOW
    && filters.maxRating === reportCurrentRating + CURRENT_RATING_WINDOW;
}

function syncExplorerFilters(filters: ReportFilters): void {
  // Set global personal explorer filters to match report filters
  // so queryPersonalExplorer returns matching data for the opening walk
  setPersonalFilters({
    timeClasses: filters.timeClasses,
    minRating: filters.minRating,
    maxRating: filters.maxRating,
    sinceMonth: filters.sinceMonth,
    untilMonth: filters.untilMonth,
    color: filters.color,
  });
}

// ── Page Rendering ──

function renderPage(page: HTMLElement, allGames: readonly GameMeta[], username: string): void {
  page.innerHTML = '';
  if (reportCg) {
    reportCg.destroy();
    reportCg = null;
  }

  // Header
  const header = el('div', 'report-header');
  const backBtn = el('button', 'report-back-btn');
  backBtn.innerHTML = '&larr; Back to trainer';
  backBtn.addEventListener('click', closeReportPage);
  const title = el('span', 'report-title');
  title.textContent = 'Game Report';
  const user = el('span', 'report-username');
  user.textContent = username;
  header.append(backBtn, title, user);
  page.append(header);

  // Filter bar
  renderFilterBar(page, allGames, username);

  // Report content
  const filtered = filterGames(allGames, reportFilters);
  syncExplorerFilters(reportFilters);

  const content = el('div', 'report-content');
  content.id = 'report-content';
  page.append(content);

  if (filtered.length === 0) {
    const empty = el('div', 'report-empty');
    empty.innerHTML = '<p>No games match the current filters.</p>';
    content.append(empty);
    return;
  }

  if (filtered.length < 10) {
    const note = el('div', 'report-note');
    note.textContent = 'Limited data — adjust filters or import more games for detailed analysis.';
    content.append(note);
  }

  const report = generateReport(filtered, queryPersonalExplorer, (color) => {
    setPersonalFilters({
      timeClasses: reportFilters.timeClasses,
      minRating: reportFilters.minRating,
      maxRating: reportFilters.maxRating,
      sinceMonth: reportFilters.sinceMonth,
      untilMonth: reportFilters.untilMonth,
      color: color ?? undefined,
    });
  }, queryPersonalMoveGameIndices, (idx) => allGames[idx], reportFilters.color);
  // Restore filters without color constraint after report generation
  syncExplorerFilters(reportFilters);
  renderReportContent(content, report);

  // Keyboard listener — remove previous before adding new
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (e: KeyboardEvent) => {
    if (!reportOpen) { document.removeEventListener('keydown', keyHandler!); keyHandler = null; return; }
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      if (closeTheoryModalIfOpen()) return;
      closeReportPage();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateLine(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateLine(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedLine) { lineViewIndex = 0; updateBoardForLine(); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedLine) { lineViewIndex = lineFens.length - 1; updateBoardForLine(); }
    }
  };
  document.addEventListener('keydown', keyHandler);
}

function rerender(): void {
  const page = document.getElementById('report-page');
  const config = getPersonalConfig();
  const games = getPersonalGames();
  if (!page || !config || !games) return;
  renderPage(page, games, config.username);
}

// ── Filter Bar ──

function renderFilterBar(page: HTMLElement, allGames: readonly GameMeta[], _username: string): void {
  const stats = getPersonalStats();
  if (!stats) return;

  const bar = el('div', 'report-filter-bar');

  // Time control chips
  if (stats.timeClasses.length > 1) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Time';
    group.append(label);

    const activeTC = reportFilters.timeClasses ?? [];
    for (const tc of stats.timeClasses) {
      const chip = el('button', 'chip chip-sm');
      if (activeTC.length === 0 || activeTC.includes(tc)) chip.classList.add('selected');
      chip.dataset.tc = tc;
      chip.textContent = capitalize(tc);
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        applyFiltersFromBar(bar);
      });
      group.append(chip);
    }
    bar.append(group);
  }

  // Date presets
  if (stats.months.length > 1) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Period';
    group.append(label);

    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const threeAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const threeMonth = `${threeAgo.getFullYear()}-${String(threeAgo.getMonth() + 1).padStart(2, '0')}`;
    const sixAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const sixMonth = `${sixAgo.getFullYear()}-${String(sixAgo.getMonth() + 1).padStart(2, '0')}`;
    const yearAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const yearMonth = `${yearAgo.getFullYear()}-${String(yearAgo.getMonth() + 1).padStart(2, '0')}`;

    const presets = [
      { label: 'All time', since: '', until: '' },
      { label: '12 months', since: yearMonth, until: curMonth },
      { label: '6 months', since: sixMonth, until: curMonth },
      { label: '3 months', since: threeMonth, until: curMonth },
    ];

    const segment = el('div', 'segment-picker segment-sm') as HTMLDivElement;
    segment.setAttribute('role', 'radiogroup');
    segment.setAttribute('aria-label', 'Date range period');

    for (const preset of presets) {
      const segmentBtn = el('button', 'segment-btn') as HTMLButtonElement;
      segmentBtn.type = 'button';
      segmentBtn.dataset.since = preset.since;
      segmentBtn.dataset.until = preset.until;
      const isActive = (reportFilters.sinceMonth ?? '') === preset.since &&
        (reportFilters.untilMonth ?? '') === preset.until;
      if (isActive) segmentBtn.classList.add('selected');
      segmentBtn.textContent = preset.label;
      segmentBtn.setAttribute('role', 'radio');
      segmentBtn.setAttribute('aria-checked', isActive ? 'true' : 'false');
      segmentBtn.tabIndex = isActive ? 0 : -1;
      segmentBtn.addEventListener('click', () => {
        if ((reportFilters.sinceMonth ?? '') === preset.since &&
          (reportFilters.untilMonth ?? '') === preset.until) return;
        reportFilters.sinceMonth = preset.since || undefined;
        reportFilters.untilMonth = preset.until || undefined;
        rerender();
      });
      segment.append(segmentBtn);
    }
    group.append(segment);
    bar.append(group);
  }

  // Current rating quick filter
  if (reportCurrentRating != null) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Relevance';
    group.append(label);

    const chip = el('button', 'chip chip-sm');
    chip.textContent = `Near current (${reportCurrentRating} ±${CURRENT_RATING_WINDOW})`;
    chip.setAttribute('data-tooltip', 'Prioritize games near your recent rating so old level performance has less influence.');
    chip.classList.add('tooltip-wide');
    if (isUsingCurrentRatingWindow(reportFilters)) chip.classList.add('selected');

    chip.addEventListener('click', () => {
      if (isUsingCurrentRatingWindow(reportFilters)) {
        reportFilters.minRating = undefined;
        reportFilters.maxRating = undefined;
      } else {
        reportFilters.minRating = reportCurrentRating! - CURRENT_RATING_WINDOW;
        reportFilters.maxRating = reportCurrentRating! + CURRENT_RATING_WINDOW;
      }
      rerender();
    });

    group.append(chip);
    bar.append(group);
  }

  // Side filter (white/black/both)
  const hasWhiteGames = allGames.some(g => g.uw);
  const hasBlackGames = allGames.some(g => !g.uw);
  if (hasWhiteGames && hasBlackGames) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Side';
    group.append(label);

    const whiteChip = el('button', 'chip chip-sm');
    whiteChip.dataset.color = 'white';
    whiteChip.textContent = 'White';
    if (reportFilters.color !== 'black') whiteChip.classList.add('selected');
    whiteChip.addEventListener('click', () => {
      whiteChip.classList.toggle('selected');
      applyFiltersFromBar(bar);
    });

    const blackChip = el('button', 'chip chip-sm');
    blackChip.dataset.color = 'black';
    blackChip.textContent = 'Black';
    if (reportFilters.color !== 'white') blackChip.classList.add('selected');
    blackChip.addEventListener('click', () => {
      blackChip.classList.toggle('selected');
      applyFiltersFromBar(bar);
    });

    group.append(whiteChip, blackChip);
    bar.append(group);
  }

  // Rating range
  if (stats.minRating < stats.maxRating) {
    const group = el('div', 'report-filter-group');
    const label = el('span', 'report-filter-label');
    label.textContent = 'Rating';
    group.append(label);

    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.className = 'report-filter-input';
    minInput.placeholder = String(stats.minRating);
    if (reportFilters.minRating != null) minInput.value = String(reportFilters.minRating);

    const sep = el('span', 'report-filter-sep');
    sep.textContent = '–';

    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.className = 'report-filter-input';
    maxInput.placeholder = String(stats.maxRating);
    if (reportFilters.maxRating != null) maxInput.value = String(reportFilters.maxRating);

    const applyRating = () => {
      reportFilters.minRating = minInput.value ? parseInt(minInput.value) : undefined;
      reportFilters.maxRating = maxInput.value ? parseInt(maxInput.value) : undefined;
      rerender();
    };
    minInput.addEventListener('change', applyRating);
    maxInput.addEventListener('change', applyRating);

    group.append(minInput, sep, maxInput);
    bar.append(group);
  }

  // Game count indicator
  const filtered = filterGames(allGames, reportFilters);
  if (hasActiveFilters(reportFilters)) {
    const count = el('span', 'report-filter-count');
    count.textContent = `${formatNum(filtered.length)} / ${formatNum(allGames.length)} games`;
    bar.append(count);

    const resetBtn = el('button', 'report-filter-reset');
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
      reportFilters = {
        timeClasses: undefined,
        minRating: reportCurrentRating != null ? reportCurrentRating - CURRENT_RATING_WINDOW : undefined,
        maxRating: reportCurrentRating != null ? reportCurrentRating + CURRENT_RATING_WINDOW : undefined,
        color: undefined,
      };
      rerender();
    });
    bar.append(resetBtn);
  }

  page.append(bar);
}

function applyFiltersFromBar(bar: HTMLElement): void {
  // Collect time class chips
  const allChips = bar.querySelectorAll('.chip[data-tc]');
  const selectedChips = bar.querySelectorAll('.chip[data-tc].selected');
  if (selectedChips.length > 0 && selectedChips.length < allChips.length) {
    reportFilters.timeClasses = Array.from(selectedChips).map(c => (c as HTMLElement).dataset.tc!);
  } else {
    reportFilters.timeClasses = undefined;
  }

  // Collect side chips (white/black)
  const sideSelected = Array.from(bar.querySelectorAll('.chip[data-color].selected'))
    .map(c => (c as HTMLElement).dataset.color)
    .filter((c): c is 'white' | 'black' => c === 'white' || c === 'black');
  if (sideSelected.length === 1) reportFilters.color = sideSelected[0];
  else reportFilters.color = undefined;

  rerender();
}

// ── Report Content (below filters) ──

function renderReportContent(content: HTMLElement, report: ReportData): void {
  theoryOverlayEl = null;
  renderReportGuide(content);
  renderTheoryModal(content);

  // Compact overview
  renderCompactOverview(content, report);

  // Main body: two-column layout for report sections + board
  const body = el('div', 'report-body');
  content.append(body);

  const mainCol = el('div', 'report-main-col');
  body.append(mainCol);

  // Priority weaknesses (actionable queue)
  if (report.weaknessQueue.length > 0) {
    renderWeaknessQueue(mainCol, report.weaknessQueue);
  }

  // Opening tables
  if (report.whiteOpenings.length > 0) {
    renderOpeningTable(mainCol, 'White Openings', report.whiteOpenings);
  }
  if (report.blackOpenings.length > 0) {
    renderOpeningTable(mainCol, 'Black Openings', report.blackOpenings);
  }

  // Positive lines
  if (report.bestOpenings.length > 0) {
    renderHighlights(mainCol, report.bestOpenings);
  }

  // Board sidebar (sticky)
  const boardCol = el('div', 'report-board-col');
  body.append(boardCol);

  const boardWrap = el('div', 'report-board-wrap');
  boardCol.append(boardWrap);

  // Nav controls
  const nav = el('div', 'report-board-nav');

  const startBtn = el('button', 'report-nav-btn report-nav-start');
  startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M18.41 16.59L13.82 12l4.59-4.59L17 6l-6 6 6 6zM6 6h2v12H6z"/></svg>';
  startBtn.addEventListener('click', () => { if (selectedLine) { lineViewIndex = 0; updateBoardForLine(); } });

  const prevBtn = el('button', 'report-nav-btn report-nav-prev') as HTMLButtonElement;
  prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
  prevBtn.addEventListener('click', () => navigateLine(-1));

  const counter = el('span', 'report-nav-counter');
  counter.textContent = '';

  const nextBtn = el('button', 'report-nav-btn report-nav-next') as HTMLButtonElement;
  nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
  nextBtn.addEventListener('click', () => navigateLine(1));

  const endBtn = el('button', 'report-nav-btn report-nav-end');
  endBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z"/></svg>';
  endBtn.addEventListener('click', () => { if (selectedLine) { lineViewIndex = lineFens.length - 1; updateBoardForLine(); } });

  nav.append(startBtn, prevBtn, counter, nextBtn, endBtn);
  boardCol.append(nav);

  const boardLabel = el('div', 'report-board-label');
  boardLabel.textContent = 'Click an opening to preview';
  boardCol.append(boardLabel);

  const continuations = el('div', 'report-continuations');
  boardCol.append(continuations);

  // Open in trainer button
  const trainerBtn = el('button', 'report-trainer-btn hidden') as HTMLButtonElement;
  trainerBtn.textContent = 'Open in trainer';
  trainerBtn.addEventListener('click', () => {
    if (!selectedLine || lineViewIndex <= 0 || !reportNavigateCallback) return;
    const moves: MoveHistoryEntry[] = selectedLine.moves.slice(0, lineViewIndex).map((san, i) => ({
      san,
      uci: selectedLine!.ucis[i],
      fen: lineFens[i + 1],
    }));
    const fen = lineFens[lineViewIndex];
    const filters: PersonalFilters = {
      timeClasses: reportFilters.timeClasses,
      minRating: reportFilters.minRating,
      maxRating: reportFilters.maxRating,
      sinceMonth: reportFilters.sinceMonth,
      untilMonth: reportFilters.untilMonth,
      color: reportFilters.color,
    };
    reportNavigateCallback(moves, fen, selectedLine.color, filters);
  });
  boardCol.append(trainerBtn);

  const lineGames = el('div', 'report-line-games');
  boardCol.append(lineGames);

  // Initialize mini board
  reportCg = Chessground(boardWrap, {
    viewOnly: true,
    coordinates: false,
    animation: { enabled: true, duration: 150 },
    drawable: { enabled: false },
  });

  // Reset line state
  selectedLine = null;
  lineViewIndex = 0;
  lineFens = [];
  lineLastMoves = [];
  lineGameResultFilter = 'all';
  renderSelectedLineGames();
}

function renderCompactOverview(parent: HTMLElement, report: ReportData): void {
  const wrap = el('section', 'report-overview');

  const stats = [
    { label: 'Games', value: formatNum(report.totalGames) },
    { label: 'Win Rate', value: `${report.overallWinRate}%` },
    { label: 'As White', value: `${winRatePct(report.asWhite)}%` },
    { label: 'As Black', value: `${winRatePct(report.asBlack)}%` },
  ];

  const statGrid = el('div', 'report-overview-stats');
  for (const s of stats) {
    const item = el('div', 'report-overview-stat');
    const k = el('div', 'report-overview-key');
    k.textContent = s.label;
    const v = el('div', 'report-overview-value');
    v.textContent = s.value;
    item.append(k, v);
    statGrid.append(item);
  }
  wrap.append(statGrid);

  const wdl = report.overall;
  if (wdl.total > 0) {
    const bar = el('div', 'report-overview-wdl');
    const wPct = (wdl.wins / wdl.total) * 100;
    const dPct = (wdl.draws / wdl.total) * 100;
    const bPct = (wdl.losses / wdl.total) * 100;

    const wEl = el('div', 'bar-white');
    wEl.style.width = `${wPct}%`;
    if (wPct >= 12) wEl.textContent = `${Math.round(wPct)}%`;
    wEl.setAttribute('data-tooltip', `Win: ${wdl.wins} games (${Math.round(wPct)}%)`);
    const dEl = el('div', 'bar-draw');
    dEl.style.width = `${dPct}%`;
    if (dPct >= 12) dEl.textContent = `${Math.round(dPct)}%`;
    dEl.setAttribute('data-tooltip', `Draw: ${wdl.draws} games (${Math.round(dPct)}%)`);
    const bEl = el('div', 'bar-black');
    bEl.style.width = `${bPct}%`;
    if (bPct >= 12) bEl.textContent = `${Math.round(bPct)}%`;
    bEl.setAttribute('data-tooltip', `Loss: ${wdl.losses} games (${Math.round(bPct)}%)`);
    bar.append(wEl, dEl, bEl);
    wrap.append(bar);
  }

  const hasTrend = report.ratingTrend.length > 1 && report.ratingTrend.some(r => r.avgRating > 0);
  const hasTimeControl = report.byTimeControl.length > 0;
  if (hasTrend || hasTimeControl) {
    const details = document.createElement('details');
    details.className = 'report-overview-breakdown';

    const summary = document.createElement('summary');
    summary.textContent = 'Performance breakdown';
    details.append(summary);

    const breakdownBody = el('div', 'report-overview-breakdown-body');
    const chartsRow = el('div', 'report-charts-row');
    breakdownBody.append(chartsRow);
    if (hasTrend) renderSparkline(chartsRow, report.ratingTrend);
    if (hasTimeControl) renderTimeControlTable(chartsRow, report.byTimeControl);

    details.append(breakdownBody);
    wrap.append(details);
  }

  parent.append(wrap);
}

// ── Guide ──

function renderReportGuide(parent: HTMLElement): void {
  const details = document.createElement('details');
  details.className = 'report-guide';
  details.open = getReportGuideOpenState();
  details.addEventListener('toggle', () => {
    persistReportGuideOpenState(details.open);
  });

  const summary = document.createElement('summary');
  summary.textContent = 'How to read this report';
  details.append(summary);

  const body = el('div', 'report-guide-body');
  body.innerHTML = `
    <p><b>Goal:</b> find the openings that cost you the most points, then drill those first.</p>
    <ol>
      <li>Start with <b>Priority Weaknesses</b> and sort by <b>Priority</b>.</li>
      <li>Use <b>Preview</b> to inspect the line and continuations.</li>
      <li>Use <b>Open in trainer</b> from board preview to continue training from that line.</li>
      <li>Check <b>Vs Elo</b> to see if results are above/below Elo expectation.</li>
      <li>Use confidence badges (<b>H/M/L</b>) to judge sample reliability.</li>
    </ol>
  `;
  const actions = el('div', 'report-guide-actions');
  const theoryBtn = el('button', 'report-guide-theory-btn') as HTMLButtonElement;
  theoryBtn.textContent = 'Theory & methodology';
  theoryBtn.addEventListener('click', openTheoryModal);
  actions.append(theoryBtn);
  body.append(actions);
  details.append(body);
  parent.append(details);
}

function renderTheoryModal(parent: HTMLElement): void {
  const overlay = el('div', 'report-theory-overlay hidden');
  overlay.id = 'report-theory-overlay';

  const modal = el('div', 'report-theory-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Theory and methodology');

  const header = el('div', 'report-theory-header');
  const title = el('div', 'report-theory-title');
  title.textContent = 'Theory & Methodology';
  const closeBtn = el('button', 'report-theory-close') as HTMLButtonElement;
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closeTheoryModal);
  header.append(title, closeBtn);

  const body = el('div', 'report-theory-body');
  body.innerHTML = `
    <h3>Why this exists</h3>
    <p>
      The report is designed to answer one practical question: <b>what should you train next</b>.
      Raw win rates can be misleading, so these metrics try to combine results, reliability, opponent strength, and frequency.
    </p>

    <h3>Core score percentages</h3>
    <p>
      A line score is based on chess points, not just wins:
      <b>Win = 1</b>, <b>Draw = 0.5</b>, <b>Loss = 0</b>.
      Score percentage is:
      <b>(wins + 0.5 × draws) / games</b>.
    </p>
    <p>
      This is why a line with many draws can still have a decent score even if the raw win rate is modest.
    </p>

    <h3>Stable score (Score%)</h3>
    <p>
      <b>Score%</b> is your line score after a small stability adjustment.
      Small samples are noisy, so we blend line score with your overall filtered score using a prior weight.
      This prevents a 3/3 line from outranking a stable 40-game line too aggressively.
    </p>
    <p>
      In practice: treat Score% as your best estimate of true line strength right now.
    </p>

    <h3>Confidence (H/M/L)</h3>
    <p>
      Confidence is about <b>uncertainty</b>, not how good the line is.
      It is derived from sample size and score spread (shown as ± points).
    </p>
    <ul>
      <li><b>H</b> (high): larger sample, metric is more stable.</li>
      <li><b>M</b> (medium): useful signal, still some noise.</li>
      <li><b>L</b> (low): treat as tentative; gather more games.</li>
    </ul>
    <p>
      A weak line with low confidence is a hypothesis.
      A weak line with high confidence is usually a real problem.
    </p>

    <h3>Elo expected score and Vs Elo</h3>
    <p>
      Elo gives an expected score against each opponent based on rating difference:
      <b>E = 1 / (1 + 10^((opp - user)/400))</b>.
      We average that expectation across games in the line.
    </p>
    <p>
      <b>Vs Elo</b> is:
      <b>actual line score − expected line score</b>.
    </p>
    <ul>
      <li><b>Positive Vs Elo</b>: you outperform what ratings predict.</li>
      <li><b>Negative Vs Elo</b>: you underperform expectation in that line.</li>
    </ul>
    <p>
      This is important because 50% score can be either good or bad depending on opponent strength.
    </p>

    <h3>Priority</h3>
    <p>
      Priority is a training-priority metric, not a win-rate metric.
      It combines how weak a line is and how often it appears.
      Current implementation is:
      <b>priority = max(0, overallScore − adjustedLineScore) × games</b>.
    </p>
    <p>
      Meaning:
      a line that is slightly weak but very frequent can be higher priority than a very weak line you almost never reach.
    </p>
    <p>
      In practice: <b>sort by Priority first</b> when deciding what to drill.
    </p>

    <h3>How to use this in training</h3>
    <ol>
      <li>Pick top 1-3 lines by Priority.</li>
      <li>Use Preview to inspect the branch and opponent continuations.</li>
      <li>Use Open in trainer from board preview to train from that line.</li>
      <li>After new games, re-check if Priority and Vs Elo improved.</li>
    </ol>

    <h3>Limits</h3>
    <p>
      These metrics are outcome-based and can still hide tactical/positional reasons.
      Use them to prioritize review, then validate with board analysis and concrete game examples.
    </p>
  `;

  modal.append(header, body);
  overlay.append(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeTheoryModal();
  });

  theoryOverlayEl = overlay;
  parent.append(overlay);
}

function openTheoryModal(): void {
  if (!theoryOverlayEl) return;
  theoryOverlayEl.classList.remove('hidden');
}

function closeTheoryModal(): void {
  if (!theoryOverlayEl) return;
  theoryOverlayEl.classList.add('hidden');
}

function closeTheoryModalIfOpen(): boolean {
  if (!theoryOverlayEl || theoryOverlayEl.classList.contains('hidden')) return false;
  closeTheoryModal();
  return true;
}

// ── Stats Row ──

function renderStatsRow(parent: HTMLElement, report: ReportData): void {
  const row = el('div', 'report-stats-row');

  const stats = [
    { label: 'Games', value: formatNum(report.totalGames) },
    { label: 'Win Rate', value: `${report.overallWinRate}%` },
    { label: 'As White', value: `${winRatePct(report.asWhite)}%` },
    { label: 'As Black', value: `${winRatePct(report.asBlack)}%` },
  ];

  for (const s of stats) {
    const card = el('div', 'report-stat');
    const val = el('div', 'report-stat-value');
    val.textContent = s.value;
    const label = el('div', 'report-stat-label');
    label.textContent = s.label;
    card.append(val, label);
    row.append(card);
  }

  parent.append(row);
}

// ── WDL Bar ──

function renderWDLBar(parent: HTMLElement, wdl: WDL): void {
  if (wdl.total === 0) return;
  const wrap = el('div', 'report-wdl-wrap');

  const bar = el('div', 'report-wdl-bar');
  const wPct = (wdl.wins / wdl.total) * 100;
  const dPct = (wdl.draws / wdl.total) * 100;
  const bPct = (wdl.losses / wdl.total) * 100;

  const wEl = el('div', 'bar-white');
  wEl.style.width = `${wPct}%`;
  if (wPct >= 10) wEl.textContent = `${Math.round(wPct)}%`;

  const dEl = el('div', 'bar-draw');
  dEl.style.width = `${dPct}%`;
  if (dPct >= 8) dEl.textContent = `${Math.round(dPct)}%`;

  const bEl = el('div', 'bar-black');
  bEl.style.width = `${bPct}%`;
  if (bPct >= 10) bEl.textContent = `${Math.round(bPct)}%`;

  bar.append(wEl, dEl, bEl);

  const legend = el('div', 'report-wdl-legend');
  legend.innerHTML = `<span>${wdl.wins}W</span> <span>${wdl.draws}D</span> <span>${wdl.losses}L</span>`;

  wrap.append(bar, legend);
  parent.append(wrap);
}

// ── Sparkline ──

function renderSparkline(parent: HTMLElement, trend: { month: string; avgRating: number }[]): void {
  const section = el('div', 'report-chart-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Rating Trend';
  section.append(heading);

  const filtered = trend.filter(t => t.avgRating > 0);
  if (filtered.length < 2) {
    section.append(textEl('div', 'report-chart-empty', 'Not enough data'));
    parent.append(section);
    return;
  }

  const width = 320;
  const height = 96;
  const padX = 36;
  const padY = 16;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const ratings = filtered.map(t => t.avgRating);
  const minR = Math.min(...ratings) - 20;
  const maxR = Math.max(...ratings) + 20;
  const range = maxR - minR || 1;

  const points = filtered.map((t, i) => {
    const x = padX + (i / (filtered.length - 1)) * plotW;
    const y = padY + plotH - ((t.avgRating - minR) / range) * plotH;
    return { x, y, month: t.month, rating: t.avgRating };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaD = pathD + ` L${points[points.length - 1].x.toFixed(1)},${(padY + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(padY + plotH).toFixed(1)} Z`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'report-sparkline');

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', areaD);
  area.setAttribute('class', 'sparkline-area');
  svg.append(area);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', pathD);
  line.setAttribute('class', 'sparkline-line');
  svg.append(line);

  const last = points[points.length - 1];
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', last.x.toFixed(1));
  dot.setAttribute('cy', last.y.toFixed(1));
  dot.setAttribute('r', '3');
  dot.setAttribute('class', 'sparkline-dot');
  svg.append(dot);

  const topLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  topLabel.setAttribute('x', (padX - 4).toString());
  topLabel.setAttribute('y', (padY + 4).toString());
  topLabel.setAttribute('class', 'sparkline-label');
  topLabel.textContent = Math.round(maxR).toString();
  svg.append(topLabel);

  const botLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  botLabel.setAttribute('x', (padX - 4).toString());
  botLabel.setAttribute('y', (padY + plotH).toString());
  botLabel.setAttribute('class', 'sparkline-label');
  botLabel.textContent = Math.round(minR).toString();
  svg.append(botLabel);

  const curLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  curLabel.setAttribute('x', (last.x + 6).toString());
  curLabel.setAttribute('y', (last.y + 4).toString());
  curLabel.setAttribute('class', 'sparkline-current');
  curLabel.textContent = last.rating.toString();
  svg.append(curLabel);

  section.append(svg);
  parent.append(section);
}

// ── Time Control Table ──

function renderTimeControlTable(parent: HTMLElement, stats: { timeClass: string; wdl: WDL; winRate: number }[]): void {
  const section = el('div', 'report-chart-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'By Time Control';
  section.append(heading);

  const table = el('div', 'report-tc-table');

  for (const tc of stats) {
    const row = el('div', 'report-tc-row');

    const name = el('span', 'report-tc-name');
    name.textContent = capitalize(tc.timeClass);

    const games = el('span', 'report-tc-games');
    games.textContent = `${formatNum(tc.wdl.total)}g`;

    const rate = el('span', 'report-tc-rate');
    rate.textContent = `${tc.winRate}%`;

    const bar = el('div', 'report-tc-bar');
    const wPct = tc.wdl.total > 0 ? (tc.wdl.wins / tc.wdl.total) * 100 : 0;
    const dPct = tc.wdl.total > 0 ? (tc.wdl.draws / tc.wdl.total) * 100 : 0;
    const bPct = tc.wdl.total > 0 ? (tc.wdl.losses / tc.wdl.total) * 100 : 0;

    const wEl = el('div', 'bar-white');
    wEl.style.width = `${wPct}%`;
    const dEl = el('div', 'bar-draw');
    dEl.style.width = `${dPct}%`;
    const bEl = el('div', 'bar-black');
    bEl.style.width = `${bPct}%`;
    bar.append(wEl, dEl, bEl);

    row.append(name, games, rate, bar);
    table.append(row);
  }

  section.append(table);
  parent.append(section);
}

// ── Opening Table ──

type SortKey = 'games' | 'winRate' | 'delta' | 'impact';
type SortDir = 'asc' | 'desc';

function renderOpeningTable(parent: HTMLElement, title: string, lines: OpeningLine[]): void {
  const section = el('div', 'report-opening-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = title;
  section.append(heading);

  const table = el('div', 'report-opening-table');
  let sortKey: SortKey = 'impact';
  let sortDir: SortDir = 'desc';

  function sortValue(line: OpeningLine, key: SortKey): number {
    if (key === 'games') return line.wdl.total;
    if (key === 'winRate') return line.winRate;
    if (key === 'impact') return line.impact;
    return eloSwingForLine(line);
  }

  function renderRows(): void {
    // Remove existing rows (keep header)
    table.querySelectorAll('.report-opening-row:not(.report-opening-header)').forEach(r => r.remove());

    const sorted = [...lines].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      return sortDir === 'desc' ? bv - av : av - bv;
    });

    for (const line of sorted.slice(0, 10)) {
      const row = el('div', 'report-opening-row');
      row.classList.add(line.color === 'white' ? 'side-white' : 'side-black');
      row.addEventListener('click', () => {
        table.querySelectorAll('.report-opening-row.selected').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        selectLine(line);
      });

      const labelCell = el('div', 'report-opening-label-cell');
      const labelText = el('div', 'report-opening-label-text');
      const label = el('span', 'report-opening-label');
      label.textContent = line.displayLabel;
      label.title = line.openingName ? `${line.displayLabel}\n${line.label}` : line.label;
      labelText.append(label);
      if (line.openingName && line.label) {
        const sub = el('span', 'report-opening-subline');
        sub.textContent = line.label;
        sub.title = line.label;
        labelText.append(sub);
      }
      const conf = el('span', `report-confidence ${line.confidence}`);
      conf.textContent = line.confidence.charAt(0).toUpperCase();
      conf.setAttribute('data-tooltip', confidenceTooltip(line));
      conf.classList.add('tooltip-wide');
      labelCell.append(labelText, conf);

      const games = el('span', 'report-opening-games');
      games.textContent = formatNum(line.wdl.total);
      games.setAttribute('data-tooltip', gamesTooltip(line));

      const win = el('span', 'report-opening-rate');
      win.textContent = `${line.winRate}%`;
      if (line.winRate >= 55) win.classList.add('good');
      else if (line.winRate <= 45) win.classList.add('bad');
      win.setAttribute('data-tooltip', winRateTooltip(line));
      win.classList.add('tooltip-wide');

      const delta = el('span', 'report-opening-delta');
      const eloSwing = eloSwingForLine(line);
      delta.textContent = formatSignedNum(eloSwing);
      if (eloSwing > 0) delta.classList.add('good');
      if (eloSwing < 0) delta.classList.add('bad');
      delta.setAttribute('data-tooltip', eloSwingTooltip(line));
      delta.classList.add('tooltip-wide');

      const impact = el('span', 'report-opening-impact');
      impact.textContent = formatImpact(line.impact);
      if (line.impact >= 2) impact.classList.add('bad');
      impact.setAttribute('data-tooltip', impactTooltip(line));
      impact.classList.add('tooltip-wide');

      row.append(labelCell, games, win, delta, impact);
      table.append(row);
    }
  }

  function handleSort(key: SortKey): void {
    if (sortKey === key) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortKey = key;
      sortDir = 'desc';
    }
    updateHeaderIndicators();
    renderRows();
  }

  const headerRow = el('div', 'report-opening-row report-opening-header');
  const hLabel = el('span', 'report-opening-label');
  hLabel.textContent = 'Opening';
  const hGames = el('span', 'report-opening-games sortable');
  hGames.textContent = 'Games';
  hGames.setAttribute('data-tooltip', 'How often this line appears in your filtered games.');
  hGames.addEventListener('click', () => handleSort('games'));
  const hRate = el('span', 'report-opening-rate sortable');
  hRate.textContent = 'Win%';
  hRate.setAttribute('data-tooltip', 'Raw win percentage: wins / total games in this line.');
  hRate.addEventListener('click', () => handleSort('winRate'));
  const hDelta = el('span', 'report-opening-delta sortable');
  hDelta.textContent = '~Elo Δ';
  hDelta.setAttribute('data-tooltip', 'Simple estimate: (wins - losses) * 8. Draws count as 0.');
  hDelta.addEventListener('click', () => handleSort('delta'));
  const hImpact = el('span', 'report-opening-impact sortable');
  hImpact.textContent = 'Priority';
  hImpact.setAttribute('data-tooltip', 'Training priority: combines line weakness and line frequency.');
  hImpact.classList.add('tooltip-wide');
  hImpact.addEventListener('click', () => handleSort('impact'));
  headerRow.append(hLabel, hGames, hRate, hDelta, hImpact);

  function updateHeaderIndicators(): void {
    hGames.classList.toggle('sort-active', sortKey === 'games');
    hRate.classList.toggle('sort-active', sortKey === 'winRate');
    hDelta.classList.toggle('sort-active', sortKey === 'delta');
    hImpact.classList.toggle('sort-active', sortKey === 'impact');
  }

  table.append(headerRow);
  updateHeaderIndicators();
  renderRows();

  section.append(table);
  parent.append(section);
}

// ── Weakness Queue ──

function renderWeaknessQueue(parent: HTMLElement, lines: OpeningLine[]): void {
  const section = el('div', 'report-findings-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Priority Weaknesses';
  section.append(heading);

  const list = el('div', 'report-weakness-list');

  for (const line of lines) {
    const card = el('div', 'report-weakness-card');
    card.classList.add(line.color === 'white' ? 'side-white' : 'side-black');
    card.addEventListener('click', () => selectLine(line));
    if (line.impact >= 3) card.classList.add('severity-high');
    else if (line.impact >= 1.5) card.classList.add('severity-mid');
    else card.classList.add('severity-low');

    const top = el('div', 'report-weakness-top');
    const titleRow = el('div', 'report-line-title-row');
    const label = el('div', 'report-weakness-label');
    label.textContent = line.displayLabel;
    label.title = line.openingName ? `${line.displayLabel}\n${line.label}` : line.label;
    const gamesBadge = el('span', 'report-line-games-badge');
    gamesBadge.textContent = `${formatNum(line.wdl.total)} games`;
    gamesBadge.setAttribute('data-tooltip', 'Number of games in this line after filters.');
    titleRow.append(label, gamesBadge);
    if (line.openingName && line.label) {
      const sub = el('div', 'report-weakness-subline');
      sub.textContent = line.label;
      sub.title = line.label;
      top.append(titleRow, sub);
    } else {
      top.append(titleRow);
    }

    const stats = el('div', 'report-weakness-stats');
    const adjChip = document.createElement('span');
    adjChip.className = 'chip-adj';
    adjChip.textContent = `Win ${line.winRate}%`;
    adjChip.setAttribute('data-tooltip', winRateTooltip(line));
    adjChip.classList.add('tooltip-wide');

    const expChip = document.createElement('span');
    expChip.className = 'chip-exp';
    expChip.textContent = `~Elo Δ ${formatSignedNum(eloSwingForLine(line))}`;
    expChip.setAttribute('data-tooltip', eloSwingTooltip(line));
    expChip.classList.add('tooltip-wide');

    const impactChip = document.createElement('span');
    impactChip.className = 'chip-impact';
    impactChip.textContent = `Priority ${formatImpact(line.impact)}`;
    impactChip.setAttribute('data-tooltip', impactTooltip(line));
    impactChip.classList.add('tooltip-wide');

    stats.append(adjChip, expChip, impactChip);
    top.append(stats);

    card.append(top);
    list.append(card);
  }

  section.append(list);
  parent.append(section);
}

// ── Highlights ──

function renderHighlights(parent: HTMLElement, lines: OpeningLine[]): void {
  const section = el('div', 'report-findings-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Highlights (What Works)';
  section.append(heading);

  const list = el('div', 'report-highlights-list');
  for (const line of lines) {
    const card = el('div', 'report-highlight-card');
    card.classList.add(line.color === 'white' ? 'side-white' : 'side-black');
    card.addEventListener('click', () => selectLine(line));
    const titleRow = el('div', 'report-line-title-row');
    const label = el('div', 'report-highlight-label');
    label.textContent = line.displayLabel;
    label.title = line.openingName ? `${line.displayLabel}\n${line.label}` : line.label;
    const gamesBadge = el('span', 'report-line-games-badge');
    gamesBadge.textContent = `${formatNum(line.wdl.total)} games`;
    gamesBadge.setAttribute('data-tooltip', 'Number of games in this line after filters.');
    titleRow.append(label, gamesBadge);
    if (line.openingName && line.label) {
      const sub = el('div', 'report-highlight-subline');
      sub.textContent = line.label;
      sub.title = line.label;
      card.append(titleRow, sub);
    } else {
      card.append(titleRow);
    }

    const stats = el('div', 'report-highlight-stats');
    const adj = document.createElement('span');
    adj.textContent = `Win ${line.winRate}%`;
    adj.setAttribute('data-tooltip', winRateTooltip(line));
    adj.classList.add('tooltip-wide');
    const exp = document.createElement('span');
    exp.textContent = `~Elo Δ ${formatSignedNum(eloSwingForLine(line))}`;
    exp.setAttribute('data-tooltip', eloSwingTooltip(line));
    exp.classList.add('tooltip-wide');
    stats.append(adj, exp);

    card.append(stats);
    list.append(card);
  }
  section.append(list);
  parent.append(section);
}

// ── Board Preview & Line Navigation ──

function selectLine(line: OpeningLine): void {
  selectedLine = line;
  lineViewIndex = line.ucis.length; // start at the end
  lineGameResultFilter = 'all';

  // Orient board to match the opening color
  if (reportCg) {
    reportCg.set({ orientation: line.color });
  }

  // Compute FENs for each ply
  lineFens = [];
  lineLastMoves = [];
  const chess = Chess.default();
  lineFens.push(makeFen(chess.toSetup()));
  lineLastMoves.push(undefined);

  for (const uci of line.ucis) {
    const move = parseUci(uci);
    if (!move) break;
    chess.play(move);
    lineFens.push(makeFen(chess.toSetup()));
    lineLastMoves.push([uci.slice(0, 2) as Key, uci.slice(2, 4) as Key]);
  }

  updateBoardForLine();
}

function navigateLine(delta: number): void {
  if (!selectedLine) return;
  const newIdx = lineViewIndex + delta;
  if (newIdx < 0 || newIdx >= lineFens.length) return;
  lineViewIndex = newIdx;
  updateBoardForLine();
}

function updateBoardForLine(): void {
  if (!reportCg || !selectedLine) return;

  const fen = lineFens[lineViewIndex];
  const lastMove = lineLastMoves[lineViewIndex];
  reportCg.set({ fen, lastMove });

  // Update move label under board
  const labelEl = document.querySelector('.report-board-label');
  if (labelEl) {
    labelEl.innerHTML = '';
    const moves = selectedLine.moves;
    for (let i = 0; i < moves.length; i++) {
      // Add move number
      if (i % 2 === 0) {
        const num = document.createElement('span');
        num.className = 'report-line-movenum';
        num.textContent = `${Math.floor(i / 2) + 1}.`;
        labelEl.append(num);
      }
      const span = document.createElement('span');
      span.className = 'report-line-move';
      if (i + 1 === lineViewIndex) span.classList.add('active');
      span.textContent = moves[i];
      span.addEventListener('click', () => {
        lineViewIndex = i + 1;
        updateBoardForLine();
      });
      labelEl.append(span);
      if (i < moves.length - 1) labelEl.append(document.createTextNode(' '));
    }
  }

  // Update nav button states
  const prevBtn = document.querySelector('.report-nav-prev') as HTMLButtonElement | null;
  const nextBtn = document.querySelector('.report-nav-next') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = lineViewIndex <= 0;
  if (nextBtn) nextBtn.disabled = lineViewIndex >= lineFens.length - 1;

  // Update counter
  const counter = document.querySelector('.report-nav-counter');
  if (counter) counter.textContent = `${lineViewIndex} / ${lineFens.length - 1}`;

  // Update "Open in trainer" button visibility
  const trainerBtn = document.querySelector('.report-trainer-btn');
  if (trainerBtn) {
    trainerBtn.classList.toggle('hidden', lineViewIndex <= 0 || !reportNavigateCallback);
  }

  // Update continuations from this position
  renderContinuations(fen);
  renderSelectedLineGames();
}

// ── Continuations ──

function renderContinuations(fen: string): void {
  const container = document.querySelector('.report-continuations');
  if (!container) return;
  container.innerHTML = '';

  const data = queryPersonalExplorer(fen);
  if (!data || data.moves.length === 0) return;

  const heading = el('div', 'report-continuations-title');
  heading.textContent = 'Continuations';
  container.append(heading);

  for (const move of data.moves.slice(0, 8)) {
    const total = move.white + move.draws + move.black;
    if (total === 0) continue;

    const row = el('div', 'report-cont-row');
    row.addEventListener('click', () => extendLine(move.uci, move.san));

    const san = el('span', 'report-cont-san');
    san.textContent = move.san;

    const games = el('span', 'report-cont-games');
    games.textContent = formatNum(total);

    const isWhite = selectedLine?.color === 'white';
    const userWins = isWhite ? move.white : move.black;
    const rate = el('span', 'report-cont-rate');
    const pct = Math.round((userWins / total) * 100);
    rate.textContent = `${pct}%`;
    if (pct >= 55) rate.classList.add('good');
    else if (pct <= 40) rate.classList.add('bad');

    const bar = el('div', 'report-cont-bar');
    const wPct = (move.white / total) * 100;
    const dPct = (move.draws / total) * 100;
    const bPct = (move.black / total) * 100;
    const wEl = el('div', 'bar-white');
    wEl.style.width = `${wPct}%`;
    const dEl = el('div', 'bar-draw');
    dEl.style.width = `${dPct}%`;
    const bEl = el('div', 'bar-black');
    bEl.style.width = `${bPct}%`;
    bar.append(wEl, dEl, bEl);

    row.append(san, games, rate, bar);
    container.append(row);
  }
}

type LineGameRow = {
  href: string;
  result: 'win' | 'draw' | 'loss';
  userRating: number;
  oppRating: number;
  month: string;
  opponent: string | null;
};

function userResultForGame(game: GameMeta): 'win' | 'draw' | 'loss' {
  if (game.re === 'd') return 'draw';
  if (game.re === 'w') return game.uw ? 'win' : 'loss';
  return game.uw ? 'loss' : 'win';
}

function parentFenAndLastUci(ucis: string[]): { fen: string; uci: string } | null {
  if (ucis.length === 0) return null;
  const chess = Chess.default();
  for (let i = 0; i < ucis.length - 1; i++) {
    const move = parseUci(ucis[i]);
    if (!move) return null;
    chess.play(move);
  }
  return { fen: makeFen(chess.toSetup()), uci: ucis[ucis.length - 1] };
}

function getLineGameRows(line: OpeningLine): LineGameRow[] {
  const parent = parentFenAndLastUci(line.ucis);
  const games = getPersonalGames();
  if (!parent || !games) return [];

  const indices = queryPersonalMoveGameIndices(parent.fen, parent.uci);
  const rows: LineGameRow[] = [];
  for (const idx of indices) {
    const g = games[idx];
    if (!g?.gl) continue;
    rows.push({
      href: g.gl,
      result: userResultForGame(g),
      userRating: g.ur,
      oppRating: g.or,
      month: g.mo,
      opponent: g.op ?? null,
    });
  }
  rows.sort((a, b) => {
    if (!a.month || a.month === 'unknown') return 1;
    if (!b.month || b.month === 'unknown') return -1;
    return b.month.localeCompare(a.month);
  });
  return rows;
}

function renderSelectedLineGames(): void {
  const container = document.querySelector('.report-line-games');
  if (!container) return;
  container.innerHTML = '';

  const title = el('div', 'report-line-games-title');
  const titleLabel = el('span', 'report-line-games-title-label');
  titleLabel.textContent = 'Line games';
  title.append(titleLabel);
  container.append(title);

  if (!selectedLine) {
    const empty = el('div', 'report-line-games-empty');
    empty.textContent = 'Select an opening to list matching games.';
    container.append(empty);
    return;
  }

  const rows = getLineGameRows(selectedLine);
  const totals = {
    win: rows.filter(r => r.result === 'win').length,
    draw: rows.filter(r => r.result === 'draw').length,
    loss: rows.filter(r => r.result === 'loss').length,
  };
  const totalLabel = el('span', 'report-line-games-total');
  totalLabel.textContent = `${formatNum(rows.length)} total`;
  title.append(totalLabel);

  const filterRow = el('div', 'report-line-games-filters');
  const filters = el('div', 'segment-picker segment-sm') as HTMLDivElement;
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Line game results');
  const opts: Array<{ key: 'win' | 'draw' | 'loss'; label: string; count: number }> = [
    { key: 'win', label: 'Win', count: totals.win },
    { key: 'draw', label: 'Draw', count: totals.draw },
    { key: 'loss', label: 'Loss', count: totals.loss },
  ];
  for (const opt of opts) {
    const segmentBtn = el('button', 'segment-btn') as HTMLButtonElement;
    segmentBtn.type = 'button';
    segmentBtn.textContent = `${opt.label} (${formatNum(opt.count)})`;
    const isSelected = lineGameResultFilter === opt.key;
    if (isSelected) segmentBtn.classList.add('selected');
    segmentBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    segmentBtn.addEventListener('click', () => {
      lineGameResultFilter = lineGameResultFilter === opt.key ? 'all' : opt.key;
      renderSelectedLineGames();
    });
    filters.append(segmentBtn);
  }
  filterRow.append(filters);
  container.append(filterRow);

  const list = el('div', 'report-line-games-list');
  const shown = lineGameResultFilter === 'all'
    ? rows
    : rows.filter(r => r.result === lineGameResultFilter);

  if (shown.length === 0) {
    const empty = el('div', 'report-line-games-empty');
    empty.textContent = 'No games for this result filter.';
    list.append(empty);
  } else {
    for (const row of shown) {
      const link = document.createElement('a');
      link.className = 'report-line-game-row';
      link.href = row.href;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';

      const result = document.createElement('span');
      result.className = `report-line-game-result ${row.result}`;
      result.textContent = row.result === 'win' ? 'W' : row.result === 'draw' ? 'D' : 'L';

      const meta = el('div', 'report-line-game-meta');
      const opp = el('div', 'report-line-game-opp');
      opp.textContent = row.opponent ? row.opponent : 'Game';
      const subMeta = el('div', 'report-line-game-submeta');
      const month = el('div', 'report-line-game-month');
      month.textContent = row.month || '';

      const ratings = el('span', 'report-line-game-rating');
      const or = row.oppRating > 0 ? row.oppRating : '—';
      ratings.textContent = `Opp ${or}`;
      const external = el('span', 'report-line-game-external');
      external.setAttribute('aria-hidden', 'true');
      external.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z"/><path fill="currentColor" d="M5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>';

      subMeta.append(month, ratings);
      meta.append(opp, subMeta);

      link.append(result, meta, external);
      list.append(link);
    }
  }

  container.append(list);
}

function extendLine(uci: string, san: string): void {
  if (!selectedLine) return;

  // If we're not at the end of the line, truncate future moves first
  if (lineViewIndex < lineFens.length - 1) {
    selectedLine.moves.splice(lineViewIndex);
    selectedLine.ucis.splice(lineViewIndex);
    lineFens.splice(lineViewIndex + 1);
    lineLastMoves.splice(lineViewIndex + 1);
  }

  // Replay all UCIs + the new one from scratch to get the new FEN
  const chess = Chess.default();
  for (const u of selectedLine.ucis) {
    const m = parseUci(u);
    if (m) chess.play(m);
  }
  const move = parseUci(uci);
  if (!move) return;
  chess.play(move);

  const newFen = makeFen(chess.toSetup());
  selectedLine.moves.push(san);
  selectedLine.ucis.push(uci);
  selectedLine.label = selectedLine.moves.join(' ');
  lineFens.push(newFen);
  lineLastMoves.push([uci.slice(0, 2) as Key, uci.slice(2, 4) as Key]);

  lineViewIndex = lineFens.length - 1;
  updateBoardForLine();
}

// ── Helpers ──

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const e = el(tag, className);
  e.textContent = text;
  return e;
}

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toString();
}

function formatSignedNum(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n}`;
}

function formatImpact(n: number): string {
  return n.toFixed(2).replace(/\.00$/, '');
}

function gamesTooltip(line: OpeningLine): string {
  return `Record in this line: ${line.wdl.wins}W ${line.wdl.draws}D ${line.wdl.losses}L `
    + `(${line.wdl.total} games).`;
}

function winRateTooltip(line: OpeningLine): string {
  const total = line.wdl.total;
  if (total <= 0) return 'Win% unavailable: no games in this line yet.';

  const wins = line.wdl.wins;
  const draws = line.wdl.draws;
  const losses = line.wdl.losses;
  return `Win% = wins / games = ${wins} / ${total} = ${line.winRate}%. `
    + `Record: ${wins}W ${draws}D ${losses}L.`;
}

function eloSwingForLine(line: OpeningLine): number {
  const ELO_PER_DECISIVE_GAME = 8;
  return (line.wdl.wins - line.wdl.losses) * ELO_PER_DECISIVE_GAME;
}

function eloSwingTooltip(line: OpeningLine): string {
  const wins = line.wdl.wins;
  const losses = line.wdl.losses;
  const draws = line.wdl.draws;
  const swing = eloSwingForLine(line);
  return `Simple Elo estimate: (wins - losses) * 8 = (${wins} - ${losses}) * 8 `
    + `= ${swing > 0 ? '+' : ''}${swing}. Draws (${draws}) count as 0.`;
}

function impactTooltip(line: OpeningLine): string {
  return `Priority is a calculated urgency score using: `
    + `score shortfall vs your baseline, line frequency (games), and sample-size stabilization. `
    + `Current value: ${formatImpact(line.impact)} (higher = more training value).`;
}

function confidenceTooltip(line: OpeningLine): string {
  const n = line.wdl.total;
  if (n <= 0) return 'Confidence: no samples yet.';
  return `${capitalize(line.confidence)} confidence from ${n} games. `
    + `Expected swing is about +/-${line.scoreCiPct} points.`;
}

function winRatePct(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return Math.round((wdl.wins / wdl.total) * 100);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
