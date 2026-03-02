import type { GamePhase } from './types';

const STORAGE_KEY = 'chessbased-onboarding';

type Milestone =
  | 'hasSeenWelcome'
  | 'firstMove'
  | 'evalBarLabel'
  | 'botExplained'
  | 'explorerExplained'
  | 'lockHint'
  | 'firstLockToast'
  | 'gameRecap';

interface OnboardingState {
  milestones: Partial<Record<Milestone, boolean>>;
}

let state: OnboardingState = { milestones: {} };
let firstVisit = false;
let moveCount = 0;
let activeHintEl: HTMLElement | null = null;
let activeToastEl: HTMLElement | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;
let lastPhase: GamePhase = 'USER_TURN';

function load(): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      state = JSON.parse(raw);
    } catch {
      state = { milestones: {} };
    }
  }
}

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function initOnboarding(): void {
  const existed = localStorage.getItem(STORAGE_KEY) !== null;
  load();
  firstVisit = !existed;
  if (!existed) save();
  moveCount = 0;
}

export function isFirstVisit(): boolean {
  return firstVisit;
}

export function hasMilestone(name: Milestone): boolean {
  return !!state.milestones[name];
}

export function markMilestone(name: Milestone): void {
  if (state.milestones[name]) return;
  state.milestones[name] = true;
  save();
}

export function dismissHint(): void {
  if (hintTimer) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  if (activeHintEl) {
    activeHintEl.remove();
    activeHintEl = null;
  }
}

export function showHint(
  milestone: Milestone,
  targetSelector: string,
  text: string,
  options?: { autoDismissMs?: number; placement?: 'above' | 'below' | 'right' | 'left' },
): void {
  if (hasMilestone(milestone)) return;
  markMilestone(milestone);
  dismissHint();

  const target = document.querySelector(targetSelector);
  if (!target) return;

  const hint = document.createElement('div');
  hint.className = 'onboarding-hint';
  hint.textContent = text;

  const dismiss = document.createElement('button');
  dismiss.className = 'onboarding-hint-dismiss';
  dismiss.textContent = '\u00d7';
  dismiss.addEventListener('click', () => dismissHint());
  hint.appendChild(dismiss);

  document.body.appendChild(hint);
  activeHintEl = hint;

  // Position relative to target
  const rect = target.getBoundingClientRect();
  const placement = options?.placement ?? 'below';

  requestAnimationFrame(() => {
    const hintRect = hint.getBoundingClientRect();
    let top: number;
    let left: number;

    switch (placement) {
      case 'above':
        top = rect.top - hintRect.height - 8;
        left = rect.left + rect.width / 2 - hintRect.width / 2;
        break;
      case 'below':
        top = rect.bottom + 8;
        left = rect.left + rect.width / 2 - hintRect.width / 2;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - hintRect.height / 2;
        left = rect.right + 8;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - hintRect.height / 2;
        left = rect.left - hintRect.width - 8;
        break;
    }

    // Clamp to viewport
    left = Math.max(8, Math.min(left, window.innerWidth - hintRect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - hintRect.height - 8));

    hint.style.top = `${top}px`;
    hint.style.left = `${left}px`;
  });

  if (options?.autoDismissMs) {
    hintTimer = setTimeout(() => dismissHint(), options.autoDismissMs);
  }
}

export function showToast(text: string, duration = 4000): void {
  if (activeToastEl) {
    activeToastEl.remove();
    activeToastEl = null;
  }

  const toast = document.createElement('div');
  toast.className = 'onboarding-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  activeToastEl = toast;

  setTimeout(() => {
    toast.classList.add('onboarding-toast-leave');
    toast.addEventListener('animationend', () => {
      toast.remove();
      if (activeToastEl === toast) activeToastEl = null;
    });
  }, duration);
}

export function showGameRecap(moveCount: number): void {
  if (hasMilestone('gameRecap')) return;
  markMilestone('gameRecap');

  const el = document.getElementById('alert-banner');
  if (!el) return;

  el.innerHTML = '';
  const recap = document.createElement('div');
  recap.className = 'onboarding-recap';
  recap.innerHTML = `You played <strong>${moveCount}</strong> moves of theory. Press <kbd>N</kbd> or <kbd>Space</kbd> for a new game.`;
  el.appendChild(recap);
}

export function dismissRecap(): void {
  const el = document.getElementById('alert-banner');
  if (el) {
    const recap = el.querySelector('.onboarding-recap');
    if (recap) recap.remove();
  }
}

// ── Callbacks for main.ts ──

export function onPhaseChangeForOnboarding(phase: GamePhase): void {
  // Detect bot move completion: BOT_THINKING → USER_TURN
  if (phase === 'USER_TURN' && lastPhase === 'BOT_THINKING') {
    onBotMoveForOnboarding();
  }

  if (phase === 'OUT_OF_BOOK' || phase === 'GAME_OVER') {
    if (!hasMilestone('gameRecap') && moveCount >= 2) {
      showGameRecap(moveCount);
    }
  }

  lastPhase = phase;
}

export function onUserMoveForOnboarding(): void {
  moveCount++;

  if (!hasMilestone('firstMove')) {
    dismissHint();
    markMilestone('firstMove');
  }

  if (moveCount >= 3 && !hasMilestone('explorerExplained')) {
    showHint(
      'explorerExplained',
      '#explorer-moves',
      'These are the most popular moves from millions of real games',
      { placement: 'above', autoDismissMs: 5000 },
    );
  }

  if (moveCount >= 5 && !hasMilestone('lockHint')) {
    showHint(
      'lockHint',
      '.lock-btn',
      'Like this line? Lock moves to build your repertoire',
      { placement: 'left', autoDismissMs: 6000 },
    );
  }
}

function onBotMoveForOnboarding(): void {
  if (!hasMilestone('botExplained')) {
    showHint(
      'botExplained',
      '#explorer-moves',
      'The bot played what real players at your rating actually play',
      { autoDismissMs: 4000 },
    );
  }
}

export function onNewGameForOnboarding(): void {
  moveCount = 0;
  dismissHint();
  dismissRecap();
}

export function onLockMoveForOnboarding(): void {
  if (!hasMilestone('firstLockToast')) {
    markMilestone('firstLockToast');
    showToast('Move locked! New repertoire created \u2014 the bot will play into this line', 5000);
  }
  if (!hasMilestone('lockHint')) {
    markMilestone('lockHint');
    dismissHint();
  }
}

export function showFirstVisitHints(): void {
  if (!hasMilestone('firstMove')) {
    showHint(
      'firstMove',
      '#board',
      'Play your opening move \u2014 the bot responds like a real opponent',
      { placement: 'below' },
    );
  }
}

export function onEvalBarVisibleForOnboarding(): void {
  if (!hasMilestone('evalBarLabel')) {
    showHint(
      'evalBarLabel',
      '#eval-bar',
      'Engine evaluation \u2014 shows who\'s winning',
      { placement: 'right', autoDismissMs: 4000 },
    );
  }
}
