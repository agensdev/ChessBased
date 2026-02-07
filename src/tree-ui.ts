import { buildRepertoireTree, type TreeNode } from './tree';
import { getActiveOpening, FREE_PLAY_NAME, FULL_REPERTOIRE_NAME } from './repertoire';

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

  if (getActiveOpening() === FREE_PLAY_NAME) {
    container.innerHTML = '<div class="tree-empty">Select an opening to see its lines.</div>';
    return;
  }

  const roots = buildRepertoireTree();
  if (roots.length === 0) {
    container.innerHTML = '<div class="tree-empty">No moves added yet. Add moves in the Explorer tab to build your opening.</div>';
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'tree-toolbar';
  toolbar.innerHTML = '<button class="btn tree-expand-all-btn">Expand all</button><button class="btn tree-collapse-all-btn">Collapse all</button>';
  container.append(toolbar);

  const list = document.createElement('div');
  list.className = 'tree-lines';
  renderLines(list, roots, 0, true);
  container.append(list);

  toolbar.querySelector('.tree-expand-all-btn')!.addEventListener('click', () => {
    list.querySelectorAll('.tree-children.collapsed').forEach(el => el.classList.remove('collapsed'));
    list.querySelectorAll('.tree-line.collapsed').forEach(el => el.classList.remove('collapsed'));
  });

  toolbar.querySelector('.tree-collapse-all-btn')!.addEventListener('click', () => {
    list.querySelectorAll('.tree-children').forEach(el => el.classList.add('collapsed'));
    list.querySelectorAll('.tree-line').forEach(el => {
      if (el.querySelector('.tree-toggle')) el.classList.add('collapsed');
    });
  });
}

function renderLines(container: HTMLElement, nodes: TreeNode[], depth: number, startCollapsed: boolean): void {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;

    const line = document.createElement('div');
    line.className = 'tree-line' + (hasChildren && startCollapsed ? ' collapsed' : '');
    line.style.paddingLeft = `${depth * 16}px`;

    if (hasChildren) {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle';
      toggle.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';
      line.append(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'tree-toggle-spacer';
      line.append(spacer);
    }

    const moveEl = document.createElement('span');
    moveEl.className = 'tree-move';
    const numStr = node.isBlack ? `${node.moveNumber}...` : `${node.moveNumber}.`;
    moveEl.textContent = `${numStr} ${node.san}`;
    moveEl.addEventListener('click', () => navigateCb?.(node.fen));
    line.append(moveEl);

    if (hasChildren) {
      const expandSub = document.createElement('span');
      expandSub.className = 'tree-expand-sub';
      expandSub.title = 'Expand subtree';
      expandSub.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M12 5.83L15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z"/></svg>';
      line.append(expandSub);
    }

    container.append(line);

    if (hasChildren) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'tree-children' + (startCollapsed ? ' collapsed' : '');
      renderLines(childrenEl, node.children, depth + 1, startCollapsed);
      container.append(childrenEl);

      line.querySelector('.tree-toggle')!.addEventListener('click', () => {
        const collapsed = childrenEl.classList.toggle('collapsed');
        line.classList.toggle('collapsed', collapsed);
      });

      line.querySelector('.tree-expand-sub')!.addEventListener('click', () => {
        line.classList.remove('collapsed');
        childrenEl.classList.remove('collapsed');
        childrenEl.querySelectorAll('.tree-children.collapsed').forEach(el => el.classList.remove('collapsed'));
        childrenEl.querySelectorAll('.tree-line.collapsed').forEach(el => el.classList.remove('collapsed'));
      });
    }
  }
}
