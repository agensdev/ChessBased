import type {
  AppConfig,
  AlertType,
  BotWeighting,
  ExplorerMove,
  ExplorerResponse,
  GamePhase,
  MoveBadge,
  MoveHistoryEntry,
  PlayerColor,
  PositionAnalysis,
} from './types';
import { ALL_ALERT_TYPES, RATING_OPTIONS, SPEED_OPTIONS } from './types';
import type { Key } from '@lichess-org/chessground/types';
import { getMoveHistory, getViewIndex, isViewingHistory, navigateTo, setAutoShapes, getOrientation, setOrientation, replayLine } from './board';
import {
  isMoveLocked, lockMove, unlockMove, getLockedMoves,
  getOpeningNames, getActiveOpening, switchOpening, createOpening, deleteOpening, renameOpening,
  mergeMultiple,
  FREE_PLAY_NAME,
  FULL_REPERTOIRE_NAME,
} from './repertoire';
import { importPgn, fetchStudyPgn } from './pgn-import';
import { initLibraryModal, openLibraryModal } from './opening-library';
import { findOpeningByEco, findPgnByEco } from './opening-index';
import { exportActiveOpening, exportAll } from './pgn-export';
import { getExplorerData, getExplorerCache, getPhase } from './game';
import { analyzePosition, getBadgeForMove, type ParentContext } from './analysis';
import { formatScore } from './engine';
import type { EngineLine } from './engine';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan, parseSan } from 'chessops/san';
import { makeUci } from 'chessops';
import {
  getExplorerMode, setExplorerMode, hasPersonalData, getPersonalConfig,
  queryPersonalExplorer, clearPersonalData, importFromLichess, importFromChesscom,
  initPersonalExplorer, getPersonalStats, setPersonalFilters, getPersonalFilters,
  getFilteredGameCount, getPersonalGames, gameMatchesFilters, isDBReady,
  type ExplorerMode, type Platform, type LichessFilters, type GameMeta,
} from './personal-explorer';
import { openReportPage, isReportPageOpen } from './report-ui';
import { confirmModal, type ConfirmButton } from './confirm';

type ContinueCallback = () => void;
type OpeningChangeCallback = () => void;
type ModeChangeCallback = () => void;

type ConfigChangeCallback = (config: AppConfig) => void;
type NewGameCallback = () => void;
type FlipCallback = () => void;
type ExplorerMoveClickCallback = (uci: string) => void;

type RetryExplorerCallback = () => void;

let configChangeCb: ConfigChangeCallback;
let newGameCb: NewGameCallback;
let flipCb: FlipCallback;
let explorerMoveClickCb: ExplorerMoveClickCallback | null = null;
let continueCb: ContinueCallback | null = null;
let openingChangeCb: OpeningChangeCallback | null = null;
let modeChangeCb: ModeChangeCallback | null = null;
let retryExplorerCb: RetryExplorerCallback | null = null;
let currentConfig: AppConfig;

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BAR_PCT_LABEL_ATTR = 'data-pct-label';

// Track which UCI was played next from the currently viewed position
let nextMoveUci: string | null = null;

// Current engine eval as win% for the side to move (0-100), null if unavailable
let currentEvalWinPct: number | null = null;

// Currently loaded game for replay mode
let loadedGame: GameMeta | null = null;

// Remember last engine line count so toggling on restores previous setting
let lastEngineLineCount = 3;
type HistoryLinesView = 'history' | 'lines';
let historyLinesView: HistoryLinesView = 'history';

function fitExplorerBarLabels(root: ParentNode): void {
  const segments = root.querySelectorAll<HTMLElement>(`.explorer-bar [${BAR_PCT_LABEL_ATTR}]`);
  for (const segment of segments) {
    const label = segment.getAttribute(BAR_PCT_LABEL_ATTR) ?? '';
    if (!label) {
      segment.textContent = '';
      continue;
    }
    segment.textContent = label;
    if (segment.scrollWidth > segment.clientWidth) {
      segment.textContent = '';
    }
  }
}

function scheduleExplorerBarLabelFit(root: ParentNode): void {
  requestAnimationFrame(() => fitExplorerBarLabels(root));
}


export function initUI(
  config: AppConfig,
  onConfigChange: ConfigChangeCallback,
  onNewGame: NewGameCallback,
  onFlip: FlipCallback,
  onExplorerMoveClick?: ExplorerMoveClickCallback,
  onContinue?: ContinueCallback,
  onRepertoireChange?: OpeningChangeCallback,
  onModeChange?: ModeChangeCallback,
  onRetryExplorer?: RetryExplorerCallback,
): void {
  currentConfig = { ...config };
  if (config.engineLineCount > 0) lastEngineLineCount = config.engineLineCount;
  configChangeCb = onConfigChange;
  newGameCb = onNewGame;
  flipCb = onFlip;
  explorerMoveClickCb = onExplorerMoveClick ?? null;
  continueCb = onContinue ?? null;
  openingChangeCb = onRepertoireChange ?? null;
  modeChangeCb = onModeChange ?? null;
  retryExplorerCb = onRetryExplorer ?? null;

  initPersonalExplorer().then(() => {
    // Re-render explorer panel once DB is loaded, in case user is already in personal mode
    if (getExplorerMode() === 'personal') updateExplorerPanel();
    updateRecentGamesPanel();
  });
  initHistoryLinesToggle();
  renderSystemPicker();
  renderControls();
  renderConfigPanel();
  initHelpModal();
  document.getElementById('sidebar-help-btn')?.addEventListener('click', openHelpModal);
  initTooltips();
  document.addEventListener('click', () => closeAllDropdowns());
}

function setHistoryLinesView(view: HistoryLinesView): void {
  historyLinesView = view;
  const showHistory = view === 'history';

  document.getElementById('moves')?.classList.toggle('hidden', !showHistory);
  document.getElementById('move-actions')?.classList.toggle('hidden', !showHistory);
  document.getElementById('opening-lines')?.classList.toggle('hidden', showHistory);

  const buttons = document.querySelectorAll<HTMLButtonElement>('#history-lines-toggle .segment-btn');
  buttons.forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.historyLinesView === view);
  });
}

function initHistoryLinesToggle(): void {
  const toggle = document.getElementById('history-lines-toggle');
  if (!toggle) return;

  const buttons = toggle.querySelectorAll<HTMLButtonElement>('.segment-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.historyLinesView === 'lines' ? 'lines' : 'history';
      if (view === historyLinesView) return;
      setHistoryLinesView(view);
    });
  });

  setHistoryLinesView(historyLinesView);
}

type PickerMode = 'normal' | 'rename' | 'merge-select';
let pickerMode: PickerMode = 'normal';

export function renderSystemPicker(): void {
  const el = document.getElementById('system-picker')!;
  el.innerHTML = '';

  const active = getActiveOpening();
  const isFreePlay = active === FREE_PLAY_NAME;

  if (pickerMode !== 'merge-select' && pickerMode !== 'rename') {
    pickerMode = 'normal';
  }
  renderNormalMode(el, active, isFreePlay);

  renderRepertoireActions();
}

