import type {
  AppConfig,
  AlertType,
  BotWeighting,
  ExplorerMove,
  ExplorerResponse,
  GamePhase,
  MoveBadge,
  PlayerColor,
  PositionAnalysis,
} from './types';
import { ALL_ALERT_TYPES, RATING_OPTIONS, SPEED_OPTIONS } from './types';
import type { Key } from '@lichess-org/chessground/types';
import { getMoveHistory, getViewIndex, isViewingHistory, navigateTo, setAutoShapes, getOrientation } from './board';
import {
  isMoveLocked, lockMove, unlockMove, getLockedMoves,
  getOpeningNames, getActiveOpening, switchOpening, createOpening, deleteOpening, renameOpening,
  mergeOpenings,
  FREE_PLAY_NAME,
  FULL_REPERTOIRE_NAME,
} from './repertoire';
import type { MergeStrategy } from './repertoire';
import { importPgn, fetchStudyPgn } from './pgn-import';
import { initLibraryModal, openLibraryModal } from './opening-library';
import { exportActiveOpening, exportAll } from './pgn-export';
import { getExplorerData, getExplorerCache } from './game';
import { analyzePosition, getBadgeForMove, type ParentContext } from './analysis';
import { formatScore } from './engine';
import type { EngineLine } from './engine';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';
import {
  getExplorerMode, setExplorerMode, hasPersonalData, getPersonalConfig,
  queryPersonalExplorer, clearPersonalData, importFromLichess, importFromChesscom,
  initPersonalExplorer, getPersonalStats, setPersonalFilters, getPersonalFilters,
  getFilteredGameCount,
  type ExplorerMode, type Platform, type LichessFilters,
} from './personal-explorer';

type ContinueCallback = () => void;
type OpeningChangeCallback = () => void;
type ModeChangeCallback = () => void;

type ConfigChangeCallback = (config: AppConfig) => void;
type NewGameCallback = () => void;
type FlipCallback = () => void;
type ExplorerMoveClickCallback = (uci: string) => void;

let configChangeCb: ConfigChangeCallback;
let newGameCb: NewGameCallback;
let flipCb: FlipCallback;
let explorerMoveClickCb: ExplorerMoveClickCallback | null = null;
let continueCb: ContinueCallback | null = null;
let openingChangeCb: OpeningChangeCallback | null = null;
let modeChangeCb: ModeChangeCallback | null = null;
let currentConfig: AppConfig;

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Track which UCI was played next from the currently viewed position
let nextMoveUci: string | null = null;

// Current engine eval as win% for the side to move (0-100), null if unavailable
let currentEvalWinPct: number | null = null;


export function initUI(
  config: AppConfig,
  onConfigChange: ConfigChangeCallback,
  onNewGame: NewGameCallback,
  onFlip: FlipCallback,
  onExplorerMoveClick?: ExplorerMoveClickCallback,
  onContinue?: ContinueCallback,
  onRepertoireChange?: OpeningChangeCallback,
  onModeChange?: ModeChangeCallback,
): void {
  currentConfig = { ...config };
  configChangeCb = onConfigChange;
  newGameCb = onNewGame;
  flipCb = onFlip;
  explorerMoveClickCb = onExplorerMoveClick ?? null;
  continueCb = onContinue ?? null;
  openingChangeCb = onRepertoireChange ?? null;
  modeChangeCb = onModeChange ?? null;

  initPersonalExplorer().then(() => {
    // Re-render explorer panel once DB is loaded, in case user is already in personal mode
    if (getExplorerMode() === 'personal') updateExplorerPanel();
  });
  renderSystemPicker();
  renderControls();
  renderConfigPanel();
  initHelpModal();
  initTooltips();
}

type PickerMode = 'normal' | 'rename' | 'confirm-delete' | 'merge-select' | 'merge-confirm';
let pickerMode: PickerMode = 'normal';
let mergeTarget: string | null = null;

export function renderSystemPicker(): void {
  const el = document.getElementById('system-picker')!;
  el.innerHTML = '';

  const active = getActiveOpening();
  const isFreePlay = active === FREE_PLAY_NAME;

  if (pickerMode === 'rename' && !isFreePlay) {
    renderRenameMode(el, active);
  } else {
    if (pickerMode !== 'merge-select' && pickerMode !== 'merge-confirm') {
      pickerMode = 'normal';
    }
    renderNormalMode(el, active, isFreePlay);
  }

  // Primary action buttons
  const primaryRow = document.createElement('div');
  primaryRow.className = 'repertoire-primary-row';

  const libraryBtn = document.createElement('button');
  libraryBtn.className = 'repertoire-action-btn';
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
  importBtn.className = 'repertoire-action-btn';
  importBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Import PGN';
  importBtn.setAttribute('data-tooltip', 'Import from PGN or Lichess study');
  importBtn.addEventListener('click', () => openPgnModal());

  primaryRow.append(libraryBtn, importBtn);

  // Secondary links
  const linkRow = document.createElement('div');
  linkRow.className = 'repertoire-btn-row';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'import-pgn-btn';
  exportBtn.textContent = 'Copy PGN';
  exportBtn.disabled = isFreePlay;
  exportBtn.addEventListener('click', () => {
    const pgn = exportActiveOpening();
    if (!pgn) return;
    navigator.clipboard.writeText(pgn).then(() => {
      const orig = exportBtn.textContent;
      exportBtn.textContent = 'Copied!';
      setTimeout(() => { exportBtn.textContent = orig; }, 1500);
    });
  });

  const exportAllBtn = document.createElement('button');
  exportAllBtn.className = 'import-pgn-btn';
  exportAllBtn.textContent = 'Export repertoire';
  exportAllBtn.addEventListener('click', () => downloadPgn(exportAll(), 'repertoire.pgn'));

  linkRow.append(exportBtn, exportAllBtn);

  el.append(primaryRow, linkRow);
}

const SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const SVG_EDIT = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const SVG_GLOBE = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const SVG_BOOK = '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>';

const SVG_LAYERS = '<svg viewBox="0 0 24 24"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z"/></svg>';
const SVG_MERGE = '<svg viewBox="0 0 24 24"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>';
const SVG_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

