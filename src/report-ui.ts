import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import {
  getPersonalConfig, getPersonalGames, queryPersonalExplorer, hasPersonalData,
  getPersonalStats, getPersonalFilters, setPersonalFilters,
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

// Line navigation state
let selectedLine: OpeningLine | null = null;
let lineViewIndex = 0;           // 0 = starting pos, moves.length = end pos
let lineFens: string[] = [];     // FEN at each ply (index 0 = starting, length = moves.length + 1)
let lineLastMoves: (Key[] | undefined)[] = []; // lastMove highlight per ply
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

interface ReportFilters {
  timeClasses?: string[];
  minRating?: number;
  maxRating?: number;
  sinceMonth?: string;
  untilMonth?: string;
}

export function isReportPageOpen(): boolean {
  return reportOpen;
}

export function closeReportPage(): void {
  if (!reportOpen) return;
  reportOpen = false;
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
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }
  document.getElementById('app')!.style.display = '';
}

export function openReportPage(): void {
  if (reportOpen) return;
  reportOpen = true;
  // Save current explorer filters so we can restore on close
  savedFilters = getPersonalFilters();
  // Initialize report filters from main config speeds
  const appConfig = loadConfig();
  reportFilters = { timeClasses: [...appConfig.speeds] };

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
    return true;
  });
}

function hasActiveFilters(f: ReportFilters): boolean {
  return !!(
    (f.timeClasses && f.timeClasses.length > 0) ||
    f.minRating != null ||
    f.maxRating != null ||
    f.sinceMonth ||
    f.untilMonth
  );
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
  });
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

    for (const preset of presets) {
      const chip = el('button', 'chip chip-sm');
      chip.dataset.since = preset.since;
      chip.dataset.until = preset.until;
      const isActive = (reportFilters.sinceMonth ?? '') === preset.since &&
        (reportFilters.untilMonth ?? '') === preset.until;
      if (isActive) chip.classList.add('selected');
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        // Deselect other period chips
        group.querySelectorAll('.chip[data-since]').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        reportFilters.sinceMonth = preset.since || undefined;
        reportFilters.untilMonth = preset.until || undefined;
        rerender();
      });
      group.append(chip);
    }
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
      reportFilters = {};
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
  rerender();
}

// ── Report Content (below filters) ──

function renderReportContent(content: HTMLElement, report: ReportData): void {
  // Stats row
  renderStatsRow(content, report);

  // WDL bar
  renderWDLBar(content, report.overall);

  // Main body: two-column layout for charts + opening tables + board
  const body = el('div', 'report-body');
  content.append(body);

  const mainCol = el('div', 'report-main-col');
  body.append(mainCol);

  // Rating trend + Time control section
  const chartsRow = el('div', 'report-charts-row');
  mainCol.append(chartsRow);

  if (report.ratingTrend.length > 1 && report.ratingTrend.some(r => r.avgRating > 0)) {
    renderSparkline(chartsRow, report.ratingTrend);
  }

  if (report.byTimeControl.length > 0) {
    renderTimeControlTable(chartsRow, report.byTimeControl);
  }

  // Opening tables
  if (report.whiteOpenings.length > 0) {
    renderOpeningTable(mainCol, 'White Openings', report.whiteOpenings);
  }
  if (report.blackOpenings.length > 0) {
    renderOpeningTable(mainCol, 'Black Openings', report.blackOpenings);
  }

  // Key findings
  if (report.bestOpenings.length > 0 || report.worstOpenings.length > 0) {
    renderKeyFindings(mainCol, report.bestOpenings, report.worstOpenings);
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
    };
    reportNavigateCallback(moves, fen, selectedLine.color, filters);
  });
  boardCol.append(trainerBtn);

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
  const height = 120;
  const padX = 40;
  const padY = 20;
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

type SortKey = 'games' | 'winRate';
type SortDir = 'asc' | 'desc';

