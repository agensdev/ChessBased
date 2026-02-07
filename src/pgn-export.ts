import { buildTreeFromStore, type TreeNode } from './tree';
import { getOpeningNames, getOpeningStore, getActiveOpening, FREE_PLAY_NAME, FULL_REPERTOIRE_NAME } from './repertoire';

function treeToPgn(nodes: TreeNode[]): string {
  return renderNodes(nodes, true);
}

function renderNodes(nodes: TreeNode[], isMainline: boolean): string {
  if (nodes.length === 0) return '';

  const parts: string[] = [];
  const main = nodes[0];
  const variations = nodes.slice(1);

  // Main move
  parts.push(formatMove(main, isMainline));

  // Variations (in parentheses)
  for (const v of variations) {
    let varStr = formatMove(v, true);
    if (v.children.length > 0) {
      varStr += ' ' + renderNodes(v.children, true);
    }
    parts.push(`(${varStr})`);
  }

  // Continue mainline
  if (main.children.length > 0) {
    parts.push(renderNodes(main.children, true));
  }

  return parts.join(' ');
}

function formatMove(node: TreeNode, needsNumber: boolean): string {
  if (node.isBlack) {
    return needsNumber ? `${node.moveNumber}... ${node.san}` : node.san;
  }
  return `${node.moveNumber}. ${node.san}`;
}

export function exportOpening(name: string): string {
  const store = getOpeningStore(name);
  const tree = buildTreeFromStore(store);
  if (tree.length === 0) return '';

  const moves = treeToPgn(tree);
  return `[Event "${name}"]\n[Result "*"]\n\n${moves} *\n`;
}

export function exportActiveOpening(): string {
  const name = getActiveOpening();
  if (name === FREE_PLAY_NAME) return '';
  if (name === FULL_REPERTOIRE_NAME) return exportAll();
  return exportOpening(name);
}

export function exportAll(): string {
  const names = getOpeningNames().filter(n => n !== FREE_PLAY_NAME);
  return names.map(name => exportOpening(name)).filter(Boolean).join('\n');
}
