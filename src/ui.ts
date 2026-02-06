import type {
  AppConfig,
  AlertThresholds,
  AlertType,
  BotWeighting,
  ExplorerResponse,
  GamePhase,
  MoveBadge,
  PlayerColor,
  PositionAnalysis,
} from './types';
import { ALL_ALERT_TYPES, DEFAULT_THRESHOLDS, RATING_OPTIONS, SPEED_OPTIONS } from './types';
import type { Key } from '@lichess-org/chessground/types';
import { getMoveHistory, getViewIndex, isViewingHistory, navigateTo, setAutoShapes } from './board';
import {
  isMoveLocked, lockMove, unlockMove, getLockedMoves,
  getRepertoireNames, getActiveRepertoire, switchRepertoire, createRepertoire, deleteRepertoire, renameRepertoire,
  FREE_PLAY_NAME,
} from './repertoire';
import { importPgn } from './pgn-import';
import { getExplorerData, getExplorerCache } from './game';
import { analyzePosition, getBadgeForMove, type ParentContext } from './analysis';

type ContinueCallback = () => void;
type RepertoireChangeCallback = () => void;

type ConfigChangeCallback = (config: AppConfig) => void;
type NewGameCallback = () => void;
type FlipCallback = () => void;
type ExplorerMoveClickCallback = (uci: string) => void;

let configChangeCb: ConfigChangeCallback;
let newGameCb: NewGameCallback;
let flipCb: FlipCallback;
let explorerMoveClickCb: ExplorerMoveClickCallback | null = null;
let continueCb: ContinueCallback | null = null;
let repertoireChangeCb: RepertoireChangeCallback | null = null;
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
  onRepertoireChange?: RepertoireChangeCallback,
): void {
  currentConfig = { ...config };
  configChangeCb = onConfigChange;
  newGameCb = onNewGame;
  flipCb = onFlip;
  explorerMoveClickCb = onExplorerMoveClick ?? null;
  continueCb = onContinue ?? null;
  repertoireChangeCb = onRepertoireChange ?? null;

  renderSystemPicker();
  renderControls();
  renderConfigPanel();
}

type PickerMode = 'normal' | 'rename' | 'confirm-delete';
let pickerMode: PickerMode = 'normal';

export function renderSystemPicker(): void {
  const el = document.getElementById('system-picker')!;
  el.innerHTML = '';

  const active = getActiveRepertoire();
  const isFreePlay = active === FREE_PLAY_NAME;

  if (pickerMode === 'rename' && !isFreePlay) {
    renderRenameMode(el, active);
  } else {
    pickerMode = 'normal';
    renderNormalMode(el, active, isFreePlay);
  }

  // Import PGN link
  const importBtn = document.createElement('button');
  importBtn.className = 'import-pgn-btn';
  importBtn.textContent = 'Import PGN';
  importBtn.addEventListener('click', () => openPgnModal());
  el.append(importBtn);
}

const SVG_CHECK = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const SVG_EDIT = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const SVG_PLUS = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const SVG_GLOBE = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const SVG_BOOK = '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>';

const SVG_CHEVRON = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

let deleteTarget: string | null = null;
let dropdownOpen = false;

function makeCardIcon(isFP: boolean): HTMLElement {
  const icon = document.createElement('div');
  icon.className = `system-card-icon ${isFP ? 'free-play' : 'custom'}`;
  icon.innerHTML = isFP ? SVG_GLOBE : SVG_BOOK;
  icon.querySelector('svg')!.setAttribute('width', '16');
  icon.querySelector('svg')!.setAttribute('height', '16');
  icon.querySelector('svg')!.style.fill = 'currentColor';
  return icon;
}