function renderRepertoireActions(): void {
  const el = document.getElementById('repertoire-actions');
  if (!el) return;
  el.innerHTML = '';

  const active = getActiveOpening();
  const isFreePlay = active === FREE_PLAY_NAME;

  const primaryRow = document.createElement('div');
  primaryRow.className = 'repertoire-primary-row';

  const libraryBtn = document.createElement('button');
  libraryBtn.className = 'btn';
  libraryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg> Browse openings';
  libraryBtn.setAttribute('data-tooltip', 'Browse common openings to add');
  libraryBtn.addEventListener('click', () => {
    initLibraryModal(() => {
      renderSystemPicker();
      updateExplorerPanel();
      updateMoveList();
      openingChangeCb?.();
    });
    openLibraryModal();
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'btn';
  importBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Import PGN';
  importBtn.setAttribute('data-tooltip', 'Import from PGN or Lichess study');
  importBtn.addEventListener('click', () => openPgnModal());

  primaryRow.append(libraryBtn, importBtn);

  const overflowWrap = document.createElement('div');
  overflowWrap.className = 'overflow-btn-wrap';

  const overflowBtn = document.createElement('button');
  overflowBtn.className = 'btn icon';
  overflowBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  overflowBtn.setAttribute('data-tooltip', 'More actions');

  const overflowMenu = document.createElement('div');
  overflowMenu.className = 'overflow-menu';

  const copyItem = document.createElement('button');
  copyItem.className = 'overflow-menu-item';
  copyItem.textContent = 'Copy PGN';
  copyItem.disabled = isFreePlay;
  copyItem.addEventListener('click', () => {
    const pgn = exportActiveOpening();
    if (!pgn) return;
    navigator.clipboard.writeText(pgn).then(() => {
      const orig = copyItem.textContent;
      copyItem.textContent = 'Copied!';
      setTimeout(() => { copyItem.textContent = orig; }, 1500);
    });
    overflowMenu.classList.remove('visible');
  });

  const exportAllItem = document.createElement('button');
  exportAllItem.className = 'overflow-menu-item';
  exportAllItem.textContent = 'Export repertoire';
  exportAllItem.addEventListener('click', () => {
    downloadPgn(exportAll(), 'repertoire.pgn');
    overflowMenu.classList.remove('visible');
  });

  overflowMenu.append(copyItem, exportAllItem);

  overflowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !overflowMenu.classList.contains('visible');
    overflowMenu.classList.toggle('visible');
    if (opening) {
      const close = () => {
        overflowMenu.classList.remove('visible');
        document.removeEventListener('click', close);
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  });

  overflowWrap.append(overflowBtn, overflowMenu);
  primaryRow.append(overflowWrap);

  el.append(primaryRow);
}

const SVG_EDIT = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const SVG_GLOBE = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const SVG_BOOK = '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>';

const SVG_LAYERS = '<svg viewBox="0 0 24 24"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z"/></svg>';
const SVG_MERGE = '<svg viewBox="0 0 24 24"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>';
const SVG_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

let dropdownOpen = false;
let mergeSelected: Set<string> = new Set();
let dropdownOutsideClickCleanup: (() => void) | null = null;

function makeCardIcon(type: 'free-play' | 'full-rep' | 'custom'): HTMLElement {
  const icon = document.createElement('div');
  icon.className = `system-card-icon ${type}`;
  const svgMap = { 'free-play': SVG_GLOBE, 'full-rep': SVG_LAYERS, 'custom': SVG_BOOK };
  const tooltipMap = { 'free-play': 'Free Play', 'full-rep': 'Full Repertoire', 'custom': 'Custom opening' };
  icon.innerHTML = svgMap[type];
  icon.setAttribute('data-tooltip', tooltipMap[type]);
  icon.classList.add('tooltip-below');
  icon.querySelector('svg')!.setAttribute('width', '16');
  icon.querySelector('svg')!.setAttribute('height', '16');
  icon.querySelector('svg')!.style.fill = 'currentColor';
  return icon;
}

function renderNormalMode(el: HTMLElement, active: string, _isFreePlay: boolean): void {
  const names = getOpeningNames();
  const customRepertoires = names.filter(n => n !== FREE_PLAY_NAME);
  const isFreePlayActive = active === FREE_PLAY_NAME;
  const isFullRepActive = active === FULL_REPERTOIRE_NAME;
  const isCustomActive = !isFreePlayActive && !isFullRepActive;

  // Clean up stale outside-click listener from previous render
  dropdownOutsideClickCleanup?.();
  dropdownOutsideClickCleanup = null;

  // ── Single dropdown card ──
  const wrapper = document.createElement('div');
  wrapper.className = 'system-dropdown-anchor';

  const card = document.createElement('div');
  card.className = 'system-card active';

  const activeIconType = isFreePlayActive ? 'free-play' : isFullRepActive ? 'full-rep' : 'custom';
  card.append(makeCardIcon(activeIconType));

  const isRenaming = pickerMode === 'rename' && isCustomActive;

  if (isRenaming) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'system-card-rename-input';
    input.value = active;
    input.placeholder = 'Opening name...';

    function saveRename(): void {
      const newName = input.value.trim();
      if (newName && newName !== active) {
        renameOpening(active, newName);
        openingChangeCb?.();
      }
      pickerMode = 'normal';
      renderSystemPicker();
    }

    function cancelRename(): void {
      pickerMode = 'normal';
      renderSystemPicker();
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') saveRename();
      if (e.key === 'Escape') cancelRename();
    });
    input.addEventListener('blur', saveRename);

    card.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  } else {
    const nameEl = document.createElement('div');
    nameEl.className = 'system-card-name';
    nameEl.textContent = active;
    card.append(nameEl);
  }

  // Inline icon actions for custom openings
  if (isCustomActive) {
    const actions = document.createElement('div');
    actions.className = 'system-card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'system-card-action-btn';
    renameBtn.setAttribute('data-tooltip', 'Rename');
    renameBtn.innerHTML = SVG_EDIT;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownOpen = false;
      pickerMode = 'rename';
      renderSystemPicker();
    });

    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'system-card-action-btn';
    mergeBtn.setAttribute('data-tooltip', 'Merge openings');
    mergeBtn.innerHTML = SVG_MERGE;
    const customCount = names.filter(n => n !== FREE_PLAY_NAME).length;
    if (customCount < 2) {
      mergeBtn.style.display = 'none';
    }
    mergeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mergeSelected = new Set([active]);
      pickerMode = 'merge-select';
      dropdownOpen = true;
      renderSystemPicker();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'system-card-action-btn danger';
    deleteBtn.setAttribute('data-tooltip', 'Delete opening');
    deleteBtn.innerHTML = SVG_TRASH;
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const anchorRect = deleteBtn.getBoundingClientRect();
      dropdownOpen = false;
      renderSystemPicker();
      const result = await confirmModal({
        title: `Delete "${active}"?`,
        message: 'This will permanently remove this opening and all its locked moves.',
        buttons: [{ label: 'Delete', value: 'delete', style: 'danger' }],
        danger: true,
        anchor: anchorRect,
      });
      if (result === 'delete') {
        deleteOpening(active);
        pickerMode = 'normal';
        openingChangeCb?.();
        renderSystemPicker();
      }
    });

    actions.append(renameBtn, mergeBtn, deleteBtn);
    card.append(actions);
  }

    // Dropdown chevron
    const chevron = document.createElement('div');
    chevron.className = `system-dropdown-chevron${dropdownOpen ? ' open' : ''}`;
    chevron.innerHTML = SVG_CHEVRON;
    card.append(chevron);

    card.addEventListener('click', () => {
      dropdownOpen = !dropdownOpen;
      if (pickerMode === 'merge-select') {
        pickerMode = 'normal';
      }
      renderSystemPicker();
    });

    wrapper.append(card);

    // Dropdown list
    if (dropdownOpen) {
      // Close on click outside
      requestAnimationFrame(() => {
        const onClickOutside = (e: MouseEvent) => {
          if (!wrapper.contains(e.target as Node)) {
            dropdownOpen = false;
            if (pickerMode === 'merge-select') pickerMode = 'normal';
            cleanup();
            renderSystemPicker();
          }
        };
        function cleanup() {
          document.removeEventListener('click', onClickOutside, true);
          dropdownOutsideClickCleanup = null;
        }
        document.addEventListener('click', onClickOutside, true);
        dropdownOutsideClickCleanup = cleanup;
      });

      const dropdown = document.createElement('div');
      dropdown.className = 'system-dropdown';

      if (pickerMode === 'merge-select') {
        // Merge-select: header + checkboxes for all custom openings + merge/cancel
        const header = document.createElement('div');
        header.className = 'system-dropdown-header';
        header.textContent = 'Select openings to merge';
        dropdown.append(header);

        for (const name of customRepertoires) {
          const checked = mergeSelected.has(name);
          const item = document.createElement('div');
          item.className = 'system-dropdown-item';

          const check = document.createElement('div');
          check.className = 'system-card-check';
          if (checked) check.classList.add('checked');
          check.innerHTML = SVG_CHECK;
          check.querySelector('svg')!.setAttribute('width', '10');
          check.querySelector('svg')!.setAttribute('height', '10');
          check.querySelector('svg')!.style.fill = '#fff';
          check.querySelector('svg')!.style.opacity = checked ? '1' : '0';
          item.append(check);

          const itemName = document.createElement('div');
          itemName.className = 'system-card-name';
          itemName.textContent = name;
          item.append(itemName);

          item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mergeSelected.has(name)) {
              mergeSelected.delete(name);
            } else {
              mergeSelected.add(name);
            }
            // Update checkbox in-place
            const isNowChecked = mergeSelected.has(name);
            check.classList.toggle('checked', isNowChecked);
            check.querySelector('svg')!.style.opacity = isNowChecked ? '1' : '0';
            // Update merge button
            updateMergeAction();
          });
          dropdown.append(item);
        }

        // Merge button
        const mergeAction = document.createElement('div');
        mergeAction.className = 'system-dropdown-item system-dropdown-add';
        mergeAction.innerHTML = `${SVG_MERGE} <span class="system-card-name">Merge ${mergeSelected.size} openings</span>`;
        mergeAction.querySelector('svg')!.setAttribute('width', '14');
        mergeAction.querySelector('svg')!.setAttribute('height', '14');
        mergeAction.querySelector('svg')!.style.fill = 'currentColor';

        function updateMergeAction() {
          const count = mergeSelected.size;
          mergeAction.querySelector('.system-card-name')!.textContent = `Merge ${count} openings`;
          mergeAction.style.opacity = count < 2 ? '0.4' : '';
          mergeAction.style.pointerEvents = count < 2 ? 'none' : '';
        }
        updateMergeAction();
        mergeAction.addEventListener('click', async () => {
          const selectedNames = [...mergeSelected];
          dropdownOpen = false;
          pickerMode = 'normal';
          renderSystemPicker();

          const buttons: ConfirmButton[] = selectedNames.map(n => ({ label: n, value: n }));
          buttons.push({ label: 'New opening', value: '__new__', style: 'primary' });

          const result = await confirmModal({
            title: 'Merge into\u2026',
            message: 'Choose which name to keep. All locked moves will be combined and the rest deleted.',
            buttons,
            layout: 'vertical',
          });
          if (result) {
            mergeMultiple(selectedNames, result === '__new__' ? null : result);
            openingChangeCb?.();
            renderSystemPicker();
          }
        });
        dropdown.append(mergeAction);

        const cancelItem = document.createElement('div');
        cancelItem.className = 'system-dropdown-item system-dropdown-cancel';
        cancelItem.innerHTML = `${SVG_CLOSE} <span class="system-card-name">Cancel</span>`;
        cancelItem.querySelector('svg')!.setAttribute('width', '14');
        cancelItem.querySelector('svg')!.setAttribute('height', '14');
        cancelItem.querySelector('svg')!.style.fill = 'currentColor';
        cancelItem.addEventListener('click', () => {
          dropdownOpen = false;
          pickerMode = 'normal';
          renderSystemPicker();
        });
        dropdown.append(cancelItem);
      } else {
        // Normal dropdown: New opening, divider, Free Play, Full Repertoire, divider, custom openings

        // New opening (always first)
        const addItem = document.createElement('div');
        addItem.className = 'system-dropdown-item system-dropdown-add';
        addItem.innerHTML = `${SVG_PLUS} <span class="system-card-name">New opening</span>`;
        addItem.querySelector('svg')!.setAttribute('width', '16');
        addItem.querySelector('svg')!.setAttribute('height', '16');
        addItem.querySelector('svg')!.style.fill = 'currentColor';
        addItem.addEventListener('click', () => {
          dropdownOpen = false;
          createOpening();
          openingChangeCb?.();
          pickerMode = 'rename';
          renderSystemPicker();
        });
        dropdown.append(addItem);

        // Divider after New opening
        const divider1 = document.createElement('div');
        divider1.className = 'system-dropdown-divider';
        dropdown.append(divider1);

        // Free Play option
        if (!isFreePlayActive) {
          const fpItem = document.createElement('div');
          fpItem.className = 'system-dropdown-item';
          fpItem.append(makeCardIcon('free-play'));
          const fpName = document.createElement('div');
          fpName.className = 'system-card-name';
          fpName.textContent = FREE_PLAY_NAME;
          fpItem.append(fpName);
          fpItem.addEventListener('click', () => {
            dropdownOpen = false;
            switchOpening(FREE_PLAY_NAME);
            openingChangeCb?.();
            renderSystemPicker();
          });
          dropdown.append(fpItem);
        }

        // Full Repertoire option (when 2+ custom openings exist)
        if (customRepertoires.length > 1 && !isFullRepActive) {
          const frItem = document.createElement('div');
          frItem.className = 'system-dropdown-item';
          frItem.append(makeCardIcon('full-rep'));
          const frName = document.createElement('div');
          frName.className = 'system-card-name';
          frName.textContent = FULL_REPERTOIRE_NAME;
          frItem.append(frName);
          frItem.addEventListener('click', () => {
            dropdownOpen = false;
            switchOpening(FULL_REPERTOIRE_NAME);
            openingChangeCb?.();
            renderSystemPicker();
          });
          dropdown.append(frItem);
        }

        // Divider before custom openings (if any exist)
        if (customRepertoires.length > 0) {
          const divider2 = document.createElement('div');
          divider2.className = 'system-dropdown-divider';
          dropdown.append(divider2);
        }

        // Custom openings
        for (const name of customRepertoires) {
          if (name === active && isCustomActive) continue;
          const item = document.createElement('div');
          item.className = 'system-dropdown-item';

          item.append(makeCardIcon('custom'));

          const itemName = document.createElement('div');
          itemName.className = 'system-card-name';
          itemName.textContent = name;
          item.append(itemName);

          item.addEventListener('click', () => {
            dropdownOpen = false;
            switchOpening(name);
            openingChangeCb?.();
            renderSystemPicker();
          });

          dropdown.append(item);
        }
      }

      wrapper.append(dropdown);
    }

    el.append(wrapper);


}


const MODE_OPTIONS: { value: PlayerColor; label: string }[] = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
  { value: 'both', label: 'Manual' },
];

function renderControls(): void {
  const el = document.getElementById('controls')!;
  el.innerHTML = '';

  const newGameBtn = document.createElement('button');
  newGameBtn.textContent = 'New Game';
  newGameBtn.className = 'btn btn-primary';
  newGameBtn.addEventListener('click', () => newGameCb());

  const flipBtn = document.createElement('button');
  flipBtn.textContent = 'Flip Board';
  flipBtn.className = 'btn';
  flipBtn.addEventListener('click', () => flipCb());

  const segmentSection = document.createElement('div');
  segmentSection.className = 'config-toggle-header';

  const segment = document.createElement('div');
  segment.className = 'segment-picker';

  for (const opt of MODE_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = `segment-btn${currentConfig.playerColor === opt.value ? ' selected' : ''}`;
    btn.textContent = opt.label;
    btn.dataset.value = opt.value;
    btn.addEventListener('click', () => {
      if (currentConfig.playerColor === opt.value) return;
      currentConfig.playerColor = opt.value;
      segment.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      configChangeCb(currentConfig);
    });
    segment.append(btn);
  }

  const segmentInfo = document.createElement('div');
  segmentInfo.className = 'info-icon-wrap';
  segmentInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const segmentTooltip = document.createElement('div');
  segmentTooltip.className = 'info-tooltip';
  segmentTooltip.innerHTML =
    '<b>White</b> — you play white, bot plays black.<br>' +
    '<b>Black</b> — you play black, bot plays white.<br>' +
    '<b>Manual</b> — play both sides freely, no bot.';
  segmentInfo.append(segmentTooltip);

  segmentSection.append(segment, segmentInfo);

  el.append(segmentSection, flipBtn, newGameBtn);
}

const ALERT_META: { type: AlertType; label: string; cls: string }[] = [
  { type: 'danger', label: 'Danger', cls: 'danger' },
  { type: 'opportunity', label: 'Opportunity', cls: 'opportunity' },
  { type: 'trap', label: 'Trap', cls: 'trap' },
];


function renderConfigPanel(): void {
  const inlineEl = document.getElementById('config-inline')!;
  inlineEl.innerHTML = '';

  // ── Display chips ──
  const displaySection = document.createElement('div');
  displaySection.className = 'config-toggle-section';

  const displayGrid = document.createElement('div');
  displayGrid.className = 'chip-grid';

  const evalChip = document.createElement('button');
  evalChip.className = `chip${currentConfig.showEval ? ' selected' : ''}`;
  evalChip.textContent = 'Eval';
  evalChip.setAttribute('data-tooltip', 'Stockfish evaluation bar next to the board');
  evalChip.addEventListener('click', () => {
    const isOn = evalChip.classList.toggle('selected');
    currentConfig.showEval = isOn;
    configChangeCb(currentConfig);
  });

  const badgesChip = document.createElement('button');
  badgesChip.className = `chip${currentConfig.showMoveBadges ? ' selected' : ''}`;
  badgesChip.textContent = 'Badges';
  badgesChip.setAttribute('data-tooltip', 'Mark best moves (!), mistakes (?), and traps (?!)');
  badgesChip.addEventListener('click', () => {
    const isOn = badgesChip.classList.toggle('selected');
    currentConfig.showMoveBadges = isOn;
    configChangeCb(currentConfig);
  });

  const explorerChip = document.createElement('button');
  explorerChip.className = `chip${currentConfig.showExplorer ? ' selected' : ''}`;
  explorerChip.textContent = 'Explorer';
  explorerChip.setAttribute('data-tooltip', 'Show explorer during bot play');
  explorerChip.addEventListener('click', () => {
    const isOn = explorerChip.classList.toggle('selected');
    currentConfig.showExplorer = isOn;
    configChangeCb(currentConfig);
  });

  const engineLinesChip = document.createElement('button');
  const elCount = currentConfig.engineLineCount;
  engineLinesChip.className = `chip${elCount > 0 ? ' selected' : ''}`;
  engineLinesChip.textContent = 'Engine';
  engineLinesChip.setAttribute('data-tooltip', 'Show engine analysis lines');
  engineLinesChip.addEventListener('click', () => {
    const wasOn = currentConfig.engineLineCount > 0;
    currentConfig.engineLineCount = wasOn ? 0 : (lastEngineLineCount || 1);
    engineLinesChip.classList.toggle('selected', !wasOn);
    configChangeCb(currentConfig);
  });

  displayGrid.append(evalChip, badgesChip, explorerChip, engineLinesChip);
  displaySection.append(displayGrid);

  inlineEl.append(displaySection);
}

function closeAllDropdowns(): void {
  document.querySelectorAll('.explorer-cog-popover').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.engine-lines-config').forEach(p => p.classList.add('hidden'));
}


