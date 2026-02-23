import { buildRepertoireTree, type TreeNode } from './tree';
import { getActiveOpening, FREE_PLAY_NAME, positionKey } from './repertoire';
import { showTreeModal } from './tree-ui';

export interface LineEntry {
  san: string;
  uci: string;
  fen: string;
}

type NavigateCallback = (fen: string, line: LineEntry[]) => void;

let navigateCb: NavigateCallback | null = null;
let selectedFen: string | null = null;

export function setSelectedFen(fen: string | null): void {
  selectedFen = fen;
}

export function renderHistoryTree(container: HTMLElement, onNavigate: NavigateCallback): void {
  navigateCb = onNavigate;
  refreshHistoryTree(container);
}

export function refreshHistoryTree(container: HTMLElement): void {
  container.innerHTML = '';
  container.onclick = null;

  if (getActiveOpening() === FREE_PLAY_NAME) {
    container.innerHTML = '<div class="tree-empty">Select an opening to see its lines.</div>';
    return;
  }

  const roots = buildRepertoireTree();
  if (roots.length === 0) {
    container.innerHTML = '<div class="tree-empty">No moves added yet. Add moves in the Explorer tab to build your opening.</div>';
    return;
  }

  const lineMap = new Map<TreeNode, LineEntry[]>();

  // Build trail: find the selected node and collect all ancestors
  const trailFens = new Set<string>();
  if (selectedFen) {
    const findTrail = (nodes: TreeNode[], ancestors: TreeNode[]): boolean => {
      for (const node of nodes) {
        if (positionKey(node.fen) === positionKey(selectedFen!)) {
          for (const a of ancestors) trailFens.add(positionKey(a.fen));
          trailFens.add(positionKey(node.fen));
          return true;
        }
        if (findTrail(node.children, [...ancestors, node])) return true;
      }
      return false;
    };
    findTrail(roots, []);
  }

  const buildLine = (node: TreeNode, parentLine: LineEntry[]): LineEntry[] => {
    const line = [...parentLine, { san: node.san, uci: node.uci, fen: node.fen }];
    lineMap.set(node, line);
    return line;
  };

  const moveSpan = (node: TreeNode, showNumber: boolean): string => {
    const pk = positionKey(node.fen);
    const isSelected = selectedFen && pk === positionKey(selectedFen);
    const isTrail = trailFens.has(pk);
    const cls = ['ht-move'];
    if (isSelected) cls.push('active');
    else if (isTrail) cls.push('trail');
    let text = '';
    if (showNumber) {
      text += `<span class="ht-num">${node.moveNumber}.${node.isBlack ? '..' : ''}</span>`;
    }
    text += escapeHtml(node.san);
    return `<span class="${cls.join(' ')}" data-node-fen="${escapeAttr(node.fen)}">${text}</span>`;
  };

  // Render a continuation inline (main line moves, no wrapping divs)
  const renderInline = (node: TreeNode, parentLine: LineEntry[], forceNumber: boolean): string => {
    const line = buildLine(node, parentLine);
    const parts: string[] = [];
    const needsNumber = forceNumber || !node.isBlack;
    parts.push(moveSpan(node, needsNumber));

    if (node.children.length === 0) {
      // leaf
    } else if (node.children.length === 1) {
      parts.push(renderInline(node.children[0], line, false));
    } else {
      // Branch: sidelines become indented blocks, main line continues inline
      const main = node.children[0];
      const sidelines = node.children.slice(1);

      for (const side of sidelines) {
        parts.push(renderVariationBlock(side, line));
      }

      parts.push(renderInline(main, line, true));
    }

    return parts.join(' ');
  };

  // Render a sideline as an indented block
  const renderVariationBlock = (node: TreeNode, parentLine: LineEntry[]): string => {
    const inner = renderInline(node, parentLine, true);
    return `<div class="ht-variation">${inner}</div>`;
  };

  // Build full output
  let html = '<button type="button" class="btn sm ht-tree-btn">Tree View</button>';
  html += '<div class="ht-pgn">';
  if (roots.length === 1) {
    html += renderInline(roots[0], [], true);
  } else {
    html += renderInline(roots[0], [], true);
    for (let i = 1; i < roots.length; i++) {
      html += renderVariationBlock(roots[i], []);
    }
  }
  html += '</div>';

  container.innerHTML = html;

  container.onclick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (target.closest('.ht-tree-btn')) {
      showTreeModal();
      return;
    }

    const moveEl = target.closest('[data-node-fen]') as HTMLElement | null;
    if (!moveEl) return;

    const fen = moveEl.dataset.nodeFen;
    if (!fen) return;

    selectedFen = fen;
    refreshHistoryTree(container);

    const pk = positionKey(fen);
    for (const [node, line] of lineMap) {
      if (positionKey(node.fen) === pk) {
        navigateCb?.(fen, line);
        return;
      }
    }
    navigateCb?.(fen, []);
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}