function renderNormalMode(el: HTMLElement, active: string, _isFreePlay: boolean): void {
  const names = getRepertoireNames();
  const customRepertoires = names.filter(n => n !== FREE_PLAY_NAME);
  const isFreePlayActive = active === FREE_PLAY_NAME;

  // ── Free Play card ──
  const fpCard = document.createElement('div');
  fpCard.className = `system-card${isFreePlayActive ? ' active' : ''}`;
  fpCard.append(makeCardIcon(true));

  const fpName = document.createElement('div');
  fpName.className = 'system-card-name';
  fpName.textContent = FREE_PLAY_NAME;
  fpCard.append(fpName);

  const fpCheck = document.createElement('div');
  fpCheck.className = 'system-card-check';
  fpCheck.innerHTML = SVG_CHECK;
  fpCard.append(fpCheck);

  if (!isFreePlayActive) {
    fpCard.addEventListener('click', () => {
      deleteTarget = null;
      dropdownOpen = false;
      switchRepertoire(FREE_PLAY_NAME);
      repertoireChangeCb?.();
      renderSystemPicker();
    });
  }
  el.append(fpCard);

  // ── Custom system card (with dropdown) ──
  {
    const isCustomActive = !isFreePlayActive;

    const wrapper = document.createElement('div');
    wrapper.className = 'system-dropdown-anchor';

    const card = document.createElement('div');
    card.className = `system-card${isCustomActive ? ' active' : ''}`;

    card.append(makeCardIcon(false));

    const nameEl = document.createElement('div');
    nameEl.className = 'system-card-name';
    nameEl.textContent = isCustomActive ? active : 'Repertoires';
    card.append(nameEl);

    // Actions: edit + delete (only when a custom system is active)
    if (isCustomActive) {
      const actions = document.createElement('div');
      actions.className = 'system-card-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'system-icon-btn';
      renameBtn.title = 'Rename';
      renameBtn.innerHTML = SVG_EDIT;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownOpen = false;
        pickerMode = 'rename';
        renderSystemPicker();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'system-icon-btn danger';
      deleteBtn.title = 'Delete';
      deleteBtn.innerHTML = SVG_TRASH;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownOpen = false;
        deleteTarget = active;
        renderSystemPicker();
      });

      actions.append(renameBtn, deleteBtn);
      card.append(actions);
    }

    // Dropdown chevron
    const chevron = document.createElement('div');
    chevron.className = `system-dropdown-chevron${dropdownOpen ? ' open' : ''}`;
    chevron.innerHTML = SVG_CHEVRON;
    card.append(chevron);

    card.addEventListener('click', () => {
      dropdownOpen = !dropdownOpen;
      renderSystemPicker();
    });

    wrapper.append(card);

    // Dropdown list
    if (dropdownOpen) {
      const dropdown = document.createElement('div');
      dropdown.className = 'system-dropdown';

      // "New repertoire" at the top
      const addItem = document.createElement('div');
      addItem.className = 'system-dropdown-item system-dropdown-add';
      addItem.innerHTML = `${SVG_PLUS} <span class="system-card-name">New repertoire</span>`;
      addItem.querySelector('svg')!.setAttribute('width', '16');
      addItem.querySelector('svg')!.setAttribute('height', '16');
      addItem.querySelector('svg')!.style.fill = 'currentColor';
      addItem.addEventListener('click', () => {
        dropdownOpen = false;
        createRepertoire();
        repertoireChangeCb?.();
        pickerMode = 'rename';
        renderSystemPicker();
      });
      dropdown.append(addItem);

      // Show all custom systems except the active one
      for (const name of customRepertoires) {
        if (name === active && isCustomActive) continue;
        const item = document.createElement('div');
        item.className = 'system-dropdown-item';

        const itemIcon = makeCardIcon(false);
        itemIcon.className = 'system-card-icon custom';
        item.append(itemIcon);

        const itemName = document.createElement('div');
        itemName.className = 'system-card-name';
        itemName.textContent = name;
        item.append(itemName);

        item.addEventListener('click', () => {
          deleteTarget = null;
          dropdownOpen = false;
          switchRepertoire(name);
          repertoireChangeCb?.();
          renderSystemPicker();
        });

        dropdown.append(item);
      }

      wrapper.append(dropdown);
    }

    el.append(wrapper);
  }

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
      deleteRepertoire(deleteTarget!);
      deleteTarget = null;
      pickerMode = 'normal';
      repertoireChangeCb?.();
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

}