export function updateStatus(phase: GamePhase, openingName?: string): void {
  const el = document.getElementById('status')!;
  let text = '';

  text += `<div class="opening-name">${openingName || 'Starting position'}</div>`;

  // Status row: turn indicator + move number
  const history = getMoveHistory();
  const moveNum = Math.floor(history.length / 2) + 1;
  const moveLabel = history.length > 0 ? `Move ${moveNum}` : '';

  text += '<div class="status-row">';
  switch (phase) {
    case 'USER_TURN':
      text += '<span class="turn-indicator">Your turn</span>';
      break;
    case 'BOT_THINKING':
      text += '<span class="turn-indicator thinking">Thinking...</span>';
      break;
    case 'OUT_OF_BOOK':
      text += '<span class="turn-indicator out-of-book" data-tooltip="Position left the opening database">Out of book</span>';
      break;
    case 'GAME_OVER':
      text += '<span class="turn-indicator game-over">Game over</span>';
      break;
  }
  if (moveLabel) {
    text += `<span class="move-counter">${moveLabel}</span>`;
  }
  text += '</div>';

  // Repertoire depth indicator
  let repMoves = 0;
  if (history.length > 0) {
    for (let i = 0; i < history.length; i++) {
      const fenBefore = i === 0 ? STARTING_FEN : history[i - 1].fen;
      const locked = getLockedMoves(fenBefore);
      if (locked.length > 0 && locked.includes(history[i].uci)) {
        repMoves++;
      } else {
        break;
      }
    }
  }
  const pct = history.length > 0 ? Math.round((repMoves / history.length) * 100) : 0;
  const depthLabel = history.length > 0
    ? `${repMoves}/${history.length} moves in repertoire`
    : 'No moves yet';
  text += `<div class="rep-depth" data-tooltip="Consecutive moves matching your repertoire"><span class="rep-depth-bar" style="width:${pct}%"></span><span class="rep-depth-label">${depthLabel}</span></div>`;

  el.innerHTML = text;
}

function repClass(moveIndex: number, history: { uci: string; fen: string }[]): string {
  const fenBefore = moveIndex === 0 ? STARTING_FEN : history[moveIndex - 1].fen;
  const locked = getLockedMoves(fenBefore);
  if (locked.length === 0) return '';
  if (locked.includes(history[moveIndex].uci)) return ' rep-hit';
  return ' rep-miss';
}

function buildParentContext(
  parentFen: string,
  playedUci: string,
  cache: Map<string, ExplorerResponse>,
): ParentContext | undefined {
  const parentData = cache.get(fenKey(parentFen));
  if (!parentData || parentData.moves.length === 0) return undefined;
  const parentSide = parentFen.split(' ')[1] as 'w' | 'b';
  return { parentMoves: parentData.moves, playedUci, parentSide };
}

function historyBadge(moveIndex: number, history: { uci: string; fen: string }[]): string {
  const fenBefore = moveIndex === 0 ? STARTING_FEN : history[moveIndex - 1].fen;
  const cache = getExplorerCache();
  const explorerData = cache.get(fenKey(fenBefore));
  if (!explorerData || explorerData.moves.length === 0) return '';

  // Build parent context: the position before fenBefore, and the move that led to fenBefore
  let parentContext: ParentContext | undefined;
  if (moveIndex >= 1) {
    const grandparentFen = moveIndex <= 1 ? STARTING_FEN : history[moveIndex - 2].fen;
    const playedUci = history[moveIndex - 1].uci;
    parentContext = buildParentContext(grandparentFen, playedUci, cache);
  }

  const sideToMove = fenBefore.split(' ')[1] as 'w' | 'b';
  const analysis = analyzePosition(explorerData.moves, sideToMove, parentContext);
  const badge = getBadgeForMove(analysis, history[moveIndex].uci);
  if (!badge || badge === 'book') return '';

  return `<span class="history-badge badge-${badge.replace('_', '-')}">${badgeSymbol(badge)}</span>`;
}

export function updateMoveList(): void {
  const el = document.getElementById('moves')!;
  const history = getMoveHistory();

  if (history.length === 0) {
    el.innerHTML = '<div class="move-list-empty">No moves yet</div>';
    document.getElementById('move-actions')!.innerHTML = '';
    return;
  }

  const vi = getViewIndex();

  // Check if any moves have repertoire coloring
  let hasRepHit = false;
  let hasRepMiss = false;
  for (let i = 0; i < history.length && (!hasRepHit || !hasRepMiss); i++) {
    const cls = repClass(i, history);
    if (cls === ' rep-hit') hasRepHit = true;
    if (cls === ' rep-miss') hasRepMiss = true;
  }

  let html = '';
  if (loadedGame) {
    const result = userResult(loadedGame);
    const resultLabel = result === 'win' ? 'W' : result === 'draw' ? 'D' : 'L';
    const oppName = loadedGame.op ?? 'Opponent';
    const dateStr = shortDate(loadedGame.da ?? loadedGame.mo);
    html += `<div class="game-info-banner">` +
      `<span class="game-info-result ${result}">${resultLabel}</span>` +
      `<span class="game-info-details">vs ${oppName} (${loadedGame.or}) &middot; ${dateStr}</span>` +
      `<button class="game-info-dismiss" title="Back to training">&times;</button>` +
      `</div>`;
  }
  if (hasRepHit || hasRepMiss) {
    html += '<div class="move-legend">';
    if (hasRepHit) html += '<span class="move-legend-item"><span class="move-legend-dot hit"></span>In repertoire</span>';
    if (hasRepMiss) html += '<span class="move-legend-item"><span class="move-legend-dot miss"></span>Deviated</span>';
    html += '</div>';
  }

  html += '<div class="move-table">';
  for (let i = 0; i < history.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const white = history[i];
    const black = history[i + 1];
    const whiteActive = (i + 1) === vi ? ' active' : '';
    const blackActive = black && (i + 2) === vi ? ' active' : '';
    const whiteRepClass = repClass(i, history);
    const blackRepClass = black ? repClass(i + 1, history) : '';
    const whiteBadge = currentConfig.showMoveBadges ? historyBadge(i, history) : '';
    const blackBadge = black && currentConfig.showMoveBadges ? historyBadge(i + 1, history) : '';
    html += `<div class="move-num">${moveNum}.</div>
      <div class="move-san clickable${whiteActive}${whiteRepClass}" data-vi="${i + 1}">${white.san}${whiteBadge}</div>
      <div class="move-san${black ? ` clickable${blackActive}${blackRepClass}` : ''}"${black ? ` data-vi="${i + 2}"` : ''}>${black ? black.san + blackBadge : ''}</div>`;
  }
  html += '</div>';

  el.innerHTML = html;

  el.querySelectorAll('.move-san.clickable').forEach((td) => {
    td.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const vi = parseInt(target.dataset.vi!);
      navigateTo(vi);
    });
  });

  // Render action buttons in separate container
  const actionsEl = document.getElementById('move-actions')!;
  const upTo = isViewingHistory() ? vi : history.length;
  const allLocked = upTo > 0 && history.slice(0, upTo).every((m, i) => {
    const fen = i === 0 ? STARTING_FEN : history[i - 1].fen;
    return isMoveLocked(fen, m.uci);
  });
  let actionsHtml = '';
  if (isViewingHistory() && continueCb) {
    actionsHtml += '<button class="btn continue-btn">Continue from here</button>';
  }
  if (!allLocked) {
    actionsHtml += '<button class="btn lock-line-btn" data-tooltip="Lock all moves up to here">Add to opening</button>';
    actionsHtml += '<button class="btn lock-line-new-btn" data-tooltip="Lock into a new opening">Add new opening</button>';
  }
  actionsEl.innerHTML = actionsHtml;

  const continueBtn = actionsEl.querySelector('.continue-btn');
  if (continueBtn && continueCb) {
    continueBtn.addEventListener('click', () => continueCb!());
  }

  function lockLineToRepertoire(forceNew: boolean): void {
    if (forceNew) {
      const { data } = getExplorerData();
      const openingName = data?.opening?.name;
      createOpening(openingName);
      renderSystemPicker();
    }
    const upTo = isViewingHistory() ? vi : history.length;
    let repertoireCreated = false;
    for (let i = 0; i < upTo; i++) {
      const fen = i === 0 ? STARTING_FEN : history[i - 1].fen;
      if (lockMove(fen, history[i].uci)) repertoireCreated = true;
    }
    if (repertoireCreated && !forceNew) {
      renderSystemPicker();
    }
    updateExplorerPanel();
    updateMoveList();
    updateAlertBanner();
  }

  actionsEl.querySelector('.lock-line-btn')
    ?.addEventListener('click', () => lockLineToRepertoire(false));
  actionsEl.querySelector('.lock-line-new-btn')
    ?.addEventListener('click', () => lockLineToRepertoire(true));

  const bannerEl = el.querySelector('.game-info-banner');
  if (bannerEl) {
    bannerEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.game-info-dismiss')) {
        clearLoadedGame();
        return;
      }
      if (loadedGame?.mv) {
        const line = uciStringToLine(loadedGame.mv);
        if (line.length > 0) replayLine(line, 0);
      }
    });
  }

  const activeEl = el.querySelector('.move-san.active') as HTMLElement | null;
  if (activeEl) {
    activeEl.scrollIntoView({ block: 'nearest' });
  } else if (loadedGame) {
    el.scrollTop = 0;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

export function setNextMoveUci(uci: string | null): void {
  nextMoveUci = uci;
}

export function setEvalWinPct(winPct: number | null): void {
  currentEvalWinPct = winPct;
}

export function getLoadedGame(): GameMeta | null {
  return loadedGame;
}

export function clearLoadedGame(): void {
  loadedGame = null;
  updateMoveList();
  updateRecentGamesPanel();
}

// Whether explorer content should always be shown (manual mode, history view)
let explorerAlwaysShow = false;
// Temporary reveal during live play (reset on move)
let explorerRevealed = false;

export function setExplorerAlwaysShow(show: boolean): void {
  explorerAlwaysShow = show;
}

export function resetExplorerRevealed(): void {
  explorerRevealed = false;
}

function shouldShowExplorerContent(): boolean {
  return explorerAlwaysShow || explorerRevealed;
}

const EXPLORER_ROWS = 10;

function currentAnalysis(): { analysis: PositionAnalysis; parentContext?: ParentContext } | null {
  const { data, fen } = getExplorerData();
  const moves = data?.moves ?? [];
  if (moves.length === 0) return null;

  const sideToMove = fen.split(' ')[1] as 'w' | 'b';
  let parentContext: ParentContext | undefined;
  const history = getMoveHistory();
  const cache = getExplorerCache();
  const vi = getViewIndex();
  const currentMoveIndex = vi - 1;
  if (currentMoveIndex >= 0) {
    const parentFen = currentMoveIndex === 0 ? STARTING_FEN : history[currentMoveIndex - 1].fen;
    const playedUci = history[currentMoveIndex].uci;
    parentContext = buildParentContext(parentFen, playedUci, cache);
  }

  // Convert eval to side-to-move win% if available
  // currentEvalWinPct is always from white's perspective, flip for black
  const evalWinPct = currentEvalWinPct != null
    ? (sideToMove === 'w' ? currentEvalWinPct : 100 - currentEvalWinPct)
    : undefined;

  const analysis = analyzePosition(moves, sideToMove, parentContext, evalWinPct);
  return { analysis, parentContext };
}

const alertLabels: Record<string, { text: string; cls: string }> = {
  danger: { text: 'Danger — most moves are bad here', cls: 'alert-danger' },
  opportunity: { text: 'Opportunity — one move stands out', cls: 'alert-opportunity' },
  trap: { text: 'Trap — a popular move is a mistake', cls: 'alert-trap' },
};

export function updateAlertBanner(): void {
  const el = document.getElementById('alert-banner');
  if (el) el.innerHTML = '';
}

function uciToSan(fen: string, uciMoves: string[], maxMoves = 6): string[] {
  const setup = parseFen(fen);
  if (!setup.isOk) return uciMoves.slice(0, maxMoves);
  const pos = Chess.fromSetup(setup.value);
  if (!pos.isOk) return uciMoves.slice(0, maxMoves);

  const chess = pos.value;
  const sans: string[] = [];
  for (let i = 0; i < Math.min(uciMoves.length, maxMoves); i++) {
    const move = parseUci(uciMoves[i]);
    if (!move) break;
    try {
      const san = makeSan(chess, move);
      sans.push(san);
      chess.play(move);
    } catch {
      break;
    }
  }
  return sans;
}

// Top engine move UCIs from latest engine lines: uci → rank (1-based)
let engineTopMoves: Map<string, number> = new Map();

export function renderEngineLines(lines: EngineLine[], fen: string): void {
  const el = document.getElementById('engine-lines');
  if (!el) return;

  // Update top engine moves and refresh explorer highlights
  const newMap = new Map<string, number>();
  for (const l of lines) {
    const uci = l.pv[0];
    if (uci && !newMap.has(uci)) newMap.set(uci, l.rank);
  }
  const changed = newMap.size !== engineTopMoves.size || [...newMap].some(([u, r]) => engineTopMoves.get(u) !== r);
  engineTopMoves = newMap;
  if (changed) refreshEngineHighlights();

  if (lines.length === 0) {
    el.innerHTML = '';
    return;
  }

  const sideToMove = fen.split(' ')[1];
  const moveNum = parseInt(fen.split(' ')[5] || '1');

  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const evalText = formatScore(line.score);
    const isPositive = line.score.type === 'mate' ? line.score.value > 0 : line.score.value > 0;
    const isNeutral = line.score.type === 'cp' && Math.abs(line.score.value) < 20;
    const evalClass = isNeutral ? 'neutral' : isPositive ? 'positive' : 'negative';
    const bestClass = i === 0 ? ' engine-line-best' : '';

    const sans = uciToSan(fen, line.pv);
    let moveStr = '';
    let curMoveNum = moveNum;
    let whiteToMove = sideToMove === 'w';
    for (let j = 0; j < sans.length; j++) {
      if (whiteToMove) {
        moveStr += `${curMoveNum}.\u2009${sans[j]} `;
      } else {
        if (j === 0) moveStr += `${curMoveNum}...\u2009`;
        moveStr += `${sans[j]} `;
        curMoveNum++;
      }
      whiteToMove = !whiteToMove;
    }

    const firstUci = line.pv[0] || '';
    html += `<div class="engine-line${bestClass}" data-uci="${firstUci}">
      <span class="engine-line-rank">${line.rank}</span>
      <span class="engine-line-eval ${evalClass}">${evalText}</span>
      <span class="engine-line-moves">${moveStr.trim()}</span>
    </div>`;
  }

  // Build header row with gear config
  const headerHtml = `<div class="engine-lines-header">
    <span class="engine-lines-title">Engine</span>
    <div class="engine-lines-cog-wrap">
      <button class="engine-lines-cog" data-tooltip="Configure engine lines">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"/>
        </svg>
      </button>
      <div class="engine-lines-config hidden">
        ${[1, 2, 3].map(n => `<button class="engine-lines-config-opt${currentConfig.engineLineCount === n ? ' selected' : ''}" data-lines="${n}">${n} line${n > 1 ? 's' : ''}</button>`).join('')}
      </div>
    </div>
  </div>`;

  el.innerHTML = headerHtml + html;

  // Gear icon toggles config popover
  const cogBtn = el.querySelector('.engine-lines-cog')!;
  const configPanel = el.querySelector('.engine-lines-config')!;
  cogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    configPanel.classList.toggle('hidden');
  });

  // Line count options
  configPanel.querySelectorAll('.engine-lines-config-opt').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = parseInt((btn as HTMLElement).dataset.lines!);
      currentConfig.engineLineCount = n;
      lastEngineLineCount = n;
      configPanel.classList.add('hidden');
      configPanel.querySelectorAll('.engine-lines-config-opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      configChangeCb(currentConfig);
    });
  });

  // Hover arrows + click to play (same pattern as explorer)
  el.querySelectorAll('.engine-line').forEach((row) => {
    const uci = (row as HTMLElement).dataset.uci;
    if (!uci || uci.length < 4) return;
    const orig = uci.slice(0, 2) as Key;
    const dest = uci.slice(2, 4) as Key;

    row.addEventListener('mouseenter', () => {
      setAutoShapes([{ orig, dest, brush: 'blue' }]);
    });
    row.addEventListener('mouseleave', () => {
      setAutoShapes([]);
    });
    if (explorerMoveClickCb) {
      row.addEventListener('click', () => {
        explorerMoveClickCb!(uci);
      });
    }
  });
}