let deleteTarget: string | null = null;
let dropdownOpen = false;

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

  // ── Single dropdown card ──
  const wrapper = document.createElement('div');
  wrapper.className = 'system-dropdown-anchor';

  const card = document.createElement('div');
  card.className = 'system-card active';

  const activeIconType = isFreePlayActive ? 'free-play' : isFullRepActive ? 'full-rep' : 'custom';
  card.append(makeCardIcon(activeIconType));

  const nameEl = document.createElement('div');
  nameEl.className = 'system-card-name';
  nameEl.textContent = active;
  card.append(nameEl);

  // Actions: edit + delete (only when a custom opening is active)
  if (isCustomActive) {
    const actions = document.createElement('div');
    actions.className = 'system-card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'system-icon-btn';
    renameBtn.title = 'Rename';
    renameBtn.setAttribute('data-tooltip', 'Rename opening');
    renameBtn.innerHTML = SVG_EDIT;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownOpen = false;
      pickerMode = 'rename';
      renderSystemPicker();
    });

    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'system-icon-btn';
    mergeBtn.title = 'Merge';
    mergeBtn.setAttribute('data-tooltip', 'Combine two openings into one');
    mergeBtn.innerHTML = SVG_MERGE;
    const customCount = names.filter(n => n !== FREE_PLAY_NAME).length;
    if (customCount < 2) {
      mergeBtn.style.display = 'none';
      }
      mergeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pickerMode = 'merge-select';
        dropdownOpen = true;
        renderSystemPicker();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'system-icon-btn danger';
      deleteBtn.title = 'Delete';
      deleteBtn.setAttribute('data-tooltip', 'Delete opening');
      deleteBtn.innerHTML = SVG_TRASH;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownOpen = false;
        deleteTarget = active;
        renderSystemPicker();
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
            document.removeEventListener('click', onClickOutside, true);
            renderSystemPicker();
          }
        };
        document.addEventListener('click', onClickOutside, true);
      });

      const dropdown = document.createElement('div');
      dropdown.className = 'system-dropdown';

      if (pickerMode === 'merge-select') {
        // Merge-select: header + list of merge targets + cancel
        const header = document.createElement('div');
        header.className = 'system-dropdown-header';
        header.textContent = `Merge with…`;
        dropdown.append(header);

        const mergeTargets = customRepertoires.filter(n => n !== active);
        for (const name of mergeTargets) {
          const item = document.createElement('div');
          item.className = 'system-dropdown-item';

          item.append(makeCardIcon('custom'));

          const itemName = document.createElement('div');
          itemName.className = 'system-card-name';
          itemName.textContent = name;
          item.append(itemName);

          item.addEventListener('click', () => {
            mergeTarget = name;
            dropdownOpen = false;
            pickerMode = 'merge-confirm';
            renderSystemPicker();
          });
          dropdown.append(item);
        }

        const cancelItem = document.createElement('div');
        cancelItem.className = 'system-dropdown-item system-dropdown-cancel';
        cancelItem.innerHTML = `${SVG_CLOSE} <span class="system-card-name">Cancel</span>`;
        cancelItem.querySelector('svg')!.setAttribute('width', '14');
        cancelItem.querySelector('svg')!.setAttribute('height', '14');
        cancelItem.querySelector('svg')!.style.fill = 'currentColor';
        cancelItem.addEventListener('click', () => {
          dropdownOpen = false;
          mergeTarget = null;
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
            deleteTarget = null;
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
            deleteTarget = null;
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
            deleteTarget = null;
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

  // Confirm-delete banner
  if (deleteTarget) {
    const banner = document.createElement('div');
    banner.className = 'system-confirm-delete';
    const txt = document.createElement('span');
    txt.textContent = `Delete "${deleteTarget}"?`;

    const yesBtn = document.createElement('button');
    yesBtn.className = 'btn-confirm-yes';
    yesBtn.textContent = 'Delete';
    yesBtn.addEventListener('click', () => {
      deleteOpening(deleteTarget!);
      deleteTarget = null;
      pickerMode = 'normal';
      openingChangeCb?.();
      renderSystemPicker();
    });

    const noBtn = document.createElement('button');
    noBtn.className = 'btn-confirm-no';
    noBtn.textContent = 'Cancel';
    noBtn.addEventListener('click', () => {
      deleteTarget = null;
      renderSystemPicker();
    });

    banner.append(txt, yesBtn, noBtn);
    el.append(banner);
  }

  // Merge-confirm banner
  if (pickerMode === 'merge-confirm' && mergeTarget) {
    const banner = document.createElement('div');
    banner.className = 'system-confirm-merge';

    const txt = document.createElement('span');
    txt.textContent = `Merge "${active}" + "${mergeTarget}"`;
    banner.append(txt);

    const strategies: { strategy: MergeStrategy; label: string }[] = [
      { strategy: 'into-a', label: `Keep "${active}"` },
      { strategy: 'into-b', label: `Keep "${mergeTarget}"` },
      { strategy: 'as-new', label: 'New opening' },
    ];

    const btnGroup = document.createElement('div');
    btnGroup.className = 'merge-btn-group';
    for (const { strategy, label } of strategies) {
      const btn = document.createElement('button');
      btn.className = 'btn-confirm-yes merge';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        mergeOpenings(active, mergeTarget!, strategy);
        mergeTarget = null;
        pickerMode = 'normal';
        openingChangeCb?.();
        renderSystemPicker();
      });
      btnGroup.append(btn);
    }
    banner.append(btnGroup);

    const noBtn = document.createElement('button');
    noBtn.className = 'btn-confirm-no';
    noBtn.textContent = 'Cancel';
    noBtn.addEventListener('click', () => {
      mergeTarget = null;
      pickerMode = 'normal';
      renderSystemPicker();
    });
    banner.append(noBtn);

    el.append(banner);
  }

}