function renderOpeningTable(parent: HTMLElement, title: string, lines: OpeningLine[]): void {
  const section = el('div', 'report-opening-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = title;
  section.append(heading);

  const table = el('div', 'report-opening-table');
  let sortKey: SortKey = 'games';
  let sortDir: SortDir = 'desc';

  function renderRows(): void {
    // Remove existing rows (keep header)
    table.querySelectorAll('.report-opening-row:not(.report-opening-header)').forEach(r => r.remove());

    const sorted = [...lines].sort((a, b) => {
      const av = sortKey === 'games' ? a.wdl.total : a.winRate;
      const bv = sortKey === 'games' ? b.wdl.total : b.winRate;
      return sortDir === 'desc' ? bv - av : av - bv;
    });

    for (const line of sorted.slice(0, 15)) {
      const row = el('div', 'report-opening-row');
      row.addEventListener('click', () => {
        table.querySelectorAll('.report-opening-row.selected').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        selectLine(line);
      });

      const label = el('span', 'report-opening-label');
      label.textContent = line.label;
      label.title = line.label;

      const games = el('span', 'report-opening-games');
      games.textContent = formatNum(line.wdl.total);

      const rate = el('span', 'report-opening-rate');
      rate.textContent = `${line.winRate}%`;
      if (line.winRate >= 55) rate.classList.add('good');
      else if (line.winRate <= 40) rate.classList.add('bad');

      const barCell = el('span', 'report-opening-bar-cell');
      const bar = el('div', 'report-tc-bar');
      if (line.wdl.total > 0) {
        const wPct = (line.wdl.wins / line.wdl.total) * 100;
        const dPct = (line.wdl.draws / line.wdl.total) * 100;
        const bPct = (line.wdl.losses / line.wdl.total) * 100;
        const wEl = el('div', 'bar-white');
        wEl.style.width = `${wPct}%`;
        const dEl = el('div', 'bar-draw');
        dEl.style.width = `${dPct}%`;
        const bEl = el('div', 'bar-black');
        bEl.style.width = `${bPct}%`;
        bar.append(wEl, dEl, bEl);
      }
      barCell.append(bar);

      row.append(label, games, rate, barCell);
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
  hGames.addEventListener('click', () => handleSort('games'));
  const hRate = el('span', 'report-opening-rate sortable');
  hRate.textContent = 'Win%';
  hRate.addEventListener('click', () => handleSort('winRate'));
  const hBar = el('span', 'report-opening-bar-cell');
  hBar.textContent = 'W / D / L';
  headerRow.append(hLabel, hGames, hRate, hBar);

  function updateHeaderIndicators(): void {
    hGames.classList.toggle('sort-active', sortKey === 'games');
    hRate.classList.toggle('sort-active', sortKey === 'winRate');
  }

  table.append(headerRow);
  updateHeaderIndicators();
  renderRows();

  section.append(table);
  parent.append(section);
}

// ── Key Findings ──

function renderKeyFindings(parent: HTMLElement, best: OpeningLine[], worst: OpeningLine[]): void {
  const section = el('div', 'report-findings-section');
  const heading = el('div', 'report-section-title');
  heading.textContent = 'Key Findings';
  section.append(heading);

  const list = el('div', 'report-findings-list');

  for (const line of best) {
    const row = el('div', 'report-finding best');
    row.innerHTML = `<span class="finding-dot best"></span>`;
    const text = el('span', 'finding-text');
    text.textContent = `Best: ${line.label}`;
    const stats = el('span', 'finding-stats');
    stats.textContent = `${line.winRate}%, ${formatNum(line.wdl.total)}g`;
    row.append(text, stats);
    row.addEventListener('click', () => selectLine(line));
    list.append(row);
  }

  for (const line of worst) {
    const row = el('div', 'report-finding worst');
    row.innerHTML = `<span class="finding-dot worst"></span>`;
    const text = el('span', 'finding-text');
    text.textContent = `Weak: ${line.label}`;
    const stats = el('span', 'finding-stats');
    stats.textContent = `${line.winRate}%, ${formatNum(line.wdl.total)}g`;
    row.append(text, stats);
    row.addEventListener('click', () => selectLine(line));
    list.append(row);
  }

  section.append(list);
  parent.append(section);
}

// ── Board Preview & Line Navigation ──

function selectLine(line: OpeningLine): void {
  selectedLine = line;
  lineViewIndex = line.ucis.length; // start at the end

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

function winRatePct(wdl: WDL): number {
  if (wdl.total === 0) return 0;
  return Math.round((wdl.wins / wdl.total) * 100);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