export function setEngineLinesVisible(visible: boolean): void {
  const el = document.getElementById('engine-lines');
  if (el) el.classList.toggle('hidden', !visible);
  if (!visible) {
    engineTopMoves.clear();
    refreshEngineHighlights();
  }
}

function engineStarHtml(rank: number): string {
  const cls = rank === 1 ? 'engine-star-gold' : rank === 2 ? 'engine-star-silver' : 'engine-star-bronze';
  return `<span class="engine-star ${cls}" data-tooltip="Engine #${rank}">&#9733;</span>`;
}

function refreshEngineHighlights(): void {
  const rows = document.querySelectorAll('#explorer-moves .explorer-move[data-uci]');
  rows.forEach((row) => {
    const uci = (row as HTMLElement).dataset.uci;
    if (!uci) return;
    const badgeCol = row.querySelector('.explorer-badge-col');
    if (!badgeCol) return;
    // Remove existing engine star
    badgeCol.querySelector('.engine-star')?.remove();
    const rank = engineTopMoves.get(uci);
    if (rank) {
      badgeCol.insertAdjacentHTML('afterbegin', engineStarHtml(rank));
    }
  });
}


let explorerFiltersOpen = false;
let recentGamesFiltersOpen = false;
let personalColorFilter: 'both' | 'white' | 'black' = 'white';
let filterClickOutsideHandler: ((e: MouseEvent) => void) | null = null;



function renderPersonalColorPicker(el: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'personal-color-picker';

  const picker = document.createElement('div');
  picker.className = 'segment-picker segment-sm';
  const labels: Record<'both' | 'white' | 'black', string> = {
    both: 'Both',
    white: 'My Side',
    black: 'Their Side',
  };
  for (const value of ['both', 'white', 'black'] as const) {
    const btn = document.createElement('button');
    btn.className = 'segment-btn' + (personalColorFilter === value ? ' selected' : '');
    btn.textContent = labels[value];
    btn.addEventListener('click', () => {
      personalColorFilter = value;
      updateExplorerPanel();
    });
    picker.append(btn);
  }

  wrap.append(picker);

  const cfg = getPersonalConfig();
  if (cfg) {
    const filterBtn = document.createElement('button');
    filterBtn.className = 'personal-action-btn' + (explorerFiltersOpen ? ' active' : '');
    filterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>`;
    filterBtn.setAttribute('data-tooltip', 'Filter games');
    filterBtn.addEventListener('click', () => {
      explorerFiltersOpen = !explorerFiltersOpen;
      updateExplorerPanel();
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'personal-action-btn';
    refreshBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;
    refreshBtn.setAttribute('data-tooltip', 'Refresh games');
    refreshBtn.addEventListener('click', () => refreshExplorerGames(refreshBtn));

    wrap.append(filterBtn, refreshBtn);
  }

  el.append(wrap);
}

function renderPersonalFilterPanel(el: HTMLElement, context: 'explorer' | 'recent-games' = 'explorer'): void {
  // Clean up previous click-outside handler
  if (filterClickOutsideHandler) {
    document.removeEventListener('mousedown', filterClickOutsideHandler);
    filterClickOutsideHandler = null;
  }

  const isOpen = context === 'recent-games' ? recentGamesFiltersOpen : explorerFiltersOpen;
  if (!isOpen) return;
  const stats = getPersonalStats();
  if (!stats) return;
  const filters = getPersonalFilters();

  const panel = document.createElement('div');
  panel.className = 'personal-filter-panel';

  // Color filter (recent-games only)
  if (context === 'recent-games') {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Color</div>`;
    const picker = document.createElement('div');
    picker.className = 'segment-picker segment-sm';
    for (const value of ['all', 'white', 'black'] as const) {
      const btn = document.createElement('button');
      btn.className = 'segment-btn' + (recentGamesColorFilter === value ? ' selected' : '');
      btn.textContent = value === 'all' ? 'All' : value === 'white' ? 'White' : 'Black';
      btn.addEventListener('click', () => {
        recentGamesColorFilter = value;
        picker.querySelectorAll('.segment-btn').forEach(b => b.classList.toggle('selected', b === btn));
        updateRecentGamesList();
      });
      picker.append(btn);
    }
    section.append(picker);
    panel.append(section);
  }

  // Time class chips
  if (stats.timeClasses.length > 1) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Time control</div>`;
    const chips = document.createElement('div');
    chips.className = 'chip-grid';
    const activeTC = filters.timeClasses ?? [];
    for (const tc of stats.timeClasses) {
      const chip = document.createElement('button');
      chip.className = 'chip chip-sm' + (activeTC.length === 0 || activeTC.includes(tc) ? ' selected' : '');
      chip.dataset.tc = tc;
      chip.textContent = tc.charAt(0).toUpperCase() + tc.slice(1);
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        applyFiltersFromPanel(panel, context);
      });
      chips.append(chip);
    }
    section.append(chips);
    panel.append(section);
  }

  // Rating range (explorer only)
  if (context === 'explorer' && stats.minRating < stats.maxRating) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Your rating</div>`;
    const row = document.createElement('div');
    row.className = 'personal-filter-range';
    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.placeholder = String(stats.minRating);
    minInput.className = 'filter-input';
    minInput.id = 'filter-min-rating';
    if (filters.minRating != null) minInput.value = String(filters.minRating);
    const sep = document.createElement('span');
    sep.className = 'filter-range-sep';
    sep.textContent = '–';
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.placeholder = String(stats.maxRating);
    maxInput.className = 'filter-input';
    maxInput.id = 'filter-max-rating';
    if (filters.maxRating != null) maxInput.value = String(filters.maxRating);

    const applyRating = () => applyFiltersFromPanel(panel, context);
    minInput.addEventListener('change', applyRating);
    maxInput.addEventListener('change', applyRating);

    row.append(minInput, sep, maxInput);
    section.append(row);
    panel.append(section);
  }

  // Date range (explorer only)
  if (context === 'explorer' && stats.minDate && stats.maxDate) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Date range</div>`;

    // Quick presets
    const now = new Date();
    const toYmd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const parseYmd = (ymd: string) => {
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    const todayYmd = toYmd(now);
    const rangeEndYmd = stats.maxDate < todayYmd ? stats.maxDate : todayYmd;
    const rangeEnd = parseYmd(rangeEndYmd);
    const daysAgo = (n: number) => {
      const d = new Date(rangeEnd);
      d.setDate(rangeEnd.getDate() - n);
      return toYmd(d);
    };

    const presets: Array<{ label: string; since?: string; until?: string }> = [
      { label: 'All', since: undefined, until: undefined },
      { label: 'Last 7d', since: daysAgo(6), until: rangeEndYmd },
      { label: 'Last 30d', since: daysAgo(29), until: rangeEndYmd },
      { label: 'Last 90d', since: daysAgo(89), until: rangeEndYmd },
    ];

    const presetRow = document.createElement('div');
    presetRow.className = 'chip-grid';
    for (const preset of presets) {
      const chip = document.createElement('button');
      chip.className = 'chip chip-sm';
      if ((filters.sinceDate ?? undefined) === preset.since && (filters.untilDate ?? undefined) === preset.until) {
        chip.classList.add('selected');
      }
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        const current = getPersonalFilters();
        // Toggle off if already selected
        if ((current.sinceDate ?? undefined) === preset.since && (current.untilDate ?? undefined) === preset.until) {
          setPersonalFilters({
            ...current,
            sinceDate: undefined,
            untilDate: undefined,
            sinceMonth: undefined,
            untilMonth: undefined,
          });
        } else {
          setPersonalFilters({
            ...current,
            sinceDate: preset.since,
            untilDate: preset.until,
            sinceMonth: undefined,
            untilMonth: undefined,
          });
        }
        refreshPersonalMoves();
        // Rebuild filter panel to update preset + picker state
        const wrap = panel.parentElement!;
        panel.remove();
        renderPersonalFilterPanel(wrap, context);
      });
      presetRow.append(chip);
    }
    section.append(presetRow);

    // Custom pickers
    const row = document.createElement('div');
    row.className = 'personal-filter-range';

    const sinceInput = document.createElement('input');
    sinceInput.type = 'date';
    sinceInput.className = 'filter-input';
    sinceInput.id = 'filter-since-date';
    sinceInput.min = stats.minDate;
    sinceInput.max = stats.maxDate;
    if (filters.sinceDate) sinceInput.value = filters.sinceDate;

    const applyDate = () => applyFiltersFromPanel(panel, context);
    sinceInput.addEventListener('change', applyDate);
    const sep = document.createElement('span');
    sep.className = 'filter-range-sep';
    sep.textContent = '–';
    const untilInput = document.createElement('input');
    untilInput.type = 'date';
    untilInput.className = 'filter-input';
    untilInput.id = 'filter-until-date';
    untilInput.min = stats.minDate;
    untilInput.max = stats.maxDate;
    if (filters.untilDate) untilInput.value = filters.untilDate;
    untilInput.addEventListener('change', applyDate);

    row.append(sinceInput, sep, untilInput);
    section.append(row);
    panel.append(section);
  }

  // Reset button (color is managed by the board-matching checkbox, not here)
  const hasActiveFilters = context === 'recent-games'
    ? (filters.timeClasses && filters.timeClasses.length > 0)
    : (filters.timeClasses && filters.timeClasses.length > 0) ||
      filters.minRating != null || filters.maxRating != null ||
      filters.sinceDate || filters.untilDate ||
      filters.sinceMonth || filters.untilMonth;
  if (hasActiveFilters) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn sm ghost';
    resetBtn.textContent = 'Reset filters';
    resetBtn.addEventListener('click', () => {
      if (context === 'recent-games') {
        // Only reset time classes, preserve rating/date filters
        const current = getPersonalFilters();
        setPersonalFilters({ ...current, timeClasses: undefined });
        updateRecentGamesPanel();
      } else {
        setPersonalFilters({});
        updateExplorerPanel();
      }
    });
    panel.append(resetBtn);
  }

  el.append(panel);

  // Close on click outside
  requestAnimationFrame(() => {
    filterClickOutsideHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.personal-filter-panel, .personal-color-picker, .recent-games-header, .recent-games-filters')) return;
      if (context === 'recent-games') recentGamesFiltersOpen = false;
      else explorerFiltersOpen = false;
      document.removeEventListener('mousedown', filterClickOutsideHandler!);
      filterClickOutsideHandler = null;
      if (context === 'recent-games') updateRecentGamesPanel();
      else updateExplorerPanel();
    };
    document.addEventListener('mousedown', filterClickOutsideHandler);
  });
}

function applyFiltersFromPanel(panel: HTMLElement, context: 'explorer' | 'recent-games' = 'explorer'): void {
  // Collect time class chips
  const allChips = panel.querySelectorAll('.chip[data-tc]');
  const selectedChips = panel.querySelectorAll('.chip[data-tc].selected');
  let timeClasses: string[] | undefined;
  if (selectedChips.length > 0 && selectedChips.length < allChips.length) {
    timeClasses = Array.from(selectedChips).map(c => (c as HTMLElement).dataset.tc!);
  }

  if (context === 'recent-games') {
    // Only update time classes, preserve existing rating/date/color filters
    const current = getPersonalFilters();
    setPersonalFilters({ ...current, timeClasses });
    updateRecentGamesList();
    return;
  }

  // Collect rating range
  const minEl = panel.querySelector('#filter-min-rating') as HTMLInputElement | null;
  const maxEl = panel.querySelector('#filter-max-rating') as HTMLInputElement | null;
  const minRating = minEl?.value ? parseInt(minEl.value) : undefined;
  const maxRating = maxEl?.value ? parseInt(maxEl.value) : undefined;

  // Collect date range
  const sinceEl = panel.querySelector('#filter-since-date') as HTMLInputElement | null;
  const untilEl = panel.querySelector('#filter-until-date') as HTMLInputElement | null;
  const sinceDate = sinceEl?.value || undefined;
  const untilDate = untilEl?.value || undefined;

  // Resolve color from picker relative to board orientation
  let color: 'white' | 'black' | undefined;
  if (personalColorFilter !== 'both') {
    const orientation = getOrientation();
    const opposite = orientation === 'white' ? 'black' : 'white';
    color = personalColorFilter === 'white' ? orientation : opposite;
  }

  setPersonalFilters({
    timeClasses,
    minRating,
    maxRating,
    sinceDate,
    untilDate,
    sinceMonth: undefined,
    untilMonth: undefined,
    color,
  });
  refreshPersonalMoves();
}

/** Refresh only the move rows + info text without rebuilding the filter panel */
function refreshPersonalMoves(): void {
  const el = document.getElementById('explorer-moves')!;
  const { fen } = getExplorerData();

  // Remove old move rows and empty state
  el.querySelectorAll('.explorer-header, .explorer-list, .personal-empty-state').forEach(e => e.remove());

  const personalData = queryPersonalExplorer(fen);
  const moves = personalData?.moves ?? [];
  if (moves.length === 0) {
    const noData = document.createElement('div');
    noData.className = 'personal-empty-state';
    noData.style.padding = '16px';
    const totalGames = getFilteredGameCount();
    noData.textContent = totalGames > 0
      ? `None of your ${totalGames.toLocaleString()} games reached this position.`
      : 'No games in this position.';
    el.append(noData);
    return;
  }

  renderMoveRows(moves, fen, null, el);
  if (!explorerFiltersOpen) updateRecentGamesPanel();
}

function renderPersonalLoadingState(el: HTMLElement): void {
  let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
  html += '<div class="explorer-list explorer-skeleton">';
  for (let i = 0; i < EXPLORER_ROWS; i++) {
    html += '<div class="explorer-move skeleton-row">&nbsp;</div>';
  }
  html += '</div>';
  const container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) el.append(container.firstChild);
}

function renderPersonalEmptyState(el: HTMLElement): void {
  const empty = document.createElement('div');
  empty.className = 'personal-empty-state';
  empty.innerHTML = `<div>No games imported yet.</div>`;
  const importBtn = document.createElement('button');
  importBtn.className = 'btn btn-primary';
  importBtn.textContent = 'Import games';
  importBtn.addEventListener('click', () => openPersonalImportModal());
  empty.append(importBtn);
  el.append(empty);
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function createMonthPicker(
  id: string,
  value: string,
  minMonth: string,
  maxMonth: string,
  placeholder: string,
  onChange: () => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'month-picker';
  wrap.id = id;
  wrap.dataset.value = value;

  const trigger = document.createElement('button');
  trigger.className = 'month-picker-trigger';
  trigger.type = 'button';
  if (value) {
    const [y, m] = value.split('-');
    trigger.textContent = `${MONTH_ABBR[parseInt(m) - 1]} ${y}`;
    trigger.classList.add('has-value');
  } else {
    trigger.textContent = placeholder;
  }

  let dropdown: HTMLElement | null = null;
  let closeHandler: ((e: MouseEvent) => void) | null = null;

  const minY = parseInt(minMonth.split('-')[0]);
  const maxY = parseInt(maxMonth.split('-')[0]);

  function isInRange(year: number, month: number): boolean {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    return key >= minMonth && key <= maxMonth;
  }

  function openDropdown() {
    if (dropdown) { closeDropdown(); return; }

    const currentValue = wrap.dataset.value;
    let viewYear = currentValue ? parseInt(currentValue.split('-')[0]) : maxY;

    dropdown = document.createElement('div');
    dropdown.className = 'month-picker-dropdown';

    function render() {
      dropdown!.innerHTML = '';

      const header = document.createElement('div');
      header.className = 'month-picker-header';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'month-picker-nav';
      prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
      prevBtn.disabled = viewYear <= minY;
      prevBtn.addEventListener('click', (e) => { e.stopPropagation(); viewYear--; render(); });

      const yearLabel = document.createElement('span');
      yearLabel.className = 'month-picker-year';
      yearLabel.textContent = String(viewYear);

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'month-picker-nav';
      nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
      nextBtn.disabled = viewYear >= maxY;
      nextBtn.addEventListener('click', (e) => { e.stopPropagation(); viewYear++; render(); });

      header.append(prevBtn, yearLabel, nextBtn);
      dropdown!.append(header);

      const grid = document.createElement('div');
      grid.className = 'month-picker-grid';

      for (let m = 1; m <= 12; m++) {
        const key = `${viewYear}-${String(m).padStart(2, '0')}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'month-picker-cell';
        btn.textContent = MONTH_ABBR[m - 1];

        const inRange = isInRange(viewYear, m);
        if (!inRange) {
          btn.disabled = true;
          btn.classList.add('out-of-range');
        }
        if (key === wrap.dataset.value) {
          btn.classList.add('selected');
        }

        if (inRange) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            wrap.dataset.value = key;
            trigger.textContent = `${MONTH_ABBR[m - 1]} ${viewYear}`;
            trigger.classList.add('has-value');
            closeDropdown();
            onChange();
          });
        }
        grid.append(btn);
      }

      dropdown!.append(grid);

      // Clear button
      if (wrap.dataset.value) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'month-picker-clear';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          wrap.dataset.value = '';
          trigger.textContent = placeholder;
          trigger.classList.remove('has-value');
          closeDropdown();
          onChange();
        });
        dropdown!.append(clearBtn);
      }
    }

    render();
    wrap.append(dropdown);

    requestAnimationFrame(() => {
      closeHandler = (e: MouseEvent) => {
        if (!wrap.contains(e.target as Node)) closeDropdown();
      };
      document.addEventListener('mousedown', closeHandler);
    });
  }

  function closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    if (closeHandler) {
      document.removeEventListener('mousedown', closeHandler);
      closeHandler = null;
    }
  }

  trigger.addEventListener('click', (e) => { e.stopPropagation(); openDropdown(); });
  wrap.append(trigger);
  return wrap;
}