function renderRenameMode(el: HTMLElement, active: string): void {
  // Free play card (dimmed)
  const fpCard = document.createElement('div');
  fpCard.className = 'system-card';
  fpCard.style.opacity = '0.4';
  fpCard.style.pointerEvents = 'none';
  fpCard.append(makeCardIcon(true));
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
  input.placeholder = 'Repertoire name...';

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
      renameRepertoire(active, newName);
      repertoireChangeCb?.();
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

  el.append(segment, flipBtn, newGameBtn);
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
  indicatorHeader.innerHTML = `<span class="config-toggle-title">Indicators</span>`;

  const indicatorInfo = document.createElement('div');
  indicatorInfo.className = 'info-icon-wrap';
  indicatorInfo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  const indicatorTooltip = document.createElement('div');
  indicatorTooltip.className = 'info-tooltip';
  indicatorTooltip.innerHTML =
    '<b>Eval bar</b> — Stockfish evaluation shown as a vertical bar next to the board.<br>' +
    '<b>Move badges</b> — Marks on moves: <b>!</b> for best move, <b>?</b> for blunders, <b>?!</b> for traps.';
  indicatorInfo.append(indicatorTooltip);
  indicatorHeader.append(indicatorInfo);

  const displayGrid = document.createElement('div');
  displayGrid.className = 'chip-grid';

  const evalChip = document.createElement('button');
  evalChip.className = `chip${currentConfig.showEval ? ' selected' : ''}`;
  evalChip.textContent = 'Eval bar';
  evalChip.addEventListener('click', () => {
    const isOn = evalChip.classList.toggle('selected');
    currentConfig.showEval = isOn;
    configChangeCb(currentConfig);
  });

  const badgesChip = document.createElement('button');
  badgesChip.className = `chip${currentConfig.showMoveBadges ? ' selected' : ''}`;
  badgesChip.textContent = 'Move badges';
  badgesChip.addEventListener('click', () => {
    const isOn = badgesChip.classList.toggle('selected');
    currentConfig.showMoveBadges = isOn;
    configChangeCb(currentConfig);
  });

  displayGrid.append(evalChip, badgesChip);
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
    '<b>Danger</b> — Most moves lose ground here. Don\'t mess up!<br>' +
    '<b>Opportunity</b> — One move clearly outperforms the rest.<br>' +
    '<b>Trap</b> — A popular move is actually a mistake.';
  alertInfo.append(alertTooltip);
  alertHeader.append(alertInfo);

  const alertGrid = document.createElement('div');
  alertGrid.className = 'alert-toggle-grid';
  for (const meta of ALERT_META) {
    const chip = document.createElement('button');
    const isOn = currentConfig.enabledAlerts.includes(meta.type);
    chip.className = `alert-chip ${meta.cls}${isOn ? ' selected' : ''}`;
    chip.textContent = meta.label;
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
  const topNLabel = document.createElement('h3');
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
  topNSection.append(topNLabel, topNSlider);

  // Bot min play rate
  const playRateSection = document.createElement('div');
  playRateSection.className = 'config-section';
  const playRateLabel = document.createElement('h3');
  playRateLabel.textContent = `Bot min play rate: ${currentConfig.botMinPlayRatePct}%`;
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
  playRateSection.append(playRateLabel, playRateSlider);

  // Bot move selection
  const weightingSection = document.createElement('div');
  weightingSection.className = 'config-section';
  const weightingLabel = document.createElement('h3');
  weightingLabel.textContent = 'Bot move selection';
  weightingSection.append(weightingLabel);

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

  // ── Alert Thresholds ──
  const thresholdsHeader = document.createElement('h3');
  thresholdsHeader.className = 'config-section';
  thresholdsHeader.textContent = 'Alert Thresholds';
  thresholdsHeader.style.fontSize = '14px';
  thresholdsHeader.style.textTransform = 'uppercase';
  thresholdsHeader.style.letterSpacing = '0.06em';
  thresholdsHeader.style.color = 'var(--text-muted)';
  thresholdsHeader.style.marginBottom = '12px';
  thresholdsHeader.style.marginTop = '8px';
  thresholdsHeader.style.paddingTop = '16px';
  thresholdsHeader.style.borderTop = '1px solid var(--border)';
  el.append(thresholdsHeader);

  const thresholds = currentConfig.alertThresholds;
  const sliders: { key: keyof AlertThresholds; label: string; min: number; max: number }[] = [
    { key: 'spreadThreshold', label: 'Spread threshold', min: 5, max: 25 },
    { key: 'comfortThreshold', label: 'Comfort win % (no eval fallback)', min: 45, max: 65 },
    { key: 'blunderDeficit', label: 'Blunder deficit', min: 5, max: 20 },
    { key: 'popularThresholdPct', label: 'Popular move %', min: 5, max: 30 },
    { key: 'minGames', label: 'Min games', min: 10, max: 200 },
  ];

  for (const s of sliders) {
    const sec = document.createElement('div');
    sec.className = 'config-section';
    const lbl = document.createElement('h3');
    lbl.textContent = `${s.label}: ${thresholds[s.key]}`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(s.min);
    slider.max = String(s.max);
    slider.value = String(thresholds[s.key]);
    slider.addEventListener('input', () => {
      thresholds[s.key] = parseInt(slider.value);
      lbl.textContent = `${s.label}: ${thresholds[s.key]}`;
      configChangeCb(currentConfig);
    });
    sec.append(lbl, slider);
    el.append(sec);
  }

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn';
  resetBtn.textContent = 'Reset to defaults';
  resetBtn.style.marginTop = '4px';
  resetBtn.addEventListener('click', () => {
    currentConfig.alertThresholds = { ...DEFAULT_THRESHOLDS };
    renderDrawerContent();
    configChangeCb(currentConfig);
  });
  el.append(resetBtn);
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
      text += '<span class="turn-indicator out-of-book">Out of book</span>';
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
      text += `<div class="rep-depth"><span class="rep-depth-bar" style="width:${pct}%"></span><span class="rep-depth-label">${repMoves}/${history.length} moves in repertoire</span></div>`;
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
  const analysis = analyzePosition(explorerData.moves, sideToMove, currentConfig.alertThresholds, parentContext);
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

  let html = '<div class="move-table">';
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
  actionsHtml += '<button class="btn lock-line-btn">Lock line</button>';
  actionsHtml += '<button class="btn lock-line-new-btn">Lock to new</button>';
  actionsEl.innerHTML = actionsHtml;

  const continueBtn = actionsEl.querySelector('.continue-btn');
  if (continueBtn && continueCb) {
    continueBtn.addEventListener('click', () => continueCb!());
  }

  function lockLineToRepertoire(forceNew: boolean): void {
    if (forceNew) {
      createRepertoire();
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
    repertoireChangeCb?.();
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

  const analysis = analyzePosition(moves, sideToMove, currentConfig.alertThresholds, parentContext, evalWinPct);
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
  el.innerHTML = `<div class="position-alert clickable ${info.cls}">${info.text}</div>`;

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

export function updateExplorerPanel(): void {
  const el = document.getElementById('explorer-moves')!;
  const showContent = shouldShowExplorerContent();

  const { data, fen } = getExplorerData();
  const moves = data?.moves ?? [];

  // Skeleton mode: always show the panel structure, but hide move content
  if (!showContent) {
    let html = '<div class="explorer-list explorer-skeleton">';
    for (let i = 0; i < EXPLORER_ROWS; i++) {
      html += '<div class="explorer-move skeleton-row">&nbsp;</div>';
    }
    html += '<div class="explorer-hint">Click to show moves</div>';
    html += '</div>';
    el.innerHTML = html;

    // Click anywhere on skeleton to reveal
    el.querySelector('.explorer-list')!.addEventListener('click', () => {
      explorerRevealed = true;
      updateExplorerPanel();
    });
    return;
  }

  const visibleMoves = moves.slice(0, EXPLORER_ROWS);

  const totalAllMoves = moves.reduce(
    (sum, m) => sum + m.white + m.draws + m.black,
    0,
  );

  // Run analysis for move badges
  const showBadges = currentConfig.showMoveBadges && moves.length > 0;
  const result = showBadges ? currentAnalysis() : null;
  const analysis = result?.analysis ?? null;

  let html = '<div class="explorer-list">';

  for (const move of visibleMoves) {
    const total = move.white + move.draws + move.black;
    const pct = totalAllMoves > 0 ? ((total / totalAllMoves) * 100).toFixed(1) : '0';
    const locked = isMoveLocked(fen, move.uci);
    const played = nextMoveUci === move.uci ? ' played' : '';
    const lockedCls = locked ? ' locked' : '';

    const wPct = total > 0 ? Math.round((move.white / total) * 100) : 0;
    const dPct = total > 0 ? Math.round((move.draws / total) * 100) : 0;
    const bPct = 100 - wPct - dPct;

    // Move badge
    const badge = analysis ? getBadgeForMove(analysis, move.uci) : null;
    const badgeHtml = badge && badge !== 'book' ? `<span class="move-badge badge-${badge.replace('_', '-')}">${badgeSymbol(badge)}</span>` : '';

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
              title="${locked ? 'Unlock this move' : 'Lock this move'}">
        ${locked
          ? '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg>'
        }
      </button>
    </div>`;
  }

  // Pad to fixed row count
  for (let i = visibleMoves.length; i < EXPLORER_ROWS; i++) {
    html += '<div class="explorer-move empty-row">&nbsp;</div>';
  }

  html += '</div>';
  el.innerHTML = html;

  el.querySelectorAll('.lock-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const uci = target.dataset.uci!;
      const fen = decodeURIComponent(target.dataset.fen!);
      if (isMoveLocked(fen, uci)) {
        unlockMove(fen, uci);
      } else {
        if (lockMove(fen, uci)) {
          renderSystemPicker();
          repertoireChangeCb?.();
        }
      }
      updateExplorerPanel();
    });
  });

  if (explorerMoveClickCb) {
    el.querySelectorAll('.explorer-move').forEach((row) => {
      row.addEventListener('click', (e) => {
        // Don't trigger if clicking the lock button
        if ((e.target as HTMLElement).closest('.lock-btn')) return;
        const uci = (row as HTMLElement).dataset.uci!;
        explorerMoveClickCb!(uci);
      });
    });
  }
}

function badgeSymbol(badge: MoveBadge): string {
  switch (badge) {
    case 'best': return '!';
    case 'blunder': return '?';
    case 'trap': return '?!';
    default: return '';
  }
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
}

function openPgnModal(): void {
  initPgnModal();
  const overlay = document.getElementById('pgn-modal-overlay')!;
  const modal = document.getElementById('pgn-modal')!;
  const textarea = document.getElementById('pgn-textarea') as HTMLTextAreaElement;
  const result = document.getElementById('pgn-result')!;

  textarea.value = '';
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

  let msg = `Imported ${result.moves} move${result.moves !== 1 ? 's' : ''} across ${result.positions} position${result.positions !== 1 ? 's' : ''}.`;
  if (result.errors.length > 0) {
    msg += ` (${result.errors.length} error${result.errors.length !== 1 ? 's' : ''} skipped)`;
  }
  resultEl.textContent = msg;
  resultEl.className = 'pgn-result success';

  // Refresh UI
  renderSystemPicker();
  updateExplorerPanel();
  updateMoveList();
  repertoireChangeCb?.();

  setTimeout(closePgnModal, 1500);
}

// ── Sidebar Tabs ──

let activeTab: 'explorer' | 'lines' = 'explorer';

export function initSidebarTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs .sidebar-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab as 'explorer' | 'lines';
      if (id === activeTab) return;
      activeTab = id;

      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === id));
      document.getElementById('tab-explorer')!.classList.toggle('hidden', id !== 'explorer');
      document.getElementById('tab-lines')!.classList.toggle('hidden', id !== 'lines');

      if (id === 'lines') {
        tabChangeCallback?.();
      }
    });
  });
}

let tabChangeCallback: (() => void) | null = null;

export function onTabChange(cb: () => void): void {
  tabChangeCallback = cb;
}

export function getActiveTab(): 'explorer' | 'lines' {
  return activeTab;
}