function renderRenameMode(el: HTMLElement, active: string): void {
  // Free play card (dimmed)
  const fpCard = document.createElement('div');
  fpCard.className = 'system-card';
  fpCard.style.opacity = '0.4';
  fpCard.style.pointerEvents = 'none';
  fpCard.append(makeCardIcon('free-play'));
  const fpName = document.createElement('div');
  fpName.className = 'system-card-name';
  fpName.textContent = FREE_PLAY_NAME;
  fpCard.append(fpName);
  el.append(fpCard);

  // Rename input row
  const row = document.createElement('div');
  row.className = 'system-rename-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'system-rename-input';
  input.value = active;
  input.placeholder = 'Opening name...';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'system-icon-btn';
  saveBtn.title = 'Save';
  saveBtn.innerHTML = SVG_CHECK;
  saveBtn.style.width = '32px';
  saveBtn.style.height = '32px';
  saveBtn.style.color = 'var(--opportunity)';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'system-icon-btn';
  cancelBtn.title = 'Cancel';
  cancelBtn.innerHTML = SVG_CLOSE;
  cancelBtn.style.width = '32px';
  cancelBtn.style.height = '32px';

  function save(): void {
    const newName = input.value.trim();
    if (newName && newName !== active) {
      renameOpening(active, newName);
      openingChangeCb?.();
    }
    pickerMode = 'normal';
    renderSystemPicker();
  }

  function cancel(): void {
    pickerMode = 'normal';
    renderSystemPicker();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  });

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', cancel);

  row.append(input, saveBtn, cancelBtn);
  el.append(row);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
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


function openDrawer(): void {
  const overlay = document.getElementById('settings-drawer-overlay')!;
  const drawer = document.getElementById('settings-drawer')!;
  overlay.classList.remove('hidden');
  drawer.classList.remove('hidden');
  // Trigger reflow for animation
  void drawer.offsetHeight;
  overlay.classList.add('visible');
  drawer.classList.add('visible');
}

function closeDrawer(): void {
  const overlay = document.getElementById('settings-drawer-overlay')!;
  const drawer = document.getElementById('settings-drawer')!;
  overlay.classList.remove('visible');
  drawer.classList.remove('visible');
  setTimeout(() => {
    overlay.classList.add('hidden');
    drawer.classList.add('hidden');
  }, 300);
}

let drawerInitialized = false;
function initDrawer(): void {
  if (drawerInitialized) return;
  drawerInitialized = true;
  document.getElementById('drawer-close')!.addEventListener('click', closeDrawer);
  document.getElementById('settings-drawer-overlay')!.addEventListener('click', closeDrawer);
}

function renderConfigPanel(): void {
  // ── Inline config (always visible in left sidebar) ──
  const inlineEl = document.getElementById('config-inline')!;
  inlineEl.innerHTML = '';

  // ── Indicators section ──
  const indicatorSection = document.createElement('div');
  indicatorSection.className = 'config-toggle-section';

  const indicatorHeader = document.createElement('div');
  indicatorHeader.className = 'config-toggle-header';
  indicatorHeader.innerHTML = `<span class="config-toggle-title">Display</span>`;

  const indicatorInfo = document.createElement('div');
  indicatorInfo.className = 'info-icon-wrap';
  indicatorInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const indicatorTooltip = document.createElement('div');
  indicatorTooltip.className = 'info-tooltip';
  indicatorTooltip.innerHTML =
    'Visual aids to help you understand positions.<br><br>' +
    '<b>Eval bar</b> — Stockfish evaluation shown as a vertical bar next to the board.<br>' +
    '<b>Move badges</b> — Marks on moves: <b>!</b> for best move, <b>?</b> for blunders, <b>?!</b> for traps.<br>' +
    '<b>Always show explorer</b> — Show explorer moves even during training (normally hidden until you click).';
  indicatorInfo.append(indicatorTooltip);
  indicatorHeader.append(indicatorInfo);

  const displayGrid = document.createElement('div');
  displayGrid.className = 'chip-grid';

  const evalChip = document.createElement('button');
  evalChip.id = 'eval-chip';
  evalChip.className = `chip${currentConfig.showEval ? ' selected' : ''}`;
  evalChip.textContent = 'Eval bar';
  evalChip.setAttribute('data-tooltip', 'Stockfish evaluation bar next to the board');
  evalChip.addEventListener('click', () => {
    const isOn = evalChip.classList.toggle('selected');
    currentConfig.showEval = isOn;
    configChangeCb(currentConfig);
  });

  const badgesChip = document.createElement('button');
  badgesChip.className = `chip${currentConfig.showMoveBadges ? ' selected' : ''}`;
  badgesChip.textContent = 'Move badges';
  badgesChip.setAttribute('data-tooltip', 'Mark best moves (!), mistakes (?), and traps (?!)');
  badgesChip.addEventListener('click', () => {
    const isOn = badgesChip.classList.toggle('selected');
    currentConfig.showMoveBadges = isOn;
    configChangeCb(currentConfig);
  });

  const explorerChip = document.createElement('button');
  explorerChip.className = `chip${currentConfig.showExplorer ? ' selected' : ''}`;
  explorerChip.textContent = 'Always show explorer';
  explorerChip.setAttribute('data-tooltip', 'Show explorer during bot play');
  explorerChip.addEventListener('click', () => {
    const isOn = explorerChip.classList.toggle('selected');
    currentConfig.showExplorer = isOn;
    configChangeCb(currentConfig);
  });

  const engineLinesChip = document.createElement('button');
  const elCount = currentConfig.engineLineCount;
  engineLinesChip.className = `chip${elCount > 0 ? ' selected' : ''}`;
  engineLinesChip.textContent = elCount > 0 ? `${elCount} engine line${elCount > 1 ? 's' : ''}` : 'Engine lines';
  engineLinesChip.setAttribute('data-tooltip', 'Cycle: off → 1 → 2 → 3 lines');
  engineLinesChip.addEventListener('click', () => {
    currentConfig.engineLineCount = currentConfig.engineLineCount >= 3 ? 0 : currentConfig.engineLineCount + 1;
    const n = currentConfig.engineLineCount;
    engineLinesChip.classList.toggle('selected', n > 0);
    engineLinesChip.textContent = n > 0 ? `${n} engine line${n > 1 ? 's' : ''}` : 'Engine lines';
    configChangeCb(currentConfig);
  });

  displayGrid.append(evalChip, badgesChip, explorerChip, engineLinesChip);
  indicatorSection.append(indicatorHeader, displayGrid);

  // ── Alerts section ──
  const alertSection = document.createElement('div');
  alertSection.className = 'config-toggle-section';

  const alertHeader = document.createElement('div');
  alertHeader.className = 'config-toggle-header';
  alertHeader.innerHTML = `<span class="config-toggle-title">Alerts</span>`;

  const alertInfo = document.createElement('div');
  alertInfo.className = 'info-icon-wrap';
  alertInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const alertTooltip = document.createElement('div');
  alertTooltip.className = 'info-tooltip';
  alertTooltip.innerHTML =
    'Warnings that appear on your turn at critical moments.<br><br>' +
    '<b>Danger</b> — Most moves lose ground here. Don\'t mess up!<br>' +
    '<b>Opportunity</b> — One move clearly outperforms the rest.<br>' +
    '<b>Trap</b> — A popular move is actually a mistake.';
  alertInfo.append(alertTooltip);
  alertHeader.append(alertInfo);

  const alertGrid = document.createElement('div');
  alertGrid.className = 'alert-toggle-grid';
  const alertTooltips: Record<string, string> = {
    danger: 'Warn when most moves lose ground',
    opportunity: 'Highlight when one move stands out',
    trap: 'Flag popular moves that are actually mistakes',
  };
  for (const meta of ALERT_META) {
    const chip = document.createElement('button');
    const isOn = currentConfig.enabledAlerts.includes(meta.type);
    chip.className = `alert-chip ${meta.cls}${isOn ? ' selected' : ''}`;
    chip.textContent = meta.label;
    chip.setAttribute('data-tooltip', alertTooltips[meta.type]);
    chip.addEventListener('click', () => {
      const wasOn = chip.classList.contains('selected');
      chip.classList.toggle('selected');
      if (wasOn) {
        currentConfig.enabledAlerts = currentConfig.enabledAlerts.filter(t => t !== meta.type);
      } else {
        if (!currentConfig.enabledAlerts.includes(meta.type)) {
          currentConfig.enabledAlerts.push(meta.type);
        }
      }
      configChangeCb(currentConfig);
    });
    alertGrid.append(chip);
  }
  alertSection.append(alertHeader, alertGrid);

  // Settings button to open drawer
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'settings-btn';
  settingsBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.61 3.61 0 0112 15.6z"/></svg> Settings';
  settingsBtn.addEventListener('click', () => {
    renderDrawerContent();
    openDrawer();
  });

  inlineEl.append(indicatorSection, alertSection, settingsBtn);

  // Wire up drawer close handlers (once)
  initDrawer();
}