function renderMoveRows(
  moves: ExplorerMove[],
  fen: string,
  analysis: PositionAnalysis | null,
  el: HTMLElement,
): void {
  const visibleMoves = moves.slice(0, EXPLORER_ROWS);
  const totalAllMoves = moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);

  const pctValues = visibleMoves.map(m => {
    const t = m.white + m.draws + m.black;
    return totalAllMoves > 0 ? (t / totalAllMoves) * 100 : 0;
  });

  let html = '<div class="explorer-header"><span>Move</span><span></span><span>Play rate</span><span>Games</span><span>Results</span><span></span></div>';
  html += '<div class="explorer-list">';

  for (let i = 0; i < visibleMoves.length; i++) {
    const move = visibleMoves[i];
    const total = move.white + move.draws + move.black;
    const pctNum = pctValues[i];
    const pct = pctNum.toFixed(1);
    const locked = isMoveLocked(fen, move.uci);
    const played = nextMoveUci === move.uci ? ' played' : '';
    const lockedCls = locked ? ' locked' : '';

    const wPct = total > 0 ? Math.round((move.white / total) * 100) : 0;
    const dPct = total > 0 ? Math.round((move.draws / total) * 100) : 0;
    const bPct = 100 - wPct - dPct;

    const badge = analysis ? getBadgeForMove(analysis, move.uci) : null;
    const badgeTooltipMap: Record<string, string> = { best: 'Best move', blunder: 'Mistake', trap: 'Popular trap' };
    const badgeTooltipAttr = badge && badge !== 'book' && badgeTooltipMap[badge] ? ` data-tooltip="${badgeTooltipMap[badge]}"` : '';
    const badgeHtml = badge && badge !== 'book' ? `<span class="move-badge badge-${badge.replace('_', '-')}"${badgeTooltipAttr}>${badgeSymbol(badge)}</span>` : '';
    const engineRank = engineTopMoves.get(move.uci);
    const starHtml = engineRank ? engineStarHtml(engineRank) : '';

    html += `<div class="explorer-move${played}${lockedCls}" data-uci="${move.uci}">
      <span class="explorer-san">${move.san}</span>
      <span class="explorer-badge-col">${starHtml}${badgeHtml}</span>
      <span class="explorer-pct"><span class="pct-fill" style="width:${pctNum}%"></span><span class="pct-label">${pct}%</span></span>
      <span class="explorer-games">${formatGames(total)}</span>
      <span class="explorer-bar">
        <span class="bar-white" style="width:${wPct}%" ${BAR_PCT_LABEL_ATTR}="${wPct}%">${wPct}%</span>
        <span class="bar-draw-neutral" style="width:${dPct}%" ${BAR_PCT_LABEL_ATTR}="${dPct}%">${dPct}%</span>
        <span class="bar-black" style="width:${bPct}%" ${BAR_PCT_LABEL_ATTR}="${bPct}%">${bPct}%</span>
      </span>
      <button class="lock-btn ${locked ? 'locked' : ''}"
              data-uci="${move.uci}" data-fen="${encodeURIComponent(fen)}"
              title="${locked ? 'Remove from opening' : 'Add to opening'}">
        ${locked
          ? '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>'
        }
      </button>
    </div>`;
  }

  for (let i = visibleMoves.length; i < EXPLORER_ROWS; i++) {
    html += `<div class="explorer-move empty-row">
      <span class="skeleton-bar" style="width:24px"></span>
      <span></span>
      <span class="skeleton-bar" style="width:32px"></span>
      <span class="skeleton-bar" style="width:20px"></span>
      <span class="skeleton-bar" style="width:100%"></span>
      <span></span>
    </div>`;
  }

  html += '</div>';

  const container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) el.append(container.firstChild);
  scheduleExplorerBarLabelFit(el);

  wireExplorerRowEvents(el, fen);
}

let lastToggledUci: string | null = null;

function wireExplorerRowEvents(el: HTMLElement, fen: string): void {
  // Animate lock button that was just toggled
  if (lastToggledUci) {
    const btn = el.querySelector(`.lock-btn[data-uci="${lastToggledUci}"]`) as HTMLElement | null;
    if (btn) {
      btn.classList.add('lock-snap');
      btn.addEventListener('animationend', () => btn.classList.remove('lock-snap'), { once: true });
    }
    lastToggledUci = null;
  }

  el.querySelectorAll('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const uci = target.dataset.uci!;
      const btnFen = decodeURIComponent(target.dataset.fen!);
      lastToggledUci = uci;
      if (isMoveLocked(btnFen, uci)) {
        unlockMove(btnFen, uci);
      } else {
        if (lockMove(btnFen, uci)) {
          renderSystemPicker();
          openingChangeCb?.();
        }
      }
      updateExplorerPanel();
    });
  });

  el.querySelectorAll('.explorer-move:not(.empty-row)').forEach((row) => {
    row.addEventListener('mouseenter', () => {
      const uci = (row as HTMLElement).dataset.uci;
      if (!uci || uci.length < 4) return;
      const orig = uci.slice(0, 2) as Key;
      const dest = uci.slice(2, 4) as Key;
      setAutoShapes([{ orig, dest, brush: 'blue' }]);
    });
    row.addEventListener('mouseleave', () => {
      setAutoShapes([]);
    });
  });

  if (explorerMoveClickCb) {
    el.querySelectorAll('.explorer-move').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.lock-btn')) return;
        const uci = (row as HTMLElement).dataset.uci!;
        explorerMoveClickCb!(uci);
      });
    });
  }
}

function boardFen(): string {
  const history = getMoveHistory();
  const vi = getViewIndex();
  if (vi === 0) return STARTING_FEN;
  return history[vi - 1].fen;
}

