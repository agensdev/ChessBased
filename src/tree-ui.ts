import { buildRepertoireTree, type TreeNode } from './tree';
import { getActiveRepertoire, FREE_PLAY_NAME } from './repertoire';

type NavigateCallback = (fen: string) => void;

let navigateCb: NavigateCallback | null = null;

export function renderTreePanel(container: HTMLElement, onNavigate: NavigateCallback): void {
  navigateCb = onNavigate;
  refresh(container);
}

export function refreshTree(container: HTMLElement): void {
  refresh(container);
}

function refresh(container: HTMLElement): void {
  container.innerHTML = '';

  if (getActiveRepertoire() === FREE_PLAY_NAME) {
    container.innerHTML = '<div class="tree-empty">Select a repertoire to see its lines.</div>';
    return;
  }

  const roots = buildRepertoireTree();
  if (roots.length === 0) {
    container.innerHTML = '<div class="tree-empty">No moves locked yet. Lock moves in the Explorer tab to build your repertoire.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'tree-lines';
  renderLines(list, roots, 0);
  container.append(list);
}

function renderLines(container: HTMLElement, nodes: TreeNode[], depth: number): void {
  for (const node of nodes) {
    const line = document.createElement('div');
    line.className = 'tree-line';
    line.style.paddingLeft = `${depth * 16}px`;

    const moveEl = document.createElement('span');
    moveEl.className = 'tree-move';

    const numStr = node.isBlack ? `${node.moveNumber}...` : `${node.moveNumber}.`;
    moveEl.textContent = `${numStr} ${node.san}`;

    moveEl.addEventListener('click', () => {
      navigateCb?.(node.fen);
    });

    line.append(moveEl);
    container.append(line);

    if (node.children.length > 0) {
      renderLines(container, node.children, depth + 1);
    }
  }
}