function renderDrawerContent(): void {
  const el = document.getElementById('config-panel')!;
  el.innerHTML = '';

  // ── Explorer Settings ──
  const explorerHeader = document.createElement('h3');
  explorerHeader.className = 'config-section';
  explorerHeader.textContent = 'Explorer';
  explorerHeader.style.fontSize = '14px';
  explorerHeader.style.textTransform = 'uppercase';
  explorerHeader.style.letterSpacing = '0.06em';
  explorerHeader.style.color = 'var(--text-muted)';
  explorerHeader.style.marginBottom = '12px';
  el.append(explorerHeader);

  // Top moves
  const topNSection = document.createElement('div');
  topNSection.className = 'config-section';
  const topNHeader = document.createElement('div');
  topNHeader.className = 'config-toggle-header';
  const topNLabel = document.createElement('h3');
  topNLabel.textContent = `Top moves: ${currentConfig.topMoves}`;
  topNLabel.style.margin = '0';
  const topNInfo = document.createElement('div');
  topNInfo.className = 'info-icon-wrap';
  topNInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const topNTooltip = document.createElement('div');
  topNTooltip.className = 'info-tooltip';
  topNTooltip.textContent = 'Bot plays from this many of the most popular moves.';
  topNInfo.append(topNTooltip);
  topNHeader.append(topNLabel, topNInfo);
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
  topNSection.append(topNHeader, topNSlider);

  // Bot min play rate
  const playRateSection = document.createElement('div');
  playRateSection.className = 'config-section';
  const playRateHeader = document.createElement('div');
  playRateHeader.className = 'config-toggle-header';
  const playRateLabel = document.createElement('h3');
  playRateLabel.textContent = `Bot min play rate: ${currentConfig.botMinPlayRatePct}%`;
  playRateLabel.style.margin = '0';
  const playRateInfo = document.createElement('div');
  playRateInfo.className = 'info-icon-wrap';
  playRateInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const playRateTooltip = document.createElement('div');
  playRateTooltip.className = 'info-tooltip';
  playRateTooltip.textContent = 'Bot only plays moves above this popularity threshold.';
  playRateInfo.append(playRateTooltip);
  playRateHeader.append(playRateLabel, playRateInfo);
  const playRateSlider = document.createElement('input');
  playRateSlider.type = 'range';
  playRateSlider.min = '1';
  playRateSlider.max = '30';
  playRateSlider.value = String(currentConfig.botMinPlayRatePct);
  playRateSlider.addEventListener('input', () => {
    currentConfig.botMinPlayRatePct = parseInt(playRateSlider.value);
    playRateLabel.textContent = `Bot min play rate: ${currentConfig.botMinPlayRatePct}%`;
    configChangeCb(currentConfig);
  });
  playRateSection.append(playRateHeader, playRateSlider);

  // Bot move selection
  const weightingSection = document.createElement('div');
  weightingSection.className = 'config-section';
  const weightingHeader = document.createElement('div');
  weightingHeader.className = 'config-toggle-header';
  const weightingLabel = document.createElement('h3');
  weightingLabel.textContent = 'Bot move selection';
  weightingLabel.style.margin = '0';
  const weightingInfo = document.createElement('div');
  weightingInfo.className = 'info-icon-wrap';
  weightingInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const weightingTooltip = document.createElement('div');
  weightingTooltip.className = 'info-tooltip';
  weightingTooltip.innerHTML = '<b>Weighted</b> — more popular moves are more likely.<br><b>Equal</b> — all qualifying moves equally likely.';
  weightingInfo.append(weightingTooltip);
  weightingHeader.append(weightingLabel, weightingInfo);
  weightingSection.append(weightingHeader);

  const WEIGHTING_OPTIONS: { value: BotWeighting; label: string }[] = [
    { value: 'weighted', label: 'Weighted' },
    { value: 'equal', label: 'Equal' },
  ];

  const weightingSegment = document.createElement('div');
  weightingSegment.className = 'segment-picker';
  for (const opt of WEIGHTING_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = `segment-btn${currentConfig.botWeighting === opt.value ? ' selected' : ''}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      if (currentConfig.botWeighting === opt.value) return;
      currentConfig.botWeighting = opt.value;
      weightingSegment.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      configChangeCb(currentConfig);
    });
    weightingSegment.append(btn);
  }
  weightingSection.append(weightingSegment);

  // Ratings — chip grid
  const ratingsSection = document.createElement('div');
  ratingsSection.className = 'config-section';
  ratingsSection.innerHTML = '<h3>Ratings</h3>';
  const ratingsGrid = document.createElement('div');
  ratingsGrid.className = 'chip-grid';
  for (const rating of RATING_OPTIONS) {
    const chip = document.createElement('button');
    chip.className = `chip${currentConfig.ratings.includes(rating) ? ' selected' : ''}`;
    chip.textContent = String(rating);
    chip.addEventListener('click', () => {
      const isOn = chip.classList.toggle('selected');
      if (isOn) {
        if (!currentConfig.ratings.includes(rating)) {
          currentConfig.ratings.push(rating);
          currentConfig.ratings.sort((a, b) => a - b);
        }
      } else {
        currentConfig.ratings = currentConfig.ratings.filter((r) => r !== rating);
      }
      configChangeCb(currentConfig);
    });
    ratingsGrid.append(chip);
  }
  ratingsSection.append(ratingsGrid);

  // Speeds — chip grid
  const speedsSection = document.createElement('div');
  speedsSection.className = 'config-section';
  speedsSection.innerHTML = '<h3>Time Controls</h3>';
  const speedsGrid = document.createElement('div');
  speedsGrid.className = 'chip-grid';
  for (const speed of SPEED_OPTIONS) {
    const chip = document.createElement('button');
    chip.className = `chip${currentConfig.speeds.includes(speed) ? ' selected' : ''}`;
    chip.textContent = speed;
    chip.addEventListener('click', () => {
      const isOn = chip.classList.toggle('selected');
      if (isOn) {
        if (!currentConfig.speeds.includes(speed)) {
          currentConfig.speeds.push(speed);
        }
      } else {
        currentConfig.speeds = currentConfig.speeds.filter((s) => s !== speed);
      }
      configChangeCb(currentConfig);
    });
    speedsGrid.append(chip);
  }
  speedsSection.append(speedsGrid);

  el.append(topNSection, playRateSection, weightingSection, ratingsSection, speedsSection);

  // ── My Games ──
  if (hasPersonalData()) {
    const myGamesHeader = document.createElement('h3');
    myGamesHeader.className = 'config-section';
    myGamesHeader.textContent = 'My Games';
    myGamesHeader.style.fontSize = '14px';
    myGamesHeader.style.textTransform = 'uppercase';
    myGamesHeader.style.letterSpacing = '0.06em';
    myGamesHeader.style.color = 'var(--text-muted)';
    myGamesHeader.style.marginBottom = '12px';
    myGamesHeader.style.marginTop = '20px';
    el.append(myGamesHeader);

    const clearSection = document.createElement('div');
    clearSection.className = 'config-section';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-danger';
    clearBtn.textContent = 'Clear imported games';
    clearBtn.style.width = '100%';
    clearBtn.addEventListener('click', async () => {
      await clearPersonalData();
      personalFiltersOpen = false;
      updateExplorerPanel();
      renderDrawerContent();
    });
    clearSection.append(clearBtn);
    el.append(clearSection);
  }
}

export function updateStatus(phase: GamePhase, openingName?: string): void {
  const el = document.getElementById('status')!;
  let text = '';

  if (openingName) {
    text += `<div class="opening-name">${openingName}</div>`;
  }

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
  if (history.length > 0) {
    let repMoves = 0;
    for (let i = 0; i < history.length; i++) {
      const fenBefore = i === 0 ? STARTING_FEN : history[i - 1].fen;
      const locked = getLockedMoves(fenBefore);
      if (locked.length > 0 && locked.includes(history[i].uci)) {
        repMoves++;
      } else {
        break;
      }
    }
    if (repMoves > 0) {
      const pct = Math.round((repMoves / history.length) * 100);
      text += `<div class="rep-depth" data-tooltip="Consecutive moves matching your repertoire"><span class="rep-depth-bar" style="width:${pct}%"></span><span class="rep-depth-label">${repMoves}/${history.length} moves in opening</span></div>`;
    }
  }

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
  const parentData = cache.get(parentFen);
  if (!parentData || parentData.moves.length === 0) return undefined;
  const parentSide = parentFen.split(' ')[1] as 'w' | 'b';
  return { parentMoves: parentData.moves, playedUci, parentSide };
}

function historyBadge(moveIndex: number, history: { uci: string; fen: string }[]): string {
  const fenBefore = moveIndex === 0 ? STARTING_FEN : history[moveIndex - 1].fen;
  const cache = getExplorerCache();
  const explorerData = cache.get(fenBefore);
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
  let actionsHtml = '';
  if (isViewingHistory() && continueCb) {
    actionsHtml += '<button class="btn continue-btn">Continue from here</button>';
  }
  actionsHtml += '<button class="btn lock-line-btn" data-tooltip="Lock all moves up to here">Add to opening</button>';
  actionsHtml += '<button class="btn lock-line-new-btn" data-tooltip="Lock into a new opening">Add new opening</button>';
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
    openingChangeCb?.();
    updateExplorerPanel();
    updateMoveList();
  }

  actionsEl.querySelector('.lock-line-btn')!
    .addEventListener('click', () => lockLineToRepertoire(false));
  actionsEl.querySelector('.lock-line-new-btn')!
    .addEventListener('click', () => lockLineToRepertoire(true));

  el.scrollTop = el.scrollHeight;
}

export function setNextMoveUci(uci: string | null): void {
  nextMoveUci = uci;
}

export function setEvalWinPct(winPct: number | null): void {
  currentEvalWinPct = winPct;
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
  const el = document.getElementById('alert-banner')!;

  // Suppress alerts on the bot's turn (not relevant to the player)
  if (currentConfig.playerColor !== 'both') {
    const { fen } = getExplorerData();
    const sideToMove = fen.split(' ')[1];
    const isPlayerTurn =
      (currentConfig.playerColor === 'white' && sideToMove === 'w') ||
      (currentConfig.playerColor === 'black' && sideToMove === 'b');
    if (!isPlayerTurn) {
      el.innerHTML = '';
      setAutoShapes([]);
      return;
    }
  }

  const result = currentAnalysis();
  const alertType = result?.analysis.alert;
  if (!alertType || !result.analysis.bestMoveUci || !currentConfig.enabledAlerts.includes(alertType)) {
    el.innerHTML = '';
    setAutoShapes([]);
    return;
  }

  const info = alertLabels[alertType];
  const bestUci = result.analysis.bestMoveUci;
  el.innerHTML = `<div class="position-alert clickable ${info.cls}" data-tooltip="Click to show best move">${info.text}</div>`;

  // Clear any previous arrow when alert changes
  setAutoShapes([]);

  el.querySelector('.position-alert')!.addEventListener('click', () => {
    const orig = bestUci.slice(0, 2) as Key;
    const dest = bestUci.slice(2, 4) as Key;
    const brush = alertType === 'danger' ? 'red'
      : alertType === 'opportunity' ? 'yellow'
      : 'orange';
    setAutoShapes([{ orig, dest, brush }]);
  });
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

export function renderEngineLines(lines: EngineLine[], fen: string): void {
  const el = document.getElementById('engine-lines');
  if (!el) return;

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

  el.innerHTML = html;

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
}


let personalFiltersOpen = false;
let personalMatchBoard = true; // auto-filter color to match board orientation
let filterClickOutsideHandler: ((e: MouseEvent) => void) | null = null;

function renderPersonalInfoBar(el: HTMLElement): void {
  const cfg = getPersonalConfig();
  if (!cfg) return;

  const bar = document.createElement('div');
  bar.className = 'personal-info-bar';

  const text = document.createElement('span');
  text.className = 'personal-info-text';
  const platform = cfg.platform === 'lichess' ? 'lichess' : 'chess.com';
  const filtered = getFilteredGameCount();
  const total = cfg.gameCount;
  const countText = filtered < total
    ? `${formatGames(filtered)}/${formatGames(total)} games`
    : `${formatGames(total)} games`;
  text.innerHTML = `<span class="personal-username">${platform}: ${cfg.username}</span> &middot; ${countText}`;
  bar.append(text);

  const filterBtn = document.createElement('button');
  filterBtn.className = personalFiltersOpen ? 'active' : '';
  filterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>`;
  filterBtn.setAttribute('data-tooltip', 'Filter games');
  filterBtn.addEventListener('click', () => {
    personalFiltersOpen = !personalFiltersOpen;
    updateExplorerPanel();
  });
  bar.append(filterBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  refreshBtn.setAttribute('data-tooltip', 'Import new games');
  refreshBtn.addEventListener('click', () => openPersonalImportModal());
  bar.append(refreshBtn);

  el.append(bar);
}

function renderPersonalColorNote(el: HTMLElement): void {
  const orientation = getOrientation();
  const note = document.createElement('label');
  note.className = 'personal-color-note';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = personalMatchBoard;
  checkbox.addEventListener('change', () => {
    personalMatchBoard = checkbox.checked;
    updateExplorerPanel();
  });

  const text = document.createElement('span');
  text.textContent = personalMatchBoard
    ? `Showing games as ${orientation}`
    : 'Showing all games';

  note.append(checkbox, text);
  el.append(note);
}

function renderPersonalFilterPanel(el: HTMLElement): void {
  // Clean up previous click-outside handler
  if (filterClickOutsideHandler) {
    document.removeEventListener('mousedown', filterClickOutsideHandler);
    filterClickOutsideHandler = null;
  }

  if (!personalFiltersOpen) return;
  const stats = getPersonalStats();
  if (!stats) return;
  const filters = getPersonalFilters();

  const panel = document.createElement('div');
  panel.className = 'personal-filter-panel';

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
        applyFiltersFromPanel(panel);
      });
      chips.append(chip);
    }
    section.append(chips);
    panel.append(section);
  }

  // Rating range
  if (stats.minRating < stats.maxRating) {
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

    const applyRating = () => applyFiltersFromPanel(panel);
    minInput.addEventListener('change', applyRating);
    maxInput.addEventListener('change', applyRating);

    row.append(minInput, sep, maxInput);
    section.append(row);
    panel.append(section);
  }

  // Date range
  if (stats.months.length > 1) {
    const section = document.createElement('div');
    section.className = 'personal-filter-section';
    section.innerHTML = `<div class="personal-filter-label">Date range</div>`;

    // Quick presets
    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const threeAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const threeMonth = `${threeAgo.getFullYear()}-${String(threeAgo.getMonth() + 1).padStart(2, '0')}`;
    const yearStart = `${now.getFullYear()}-01`;

    const presets: { label: string; since: string; until: string }[] = [
      { label: 'This month', since: curMonth, until: curMonth },
      { label: 'Last 3 mo', since: threeMonth, until: curMonth },
      { label: 'This year', since: yearStart, until: curMonth },
    ];

    const presetRow = document.createElement('div');
    presetRow.className = 'chip-grid';
    for (const preset of presets) {
      const chip = document.createElement('button');
      chip.className = 'chip chip-sm';
      if (filters.sinceMonth === preset.since && filters.untilMonth === preset.until) {
        chip.classList.add('selected');
      }
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        const current = getPersonalFilters();
        // Toggle off if already selected
        if (current.sinceMonth === preset.since && current.untilMonth === preset.until) {
          setPersonalFilters({ ...current, sinceMonth: undefined, untilMonth: undefined });
        } else {
          setPersonalFilters({ ...current, sinceMonth: preset.since, untilMonth: preset.until });
        }
        refreshPersonalMoves();
        // Rebuild filter panel to update preset + picker state
        const wrap = panel.parentElement!;
        panel.remove();
        renderPersonalFilterPanel(wrap);
      });
      presetRow.append(chip);
    }
    section.append(presetRow);

    // Custom pickers
    const row = document.createElement('div');
    row.className = 'personal-filter-range';

    const minMonth = stats.months[0];
    const maxMonth = stats.months[stats.months.length - 1];
    const applyDate = () => applyFiltersFromPanel(panel);

    const sincePicker = createMonthPicker(
      'filter-since', filters.sinceMonth ?? '', minMonth, maxMonth, 'From…', applyDate,
    );
    const sep = document.createElement('span');
    sep.className = 'filter-range-sep';
    sep.textContent = '–';
    const untilPicker = createMonthPicker(
      'filter-until', filters.untilMonth ?? '', minMonth, maxMonth, 'To…', applyDate,
    );

    row.append(sincePicker, sep, untilPicker);
    section.append(row);
    panel.append(section);
  }

  // Reset button (color is managed by the board-matching checkbox, not here)
  const hasActiveFilters = (filters.timeClasses && filters.timeClasses.length > 0) ||
    filters.minRating != null || filters.maxRating != null ||
    filters.sinceMonth || filters.untilMonth;
  if (hasActiveFilters) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'personal-filter-reset';
    resetBtn.textContent = 'Reset filters';
    resetBtn.addEventListener('click', () => {
      setPersonalFilters({});
      updateExplorerPanel();
    });
    panel.append(resetBtn);
  }

  el.append(panel);

  // Close on click outside
  requestAnimationFrame(() => {
    filterClickOutsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.contains(target) && !(target as HTMLElement).closest?.('.personal-info-bar')) {
        personalFiltersOpen = false;
        document.removeEventListener('mousedown', filterClickOutsideHandler!);
        filterClickOutsideHandler = null;
        updateExplorerPanel();
      }
    };
    document.addEventListener('mousedown', filterClickOutsideHandler);
  });
}