function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function updateExplorerPanel(): void {
  const el = document.getElementById('explorer-moves')!;
  el.innerHTML = '';

  const mode = getExplorerMode();
  const { fen, error } = getExplorerData();
  const currentBoardFen = boardFen();

  // Explorer data doesn't match the board — show loading skeleton
  if (mode === 'database' && !error && fenKey(fen) !== fenKey(currentBoardFen)) {
    let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
    html += '<div class="explorer-list explorer-skeleton">';
    for (let i = 0; i < EXPLORER_ROWS; i++) {
      html += '<div class="explorer-move skeleton-row">&nbsp;</div>';
    }
    html += '</div>';
    const container = document.createElement('div');
    container.innerHTML = html;
    while (container.firstChild) el.append(container.firstChild);
    return;
  }

  if (mode === 'personal') {
    if (!isDBReady()) {
      renderPersonalLoadingState(el);
      return;
    }
    if (!hasPersonalData()) {
      renderPersonalEmptyState(el);
      return;
    }

    // Apply color filter from picker (resolve relative to board orientation)
    let targetColor: 'white' | 'black' | undefined;
    if (personalColorFilter === 'both') {
      targetColor = undefined;
    } else {
      const orientation = getOrientation();
      const opposite = orientation === 'white' ? 'black' : 'white';
      targetColor = personalColorFilter === 'white' ? orientation : opposite;
    }
    const current = getPersonalFilters();
    if (current.color !== targetColor) {
      setPersonalFilters({ ...current, color: targetColor });
    }

    renderPersonalColorPicker(el);

    if (explorerFiltersOpen) {
      const infoWrap = document.createElement('div');
      infoWrap.className = 'personal-info-wrap';
      renderPersonalFilterPanel(infoWrap);
      el.append(infoWrap);
    }

    const personalData = queryPersonalExplorer(currentBoardFen);
    const moves = personalData?.moves ?? [];
    if (moves.length === 0) {
      const noData = document.createElement('div');
      noData.className = 'personal-empty-state';
      noData.style.padding = '16px';
      const totalGames = getFilteredGameCount();
      noData.textContent = totalGames > 0
        ? `None of your ${totalGames.toLocaleString()} games reached this position.`
        : 'No games in this position.';
      el.append(noData);
      updateRecentGamesPanel();
      return;
    }

    // No analysis badges in personal mode
    renderMoveRows(moves, currentBoardFen, null, el);
    updateRecentGamesPanel();
    return;
  }

  // Database mode — original logic
  const showContent = shouldShowExplorerContent();
  const { data } = getExplorerData();
  const moves = data?.moves ?? [];

  // Info bar (matches personal tab height)
  const infoBar = document.createElement('div');
  infoBar.className = 'database-info-bar';
  const openingName = data?.opening?.name;
  if (openingName) {
    infoBar.innerHTML = `<span class="database-opening-name">${openingName}</span>`;
  } else {
    infoBar.innerHTML = `<span class="database-opening-name text-muted">Lichess database</span>`;
  }
  const totalGames = moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);
  if (totalGames > 0) {
    infoBar.innerHTML += `<span class="database-game-count">${formatGames(totalGames)}</span>`;
  }

  // Cog icon for bot settings popover
  const cogWrap = document.createElement('div');
  cogWrap.className = 'explorer-cog-wrap';
  const cogBtn = document.createElement('button');
  cogBtn.className = 'explorer-cog-btn';
  cogBtn.title = 'Explorer settings';
  cogBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"/></svg>';

  const popover = document.createElement('div');
  popover.className = 'explorer-cog-popover hidden';
  popover.addEventListener('click', (e) => e.stopPropagation());

  // Top moves slider
  const topNLabel = document.createElement('label');
  topNLabel.className = 'cog-popover-label';
  topNLabel.textContent = `Top moves: ${currentConfig.topMoves}`;
  const topNSlider = document.createElement('input');
  topNSlider.type = 'range';
  topNSlider.min = '1';
  topNSlider.max = '10';
  topNSlider.value = String(currentConfig.topMoves);
  topNSlider.addEventListener('input', () => {
    currentConfig.topMoves = parseInt(topNSlider.value);
    topNLabel.textContent = `Top moves: ${currentConfig.topMoves}`;
    configChangeCb(currentConfig);
  });

  // Bot min play rate slider
  const playRateLabel = document.createElement('label');
  playRateLabel.className = 'cog-popover-label';
  playRateLabel.textContent = `Min play rate: ${currentConfig.botMinPlayRatePct}%`;
  const playRateSlider = document.createElement('input');
  playRateSlider.type = 'range';
  playRateSlider.min = '1';
  playRateSlider.max = '30';
  playRateSlider.value = String(currentConfig.botMinPlayRatePct);
  playRateSlider.addEventListener('input', () => {
    currentConfig.botMinPlayRatePct = parseInt(playRateSlider.value);
    playRateLabel.textContent = `Min play rate: ${currentConfig.botMinPlayRatePct}%`;
    configChangeCb(currentConfig);
  });

  // Bot weighting segment
  const weightLabel = document.createElement('label');
  weightLabel.className = 'cog-popover-label';
  weightLabel.textContent = 'Move selection';
  const weightSegment = document.createElement('div');
  weightSegment.className = 'segment-picker segment-sm';
  for (const opt of [{ value: 'weighted' as BotWeighting, label: 'Weighted' }, { value: 'equal' as BotWeighting, label: 'Equal' }]) {
    const btn = document.createElement('button');
    btn.className = `segment-btn${currentConfig.botWeighting === opt.value ? ' selected' : ''}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      if (currentConfig.botWeighting === opt.value) return;
      currentConfig.botWeighting = opt.value;
      weightSegment.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      configChangeCb(currentConfig);
    });
    weightSegment.append(btn);
  }

  // Rating chips
  const ratingsLabel = document.createElement('label');
  ratingsLabel.className = 'cog-popover-label';
  ratingsLabel.textContent = 'Ratings';
  const ratingsGrid = document.createElement('div');
  ratingsGrid.className = 'chip-grid';
  for (const r of RATING_OPTIONS) {
    const chip = document.createElement('button');
    chip.className = 'chip chip-sm';
    if (currentConfig.ratings.includes(r)) chip.classList.add('selected');
    chip.textContent = String(r);
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      currentConfig.ratings = Array.from(ratingsGrid.querySelectorAll('.chip.selected'))
        .map(c => Number(c.textContent)).sort((a, b) => a - b);
      configChangeCb(currentConfig);
    });
    ratingsGrid.append(chip);
  }

  // Time control chips
  const speedsLabel = document.createElement('label');
  speedsLabel.className = 'cog-popover-label';
  speedsLabel.textContent = 'Time controls';
  const speedsGrid = document.createElement('div');
  speedsGrid.className = 'chip-grid';
  for (const s of SPEED_OPTIONS) {
    const chip = document.createElement('button');
    chip.className = 'chip chip-sm';
    if (currentConfig.speeds.includes(s)) chip.classList.add('selected');
    chip.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    chip.dataset.speed = s;
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      currentConfig.speeds = Array.from(speedsGrid.querySelectorAll('.chip.selected'))
        .map(c => (c as HTMLElement).dataset.speed!);
      configChangeCb(currentConfig);
    });
    speedsGrid.append(chip);
  }

  const divider = document.createElement('hr');
  divider.className = 'cog-popover-divider';

  // Lichess API token (collapsed by default)
  const tokenToggle = document.createElement('button');
  tokenToggle.className = 'token-toggle';
  tokenToggle.textContent = currentConfig.lichessToken ? 'Custom token \u2713' : 'Use own Lichess token';
  const tokenSection = document.createElement('div');
  tokenSection.className = 'token-section hidden';
  const tokenWrap = document.createElement('div');
  tokenWrap.className = 'token-input-wrap';
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.className = 'token-input';
  tokenInput.placeholder = 'lip_...';
  tokenInput.value = currentConfig.lichessToken || '';
  tokenInput.spellcheck = false;
  tokenInput.autocomplete = 'off';
  tokenInput.addEventListener('change', () => {
    const val = tokenInput.value.trim();
    currentConfig.lichessToken = val;
    tokenToggle.textContent = val ? 'Custom token \u2713' : 'Use own Lichess token';
    configChangeCb(currentConfig);
  });
  tokenWrap.append(tokenInput);
  const tokenHint = document.createElement('a');
  tokenHint.className = 'token-hint';
  tokenHint.href = 'https://lichess.org/account/oauth/token/create';
  tokenHint.target = '_blank';
  tokenHint.rel = 'noopener';
  tokenHint.textContent = 'Create token (no scopes needed)';
  tokenSection.append(tokenWrap, tokenHint);
  tokenToggle.addEventListener('click', () => {
    tokenSection.classList.toggle('hidden');
  });

  const divider2 = document.createElement('hr');
  divider2.className = 'cog-popover-divider';

  popover.append(ratingsLabel, ratingsGrid, speedsLabel, speedsGrid, divider, topNLabel, topNSlider, playRateLabel, playRateSlider, weightLabel, weightSegment, divider2, tokenToggle, tokenSection);

  cogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !popover.classList.contains('hidden');
    closeAllDropdowns();
    if (!isOpen) popover.classList.remove('hidden');
  });

  cogWrap.append(cogBtn);
  infoBar.append(cogWrap, popover);
  el.append(infoBar);

  if (error || !showContent) {
    const loading = !data && !error;
    let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
    html += `<div class="explorer-list explorer-skeleton${loading ? '' : ' skeleton-static'}">`;
    for (let i = 0; i < EXPLORER_ROWS; i++) {
      html += `<div class="explorer-move${loading ? ' skeleton-row' : ''}">&nbsp;</div>`;
    }
    if (error) {
      const isRetrying = error.includes('retrying');
      html += '<div class="explorer-hint explorer-hint-error">';
      if (isRetrying) {
        html += '<div class="explorer-error-spinner"></div>';
        html += `<span>${error}</span>`;
        html += '<span class="explorer-error-sub">Retrying automatically</span>';
      } else {
        const isNetwork = error.startsWith('network:');
        const displayMsg = error.replace(/^(network|ratelimit|error):/, '');
        html += '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
        html += `<span>${displayMsg}</span>`;
        if (isNetwork) {
          html += '<span class="explorer-error-sub">Check your internet connection</span>';
        }
        html += '<button class="btn btn-sm explorer-error-retry">Retry</button>';
      }
      if (hasPersonalData()) {
        html += '<button class="btn btn-sm explorer-error-switch">Switch to My Games</button>';
      }
      html += '</div>';
    } else {
      html += '<div class="explorer-hint">Moves hidden while you think \u2014 click to peek</div>';
    }
    html += '</div>';
    const container = document.createElement('div');
    container.innerHTML = html;
    while (container.firstChild) el.append(container.firstChild);

    const list = el.querySelector('.explorer-list')!;
    if (error) {
      const retryBtn = list.querySelector('.explorer-error-retry');
      retryBtn?.addEventListener('click', () => retryExplorerCb?.());
      const switchBtn = list.querySelector('.explorer-error-switch');
      switchBtn?.addEventListener('click', () => applySidebarTab('personal'));
    } else {
      list.addEventListener('click', () => {
        explorerRevealed = true;
        updateExplorerPanel();
      });
    }
    return;
  }

  // Out-of-book / no moves empty state
  if (moves.length === 0 && data) {
    const phase = getPhase();
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'explorer-empty-state';
    if (phase === 'OUT_OF_BOOK' || phase === 'GAME_OVER') {
      const msgEl = document.createElement('span');
      msgEl.textContent = 'No moves found in the opening database';
      emptyDiv.append(msgEl);
      const newGameBtn = document.createElement('button');
      newGameBtn.className = 'btn btn-sm';
      newGameBtn.textContent = 'New game';
      newGameBtn.addEventListener('click', () => newGameCb());
      emptyDiv.append(newGameBtn);
    } else {
      emptyDiv.textContent = 'No moves in the database for this position.';
    }
    el.append(emptyDiv);
    updateRecentGamesPanel();
    return;
  }

  const showBadges = currentConfig.showMoveBadges && moves.length > 0;
  const result = showBadges ? currentAnalysis() : null;
  const analysis = result?.analysis ?? null;

  if (showBadges && analysis) {
    const legend = document.createElement('div');
    legend.className = 'badge-legend';
    legend.innerHTML =
      '<span class="badge-legend-item"><span class="badge-legend-dot dot-best"></span> Best</span>' +
      '<span class="badge-legend-item"><span class="badge-legend-dot dot-blunder"></span> Mistake</span>' +
      '<span class="badge-legend-item"><span class="badge-legend-dot dot-trap"></span> Trap</span>';
    el.appendChild(legend);
  }

  renderMoveRows(moves, fen, analysis, el);
  updateRecentGamesPanel();
}

let savedRecentGamesScroll = 0;

function updateRecentGamesPanel(): void {
  const container = document.getElementById('recent-games-container');
  if (!container) return;
  const prevList = container.querySelector('.recent-games-list');
  if (prevList) savedRecentGamesScroll = prevList.scrollTop;
  container.innerHTML = '';
  const hasData = isDBReady() && hasPersonalData();
  const sectionHeader = document.getElementById('games-section-header');

  // Show/hide sidebar tabs based on whether personal data exists
  const sidebarTabs = document.getElementById('sidebar-tabs');
  if (sidebarTabs) {
    sidebarTabs.style.display = hasData || !isDBReady() ? '' : 'none';
    if (!hasData && isDBReady() && activeTab === 'personal') {
      applySidebarTab('database');
    }
  }

  const gamesSection = sectionHeader?.closest('.sidebar-section-games') as HTMLElement | null;

  if (!hasData) {
    // Reset header to static "Games"
    if (sectionHeader) {
      sectionHeader.className = 'sidebar-section-header';
      sectionHeader.innerHTML = 'Games';
    }
    gamesSection?.classList.remove('games-card');
    const empty = document.createElement('div');
    empty.className = 'recent-games-empty';
    empty.innerHTML =
      `<p class="recent-games-empty-title">Import your games</p>` +
      `<p>Connect your Lichess or Chess.com account to unlock personal features:</p>` +
      `<ul>` +
      `<li>Browse your <b>recent games</b> and jump to any opening</li>` +
      `<li>Get a <b>games report</b> that identifies your weaknesses</li>` +
      `<li>Practice against <b>your opponents' moves</b> instead of the global database</li>` +
      `</ul>`;
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-primary';
    importBtn.textContent = 'Import games';
    importBtn.addEventListener('click', () => openPersonalImportModal());
    empty.append(importBtn);
    container.append(empty);
    return;
  }

  // Row 1: Identity header — username + game count + refresh/clear actions
  const cfg = getPersonalConfig()!;
  const total = cfg.gameCount;

  gamesSection?.classList.add('games-card');

  if (sectionHeader) {
    sectionHeader.className = 'games-identity-row';
    const nameSpan = `<span class="games-identity-name">${cfg.username}</span>`;
    const countSpan = `<span class="games-identity-count">&middot; ${formatGames(total)} games</span>`;
    const refreshSvg = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;
    const clearSvg = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
    sectionHeader.innerHTML =
      `<span class="games-identity-text">${nameSpan} ${countSpan}</span>` +
      `<span class="games-identity-actions">` +
      `<button class="games-identity-action" data-action="refresh" title="Refresh games">${refreshSvg}</button>` +
      `<button class="games-identity-action" data-action="clear" title="Clear imported games">${clearSvg}</button>` +
      `</span>`;

    const refreshBtn = sectionHeader.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
    refreshBtn.addEventListener('click', () => refreshRecentGames(refreshBtn));

    const clearBtn = sectionHeader.querySelector<HTMLButtonElement>('[data-action="clear"]')!;
    clearBtn.addEventListener('click', async () => {
      const result = await confirmModal({
        title: 'Clear imported games?',
        message: 'This will remove all imported game data. You can re-import at any time.',
        buttons: [{ label: 'Clear', value: 'clear', style: 'danger' }],
        danger: true,
        anchor: clearBtn,
      });
      if (result !== 'clear') return;
      await clearPersonalData();
      explorerFiltersOpen = false;
      recentGamesFiltersOpen = false;
      updateExplorerPanel();
      updateRecentGamesPanel();
    });
  }

  // Row 2: Report button
  const reportBtn = document.createElement('button');
  reportBtn.className = 'btn outline games-report-btn';
  reportBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg> Games report`;
  reportBtn.addEventListener('click', () => openReportPage());
  container.append(reportBtn);

  renderRecentGames(container);
}

// ── Recent Games ──

let recentGamesRefreshing = false;
let recentGamesColorFilter: 'all' | 'white' | 'black' = 'all';

async function refreshRecentGames(btn: HTMLButtonElement): Promise<void> {
  if (recentGamesRefreshing) return;
  const cfg = getPersonalConfig();
  if (!cfg) return;

  recentGamesRefreshing = true;
  btn.disabled = true;
  btn.classList.add('spinning');

  try {
    if (cfg.platform === 'lichess') {
      const filters: LichessFilters = {};
      const speeds = currentConfig.speeds;
      if (speeds.length > 0 && speeds.length < 4) {
        filters.perfType = speeds;
      }
      await importFromLichess(cfg.username, () => {}, undefined, filters);
    } else {
      await importFromChesscom(cfg.username, () => {});
    }
    updateRecentGamesPanel();
    updateExplorerPanel();
  } finally {
    recentGamesRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

async function refreshExplorerGames(btn: HTMLButtonElement): Promise<void> {
  if (recentGamesRefreshing) return;
  const cfg = getPersonalConfig();
  if (!cfg) return;

  recentGamesRefreshing = true;
  btn.disabled = true;
  btn.classList.add('spinning');

  try {
    if (cfg.platform === 'lichess') {
      const filters: LichessFilters = {};
      const speeds = currentConfig.speeds;
      if (speeds.length > 0 && speeds.length < 4) {
        filters.perfType = speeds;
      }
      await importFromLichess(cfg.username, () => {}, undefined, filters);
    } else {
      await importFromChesscom(cfg.username, () => {});
    }
    updateRecentGamesPanel();
    updateExplorerPanel();
  } finally {
    recentGamesRefreshing = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

function userResult(game: GameMeta): 'win' | 'draw' | 'loss' {
  if (game.re === 'd') return 'draw';
  const whiteWon = game.re === 'w';
  return (whiteWon === game.uw) ? 'win' : 'loss';
}

function shortDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 2) return dateStr;
  const yy = parts[0].slice(-2);
  const m = parseInt(parts[1], 10);
  if (parts.length >= 3 && parts[2] !== '01') {
    return `${parseInt(parts[2], 10)}/${m}/${yy}`;
  }
  return `${m}/${yy}`;
}

function pgnToLine(pgn: string): MoveHistoryEntry[] {
  const tokens = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/).filter(t => t && t !== '*');
  const chess = Chess.default();
  const line: MoveHistoryEntry[] = [];
  for (const san of tokens) {
    const move = parseSan(chess, san);
    if (!move) break;
    const uci = makeUci(move);
    chess.play(move);
    line.push({ san, uci, fen: '' }); // fen rebuilt by replayLine
  }
  return line;
}

function uciStringToLine(uciStr: string): MoveHistoryEntry[] {
  const tokens = uciStr.trim().split(/\s+/).filter(Boolean);
  const chess = Chess.default();
  const line: MoveHistoryEntry[] = [];
  for (const token of tokens) {
    const move = parseUci(token);
    if (!move) break;
    const san = makeSan(chess, move);
    chess.play(move);
    line.push({ san, uci: token, fen: '' });
  }
  return line;
}

function gameTimestamp(game: GameMeta): string {
  const date = game.da ?? game.mo;
  const time = game.ti ?? '';
  return time ? `${date}T${time}` : date;
}

function renderRecentGames(container: HTMLElement): void {
  const games = getPersonalGames();
  if (!games || games.length === 0) return;

  // Sort all games by date, newest first
  const indexed = games.map((g, i) => ({ game: g, idx: i }));
  indexed.sort((a, b) => {
    const cmp = gameTimestamp(b.game).localeCompare(gameTimestamp(a.game));
    return cmp !== 0 ? cmp : b.idx - a.idx;
  });

  // Apply color filter + personal filters (time control, rating, date)
  const filtered = indexed.filter(({ game }) => {
    if (recentGamesColorFilter === 'white' && !game.uw) return false;
    if (recentGamesColorFilter === 'black' && game.uw) return false;
    return gameMatchesFilters(game, { ignoreColor: true });
  });

  const section = document.createElement('div');
  section.className = 'recent-games';

  // Row 3: Label + filter icon
  const filterRow = document.createElement('div');
  filterRow.className = 'recent-games-filters';
  const filterLabel = document.createElement('span');
  filterLabel.className = 'recent-games-filters-label';
  filterLabel.textContent = 'Recent Games';
  filterRow.append(filterLabel);

  const filterBtn = document.createElement('button');
  filterBtn.className = 'games-identity-action' + (recentGamesFiltersOpen ? ' active' : '');
  filterBtn.title = 'Filter games';
  filterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>`;
  filterBtn.addEventListener('click', () => {
    recentGamesFiltersOpen = !recentGamesFiltersOpen;
    updateRecentGamesPanel();
  });
  filterRow.append(filterBtn);
  section.append(filterRow);

  // Shared personal filter panel (time control, rating, date)
  const filterWrap = document.createElement('div');
  filterWrap.className = 'personal-info-wrap';
  renderPersonalFilterPanel(filterWrap, 'recent-games');
  section.append(filterWrap);

  const BATCH_SIZE = 40;
  let rendered = 0;

  const list = document.createElement('div');
  list.className = 'recent-games-list';
  let recentScrollTimer = 0;
  list.addEventListener('scroll', () => {
    list.classList.add('scrolling');
    clearTimeout(recentScrollTimer);
    recentScrollTimer = window.setTimeout(() => list.classList.remove('scrolling'), 1000);
  }, { passive: true });

  function renderBatch(): void {
    const end = Math.min(rendered + BATCH_SIZE, filtered.length);
    for (let i = rendered; i < end; i++) {
      list.append(renderGameRow(filtered[i].game));
    }
    rendered = end;
  }

  // Render enough batches to cover the saved scroll position
  const estimatedRowHeight = 30;
  const minItems = savedRecentGamesScroll > 0
    ? Math.ceil(savedRecentGamesScroll / estimatedRowHeight) + BATCH_SIZE
    : BATCH_SIZE;
  while (rendered < Math.min(minItems, filtered.length)) {
    renderBatch();
  }

  list.addEventListener('scroll', () => {
    if (rendered >= filtered.length) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
      renderBatch();
    }
  });

  section.append(list);
  container.append(section);

  if (savedRecentGamesScroll > 0) {
    list.scrollTop = savedRecentGamesScroll;
  }
}

function updateRecentGamesList(): void {
  const el = document.querySelector<HTMLElement>('.recent-games-list');
  if (!el) return;
  const list = el;
  list.innerHTML = '';

  const games = getPersonalGames();
  if (!games || games.length === 0) return;

  const indexed = games.map((g, i) => ({ game: g, idx: i }));
  indexed.sort((a, b) => {
    const cmp = gameTimestamp(b.game).localeCompare(gameTimestamp(a.game));
    return cmp !== 0 ? cmp : b.idx - a.idx;
  });

  const filtered = indexed.filter(({ game }) => {
    if (recentGamesColorFilter === 'white' && !game.uw) return false;
    if (recentGamesColorFilter === 'black' && game.uw) return false;
    return gameMatchesFilters(game, { ignoreColor: true });
  });

  const BATCH_SIZE = 40;
  let rendered = 0;

  function renderBatch(): void {
    const end = Math.min(rendered + BATCH_SIZE, filtered.length);
    for (let i = rendered; i < end; i++) {
      list.append(renderGameRow(filtered[i].game));
    }
    rendered = end;
  }

  renderBatch();

  list.addEventListener('scroll', () => {
    if (rendered >= filtered.length) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) {
      renderBatch();
    }
  });
}

function badgeSymbol(badge: MoveBadge): string {
  switch (badge) {
    case 'best': return '!';
    case 'blunder': return '?';
    case 'trap': return '?!';
    default: return '';
  }
}

function downloadPgn(pgn: string, filename: string): void {
  if (!pgn) return;
  const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatGames(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function tcIcon(tc: string): string {
  switch (tc) {
    case 'bullet': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>';
    case 'blitz': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 23c-1.2 0-2.4-.3-3.5-.7 2.3-1.7 3.5-4.5 3.5-7.3 0-3-1.5-5.8-3.9-7.5C6.4 9.2 5.5 11.5 5.5 14c0 1-.1 2-.4 3C3.2 15.2 2 12.7 2 10c0-4.6 3.4-8.4 7.8-9-.5.8-.8 1.8-.8 2.8 0 2.9 2.4 5.2 5.3 5.2 2.2 0 4-.1 5.2-1.5.4 1 .5 2 .5 3 0 6.9-5 12.5-8 12.5z"/></svg>';
    case 'rapid': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg>';
    case 'classical': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 2l.5 3H11V2H6zm7 0v3h4.5L18 2h-5zM6 22l.5-3H11v3H6zm7 0v-3h4.5l.5 3h-5zm-6.5-5H11v-4H5.2l1.3 4zm7.5-4v4h4.5l1.3-4H14zM5.7 11H11V7H6.5L5.7 11zM13 7v4h5.3l-.8-4H13z"/></svg>';
    case 'daily': return '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>';
    default: return '';
  }
}

function renderGameRow(game: GameMeta): HTMLDivElement {
  const result = userResult(game);

  const row = document.createElement('div');
  row.className = 'recent-game-row';

  if (loadedGame === game) {
    row.classList.add('selected');
  }

  if (game.mv || game.ec) {
    const color = game.uw ? 'white' : 'black';
    row.classList.add('clickable');
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.recent-game-external')) return;
      if (loadedGame === game) {
        clearLoadedGame();
        newGameCb();
        return;
      }
      let line: MoveHistoryEntry[] = [];
      if (game.mv) {
        line = uciStringToLine(game.mv);
      } else if (game.ec) {
        const entry = findPgnByEco(game.ec);
        if (entry) line = pgnToLine(entry.pgn);
      }
      if (line.length > 0) {
        loadedGame = game;
        setOrientation(color);
        replayLine(line, 0);
        updateRecentGamesPanel();
      }
    });
  }

  row.classList.add(game.uw ? 'as-white' : 'as-black');

  const badge = document.createElement('span');
  badge.className = `recent-game-result ${result}`;
  badge.textContent = result === 'win' ? 'W' : result === 'draw' ? 'D' : 'L';

  const tcSvg = tcIcon(game.tc);
  const tcEl = document.createElement('span');
  tcEl.className = 'recent-game-tc';
  if (tcSvg) {
    tcEl.innerHTML = tcSvg;
    tcEl.title = game.tc.charAt(0).toUpperCase() + game.tc.slice(1);
  }

  const opening = document.createElement('span');
  opening.className = 'recent-game-opening';
  opening.textContent = (game.ec ? findOpeningByEco(game.ec) ?? game.ec : '—');

  const rating = document.createElement('span');
  rating.className = 'recent-game-rating';
  rating.textContent = String(game.or);

  const oppName = game.op ?? 'Opponent';
  const dateStr = shortDate(game.da ?? game.mo);
  const tooltip = `vs ${oppName} (${game.or}) · ${dateStr}`;
  row.setAttribute('data-tooltip', tooltip);

  row.append(badge, tcEl, opening, rating);

  if (game.gl) {
    const ext = document.createElement('a');
    ext.className = 'recent-game-external';
    ext.href = game.gl;
    ext.target = '_blank';
    ext.rel = 'noreferrer noopener';
    ext.title = 'Open game';
    ext.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z"/><path fill="currentColor" d="M5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>';
    ext.addEventListener('click', (e) => e.stopPropagation());
    row.append(ext);
  }

  return row;
}

// ── PGN Import Modal ──

let pgnModalInitialized = false;

function initPgnModal(): void {
  if (pgnModalInitialized) return;
  pgnModalInitialized = true;

  document.getElementById('pgn-modal-close')!.addEventListener('click', closePgnModal);
  document.getElementById('pgn-modal-overlay')!.addEventListener('click', closePgnModal);
  document.getElementById('pgn-cancel-btn')!.addEventListener('click', closePgnModal);
  document.getElementById('pgn-import-btn')!.addEventListener('click', doPgnImport);
  document.getElementById('study-fetch-btn')!.addEventListener('click', doStudyFetch);
  document.getElementById('study-url-input')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doStudyFetch();
  });
}