function applyFiltersFromPanel(panel: HTMLElement): void {
  // Collect time class chips
  const allChips = panel.querySelectorAll('.chip[data-tc]');
  const selectedChips = panel.querySelectorAll('.chip[data-tc].selected');
  let timeClasses: string[] | undefined;
  if (selectedChips.length > 0 && selectedChips.length < allChips.length) {
    timeClasses = Array.from(selectedChips).map(c => (c as HTMLElement).dataset.tc!);
  }

  // Collect rating range
  const minEl = panel.querySelector('#filter-min-rating') as HTMLInputElement | null;
  const maxEl = panel.querySelector('#filter-max-rating') as HTMLInputElement | null;
  const minRating = minEl?.value ? parseInt(minEl.value) : undefined;
  const maxRating = maxEl?.value ? parseInt(maxEl.value) : undefined;

  // Collect date range (from custom month picker data attributes)
  const sinceEl = panel.querySelector('#filter-since') as HTMLElement | null;
  const untilEl = panel.querySelector('#filter-until') as HTMLElement | null;
  const sinceMonth = sinceEl?.dataset.value || undefined;
  const untilMonth = untilEl?.dataset.value || undefined;

  setPersonalFilters({ timeClasses, minRating, maxRating, sinceMonth, untilMonth });
  refreshPersonalMoves();
}