function openPgnModal(): void {
  initPgnModal();
  const overlay = document.getElementById('pgn-modal-overlay')!;
  const modal = document.getElementById('pgn-modal')!;
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const result = document.getElementById('pgn-result')!;

  textarea.value = '';
  (document.getElementById('study-url-input') as HTMLInputElement).value = '';
  result.textContent = '';
  result.className = 'pgn-result';

  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');

  requestAnimationFrame(() => textarea.focus());
}

function closePgnModal(): void {
  const overlay = document.getElementById('pgn-modal-overlay')!;
  const modal = document.getElementById('pgn-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
}

async function doStudyFetch(): Promise<void> {
  const input = document.getElementById('study-url-input') as HTMLInputElement;
  const resultEl = document.getElementById('pgn-result')!;
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const btn = document.getElementById('study-fetch-btn') as HTMLButtonElement;
  const url = input.value.trim();

  if (!url) {
    resultEl.textContent = 'Please enter a Lichess study URL.';
    resultEl.className = 'pgn-result error';
    return;
  }

  btn.disabled = true;
  input.disabled = true;
  btn.textContent = 'Fetching…';
  resultEl.textContent = '';
  resultEl.className = 'pgn-result';

  try {
    const pgn = await fetchStudyPgn(url);
    textarea.value = pgn;
    resultEl.textContent = 'Study loaded — click Import to create a new opening.';
    resultEl.className = 'pgn-result success';
  } catch (e: unknown) {
    resultEl.textContent = e instanceof Error ? e.message : 'Failed to fetch study';
    resultEl.className = 'pgn-result error';
  } finally {
    btn.disabled = false;
    input.disabled = false;
    btn.textContent = 'Fetch';
  }
}

function doPgnImport(): void {
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const resultEl = document.getElementById('pgn-result')!;
  const pgn = textarea.value.trim();

  if (!pgn) {
    resultEl.textContent = 'Please paste a PGN first.';
    resultEl.className = 'pgn-result error';
    return;
  }

  const result = importPgn(pgn);

  if (result.moves === 0 && result.errors.length > 0) {
    resultEl.textContent = `Import failed: ${result.errors[0]}`;
    resultEl.className = 'pgn-result error';
    return;
  }

  const nameStr = result.openingNames.length === 1
    ? `"${result.openingNames[0]}"`
    : `${result.openingNames.length} openings`;
  let msg = `Created ${nameStr} with ${result.moves} move${result.moves !== 1 ? 's' : ''} across ${result.positions} position${result.positions !== 1 ? 's' : ''}.`;
  if (result.errors.length > 0) {
    msg += ` (${result.errors.length} error${result.errors.length !== 1 ? 's' : ''} skipped)`;
  }
  resultEl.textContent = msg;
  resultEl.className = 'pgn-result success';

  // Refresh UI
  renderSystemPicker();
  updateExplorerPanel();
  updateMoveList();
  openingChangeCb?.();

  setTimeout(closePgnModal, 1500);
}

// ── Personal Games Import Modal ──

let personalModalInitialized = false;
let importAbortController: AbortController | null = null;
let selectedPlatform: Platform = 'lichess';

function initPersonalImportModal(): void {
  if (personalModalInitialized) return;
  personalModalInitialized = true;

  document.getElementById('personal-import-close')!.addEventListener('click', closePersonalImportModal);
  document.getElementById('personal-import-overlay')!.addEventListener('click', closePersonalImportModal);

  // Platform toggle
  document.querySelectorAll('#personal-import-modal .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const platform = (btn as HTMLElement).dataset.platform as Platform;
      if (platform === selectedPlatform) return;
      selectedPlatform = platform;
      document.querySelectorAll('#personal-import-modal .segment-btn').forEach(b =>
        b.classList.toggle('selected', (b as HTMLElement).dataset.platform === platform)
      );
      updateImportFiltersVisibility();
    });
  });

  // Speed filter chip toggles
  document.querySelectorAll('#personal-filters .chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });

  // Import range segment picker + custom input
  const rangeMonthsInput = document.getElementById('personal-months-input') as HTMLInputElement;
  document.querySelectorAll('.import-range-picker .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.import-range-picker .segment-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      rangeMonthsInput.value = '';
    });
  });
  rangeMonthsInput.addEventListener('input', () => {
    if (rangeMonthsInput.value.trim()) {
      document.querySelectorAll('.import-range-picker .segment-btn').forEach(b => b.classList.remove('selected'));
    }
  });

  document.getElementById('personal-import-btn')!.addEventListener('click', doPersonalImport);
  document.getElementById('personal-import-cancel')!.addEventListener('click', () => {
    importAbortController?.abort();
  });

  document.getElementById('personal-username')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doPersonalImport();
  });
}

function getSelectedMaxMonths(): number | undefined {
  const customVal = (document.getElementById('personal-months-input') as HTMLInputElement).value.trim();
  if (customVal) {
    const parsed = parseInt(customVal, 10);
    if (parsed > 0) return parsed;
  }
  const selected = document.querySelector('.import-range-picker .segment-btn.selected') as HTMLElement | null;
  const val = selected ? parseInt(selected.dataset.months ?? '0', 10) : 0;
  return val > 0 ? val : undefined;
}

function getSelectedSpeeds(): string[] {
  const chips = document.querySelectorAll('#personal-filters .chip.selected');
  return Array.from(chips).map(c => (c as HTMLElement).dataset.speed!);
}

function updateImportFiltersVisibility(): void {
  const filtersEl = document.getElementById('personal-filters')!;
  // Speed filters only for Lichess; range picker always visible
  filtersEl.classList.toggle('hidden', selectedPlatform !== 'lichess');
}

function openPersonalImportModal(): void {
  initPersonalImportModal();
  const overlay = document.getElementById('personal-import-overlay')!;
  const modal = document.getElementById('personal-import-modal')!;
  const resultEl = document.getElementById('personal-import-result')!;
  const progressEl = document.getElementById('personal-import-progress')!;

  // Pre-fill from existing config
  const cfg = getPersonalConfig();
  if (cfg) {
    selectedPlatform = cfg.platform;
    (document.getElementById('personal-username') as HTMLInputElement).value = cfg.username;
    document.querySelectorAll('#personal-import-modal .segment-btn').forEach(b =>
      b.classList.toggle('selected', (b as HTMLElement).dataset.platform === cfg.platform)
    );
  }

  resultEl.textContent = '';
  resultEl.className = 'pgn-result';
  progressEl.classList.add('hidden');
  updateImportFiltersVisibility();

  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');

  requestAnimationFrame(() => {
    (document.getElementById('personal-username') as HTMLInputElement).focus();
  });
}

function closePersonalImportModal(): void {
  importAbortController?.abort();
  const overlay = document.getElementById('personal-import-overlay')!;
  const modal = document.getElementById('personal-import-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
}

async function doPersonalImport(): Promise<void> {
  const usernameInput = document.getElementById('personal-username') as HTMLInputElement;
  const resultEl = document.getElementById('personal-import-result')!;
  const progressEl = document.getElementById('personal-import-progress')!;
  const progressText = progressEl.querySelector('.personal-progress-text')!;
  const progressFill = progressEl.querySelector('.personal-progress-fill')! as HTMLElement;
  const importBtn = document.getElementById('personal-import-btn') as HTMLButtonElement;

  const username = usernameInput.value.trim();
  if (!username) {
    resultEl.textContent = 'Please enter a username.';
    resultEl.className = 'pgn-result error';
    return;
  }

  importBtn.disabled = true;
  resultEl.textContent = '';
  resultEl.className = 'pgn-result';
  progressEl.classList.remove('hidden');
  progressFill.classList.add('indeterminate');

  importAbortController = new AbortController();

  const onProgress = (msg: string, count: number) => {
    progressText.textContent = `${msg} (${formatGames(count)} games)`;
  };

  try {
    let total: number;
    const maxMonths = getSelectedMaxMonths();
    if (selectedPlatform === 'lichess') {
      const speeds = getSelectedSpeeds();
      const filters: LichessFilters = {};
      if (speeds.length > 0 && speeds.length < 4) {
        filters.perfType = speeds;
      }
      if (maxMonths) {
        const since = new Date();
        since.setMonth(since.getMonth() - maxMonths);
        filters.since = since.getTime();
      }
      total = await importFromLichess(username, onProgress, importAbortController.signal, filters);
    } else {
      total = await importFromChesscom(username, onProgress, importAbortController.signal, maxMonths);
    }

    progressFill.classList.remove('indeterminate');
    progressFill.style.width = '100%';
    resultEl.textContent = `Imported ${formatGames(total)} games from ${selectedPlatform === 'lichess' ? 'Lichess' : 'Chess.com'}.`;
    resultEl.className = 'pgn-result success';

    switchSidebarTab('personal');
    updateExplorerPanel();
    setTimeout(closePersonalImportModal, 1500);
  } catch (e: unknown) {
    progressFill.classList.remove('indeterminate');
    const msg = e instanceof Error ? e.message : 'Import failed';
    if (msg !== 'Import cancelled') {
      resultEl.textContent = msg;
      resultEl.className = 'pgn-result error';
    } else {
      resultEl.textContent = 'Import cancelled.';
      resultEl.className = 'pgn-result';
    }
  } finally {
    importBtn.disabled = false;
    importAbortController = null;
  }
}

// ── Tooltip System ──

function initTooltips(): void {
  const popup = document.createElement('div');
  popup.className = 'tooltip-popup';
  document.body.append(popup);

  const MARGIN = 8;

  function showPopup(target: HTMLElement, content: string, isHtml: boolean): void {
    if (isHtml) {
      popup.innerHTML = content;
    } else {
      popup.textContent = content;
    }
    popup.classList.toggle('tooltip-wide', target.classList.contains('tooltip-wide') || isHtml);
    popup.classList.toggle('tooltip-preline', target.classList.contains('tooltip-preline'));

    // Position off-screen to measure
    popup.style.left = '0';
    popup.style.top = '0';
    popup.classList.add('visible');

    const rect = target.getBoundingClientRect();
    const popRect = popup.getBoundingClientRect();
    const below = target.classList.contains('tooltip-below');

    let top: number;
    if (below || rect.top - popRect.height - MARGIN < 0) {
      top = rect.bottom + MARGIN;
    } else {
      top = rect.top - popRect.height - MARGIN;
    }

    let left = rect.left + rect.width / 2 - popRect.width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - popRect.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - popRect.height - MARGIN));

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  document.addEventListener('mouseenter', (e) => {
    const el = e.target as HTMLElement;

    // Info-icon tooltips (rich HTML)
    const infoWrap = el.closest?.('.info-icon-wrap') as HTMLElement | null;
    if (infoWrap) {
      const infoTip = infoWrap.querySelector('.info-tooltip') as HTMLElement | null;
      if (infoTip) {
        showPopup(infoWrap, infoTip.innerHTML, true);
        return;
      }
    }

    // Data-tooltip (plain text)
    const target = el.closest?.('[data-tooltip]') as HTMLElement | null;
    if (!target) return;
    const isHtmlTooltip = target.classList.contains('tooltip-html');
    showPopup(target, target.getAttribute('data-tooltip')!, isHtmlTooltip);
  }, true);

  document.addEventListener('mouseleave', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest?.('.info-icon-wrap') || el.closest?.('[data-tooltip]')) {
      popup.classList.remove('visible');
    }
  }, true);
}

// ── Help Modal ──

function initHelpModal(): void {
  document.getElementById('help-close')!.addEventListener('click', closeHelpModal);
  document.getElementById('help-overlay')!.addEventListener('click', closeHelpModal);
}

function openHelpModal(): void {
  const overlay = document.getElementById('help-overlay')!;
  const modal = document.getElementById('help-modal')!;
  overlay.classList.remove('hidden');
  overlay.classList.add('visible');
  modal.classList.remove('hidden');
}

function closeHelpModal(): void {
  const overlay = document.getElementById('help-overlay')!;
  const modal = document.getElementById('help-modal')!;
  overlay.classList.remove('visible');
  overlay.classList.add('hidden');
  modal.classList.add('hidden');
}

// ── Sidebar Tabs ──

type SidebarTab = 'database' | 'personal';
let activeTab: SidebarTab = 'database';

export function initSidebarTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .segment-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab as SidebarTab;
      if (id === activeTab) return;
      applySidebarTab(id);
    });
  });

}

function applySidebarTab(id: SidebarTab): void {
  activeTab = id;

  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .segment-btn');
  tabs.forEach(t => t.classList.toggle('selected', t.dataset.tab === id));



  const mode = id === 'database' ? 'database' : 'personal';
  if (getExplorerMode() !== mode) {
    setExplorerMode(mode);
    modeChangeCb?.();
  }
  updateExplorerPanel();
}

export function switchSidebarTab(id: SidebarTab): void {
  if (id === activeTab) return;
  applySidebarTab(id);
}

export function toggleLockCurrentMove(): void {
  const { data, fen } = getExplorerData();
  if (!data || !fen || !nextMoveUci) return;

  const move = data.moves.find(m => m.uci === nextMoveUci);
  if (!move) return;

  if (isMoveLocked(fen, nextMoveUci)) {
    unlockMove(fen, nextMoveUci);
  } else {
    if (lockMove(fen, nextMoveUci)) {
      renderSystemPicker();
      openingChangeCb?.();
    }
  }
  updateExplorerPanel();
  updateMoveList();
}

export function isAnyModalOpen(): boolean {
  if (isReportPageOpen()) return true;
  const modalIds = ['settings-drawer', 'pgn-modal', 'help-modal', 'personal-import-modal', 'library-modal', 'confirm-overlay', 'onboarding-overlay'];
  return modalIds.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

export { openHelpModal };