/** Refresh only the move rows + info text without rebuilding the filter panel */
function refreshPersonalMoves(): void {
  const el = document.getElementById('explorer-moves')!;
  const { fen } = getExplorerData();

  // Update info bar text
  const infoText = el.querySelector('.personal-info-text');
  if (infoText) {
    const cfg = getPersonalConfig();
    if (cfg) {
      const platform = cfg.platform === 'lichess' ? 'lichess' : 'chess.com';
      const filtered = getFilteredGameCount();
      const total = cfg.gameCount;
      const countText = filtered < total
        ? `${formatGames(filtered)}/${formatGames(total)} games`
        : `${formatGames(total)} games`;
      infoText.innerHTML = `<span class="personal-username">${platform}: ${cfg.username}</span> &middot; ${countText}`;
    }
  }

  // Remove old move rows, empty state, and color note
  el.querySelectorAll('.explorer-header, .explorer-list, .personal-empty-state, .personal-color-note').forEach(e => e.remove());

  const personalData = queryPersonalExplorer(fen);
  const moves = personalData?.moves ?? [];
  if (moves.length === 0) {
    const noData = document.createElement('div');
    noData.className = 'personal-empty-state';
    noData.style.padding = '16px';
    noData.textContent = 'No games in this position.';
    el.append(noData);
    renderPersonalColorNote(el);
    return;
  }

  renderMoveRows(moves, fen, null, el);
  renderPersonalColorNote(el);
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

  let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
  html += '<div class="explorer-list">';

  for (const move of visibleMoves) {
    const total = move.white + move.draws + move.black;
    const pct = totalAllMoves > 0 ? ((total / totalAllMoves) * 100).toFixed(1) : '0';
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

    html += `<div class="explorer-move${played}${lockedCls}" data-uci="${move.uci}">
      <span class="explorer-san">${move.san}</span>
      <span class="explorer-badge-col">${badgeHtml}</span>
      <span class="explorer-pct">${pct}%</span>
      <span class="explorer-games">${formatGames(total)}</span>
      <span class="explorer-bar">
        <span class="bar-white" style="width:${wPct}%">${wPct > 12 ? wPct + '%' : ''}</span>
        <span class="bar-draw" style="width:${dPct}%">${dPct > 8 ? dPct + '%' : ''}</span>
        <span class="bar-black" style="width:${bPct}%">${bPct > 12 ? bPct + '%' : ''}</span>
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
    html += '<div class="explorer-move empty-row">&nbsp;</div>';
  }

  html += '</div>';

  const container = document.createElement('div');
  container.innerHTML = html;
  while (container.firstChild) el.append(container.firstChild);

  wireExplorerRowEvents(el, fen);
}

function wireExplorerRowEvents(el: HTMLElement, fen: string): void {
  el.querySelectorAll('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const uci = target.dataset.uci!;
      const btnFen = decodeURIComponent(target.dataset.fen!);
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

export function updateExplorerPanel(): void {
  const el = document.getElementById('explorer-moves')!;
  el.innerHTML = '';

  const mode = getExplorerMode();
  const { fen } = getExplorerData();

  if (mode === 'personal') {
    if (!hasPersonalData()) {
      renderPersonalEmptyState(el);
      return;
    }

    // Auto-apply board orientation as color filter
    if (personalMatchBoard) {
      const orientation = getOrientation();
      const current = getPersonalFilters();
      if (current.color !== orientation) {
        setPersonalFilters({ ...current, color: orientation });
      }
    } else {
      const current = getPersonalFilters();
      if (current.color) {
        setPersonalFilters({ ...current, color: undefined });
      }
    }

    const infoWrap = document.createElement('div');
    infoWrap.className = 'personal-info-wrap';
    renderPersonalInfoBar(infoWrap);
    renderPersonalFilterPanel(infoWrap);
    el.append(infoWrap);

    const personalData = queryPersonalExplorer(fen);
    const moves = personalData?.moves ?? [];
    if (moves.length === 0) {
      const noData = document.createElement('div');
      noData.className = 'personal-empty-state';
      noData.style.padding = '16px';
      noData.textContent = 'No games in this position.';
      el.append(noData);
      renderPersonalColorNote(el);
      return;
    }

    // No analysis badges in personal mode
    renderMoveRows(moves, fen, null, el);
    renderPersonalColorNote(el);
    return;
  }

  // Database mode — original logic
  const showContent = shouldShowExplorerContent();
  const { data } = getExplorerData();
  const moves = data?.moves ?? [];

  if (!showContent) {
    let html = '<div class="explorer-header"><span>Move</span><span></span><span>%</span><span>Games</span><span>Results</span><span></span></div>';
    html += '<div class="explorer-list explorer-skeleton">';
    for (let i = 0; i < EXPLORER_ROWS; i++) {
      html += '<div class="explorer-move skeleton-row">&nbsp;</div>';
    }
    html += '<div class="explorer-hint">Click to show moves</div>';
    html += '</div>';
    const container = document.createElement('div');
    container.innerHTML = html;
    while (container.firstChild) el.append(container.firstChild);

    el.querySelector('.explorer-list')!.addEventListener('click', () => {
      explorerRevealed = true;
      updateExplorerPanel();
    });
    return;
  }

  const showBadges = currentConfig.showMoveBadges && moves.length > 0;
  const result = showBadges ? currentAnalysis() : null;
  const analysis = result?.analysis ?? null;

  renderMoveRows(moves, fen, analysis, el);
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

  document.getElementById('personal-import-btn')!.addEventListener('click', doPersonalImport);
  document.getElementById('personal-import-cancel')!.addEventListener('click', () => {
    importAbortController?.abort();
  });

  document.getElementById('personal-username')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doPersonalImport();
  });
}

function getSelectedSpeeds(): string[] {
  const chips = document.querySelectorAll('#personal-filters .chip.selected');
  return Array.from(chips).map(c => (c as HTMLElement).dataset.speed!);
}

function updateImportFiltersVisibility(): void {
  const filtersEl = document.getElementById('personal-filters')!;
  const noticeEl = document.getElementById('personal-chesscom-notice')!;
  if (selectedPlatform === 'lichess') {
    filtersEl.classList.remove('hidden');
    noticeEl.classList.add('hidden');
  } else {
    filtersEl.classList.add('hidden');
    noticeEl.classList.remove('hidden');
  }
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
    if (selectedPlatform === 'lichess') {
      const speeds = getSelectedSpeeds();
      const filters: LichessFilters = {};
      if (speeds.length > 0 && speeds.length < 4) {
        filters.perfType = speeds;
      }
      total = await importFromLichess(username, onProgress, importAbortController.signal, filters);
    } else {
      total = await importFromChesscom(username, onProgress, importAbortController.signal);
    }

    progressFill.classList.remove('indeterminate');
    progressFill.style.width = '100%';
    resultEl.textContent = `Imported ${formatGames(total)} games from ${selectedPlatform === 'lichess' ? 'Lichess' : 'Chess.com'}.`;
    resultEl.className = 'pgn-result success';

    switchSidebarTab('personal');
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
    showPopup(target, target.getAttribute('data-tooltip')!, false);
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
  const inlineEl = document.getElementById('config-inline')!;

  const helpBtn = document.createElement('button');
  helpBtn.className = 'help-btn';
  helpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg> Help & guide';
  helpBtn.addEventListener('click', openHelpModal);
  inlineEl.append(helpBtn);

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

let activeTab: 'database' | 'personal' | 'lines' = 'database';

export function initSidebarTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .sidebar-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab as 'database' | 'personal' | 'lines';
      if (id === activeTab) return;
      applySidebarTab(id);
    });
  });
}

function applySidebarTab(id: 'database' | 'personal' | 'lines'): void {
  activeTab = id;

  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .sidebar-tab');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === id));

  const isExplorer = id === 'database' || id === 'personal';
  document.getElementById('tab-explorer')!.classList.toggle('hidden', !isExplorer);
  document.getElementById('tab-lines')!.classList.toggle('hidden', id !== 'lines');

  if (isExplorer) {
    const mode = id === 'database' ? 'database' : 'personal';
    if (getExplorerMode() !== mode) {
      setExplorerMode(mode);
      modeChangeCb?.();
    }
    updateExplorerPanel();
  }

  if (id === 'lines') {
    tabChangeCallback?.();
  }
}

let tabChangeCallback: (() => void) | null = null;

export function onTabChange(cb: () => void): void {
  tabChangeCallback = cb;
}

export function getActiveTab(): 'database' | 'personal' | 'lines' {
  return activeTab;
}

export function switchSidebarTab(id: 'database' | 'personal' | 'lines'): void {
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
  const modalIds = ['settings-drawer', 'pgn-modal', 'help-modal', 'personal-import-modal', 'library-modal'];
  return modalIds.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

export { openHelpModal };
