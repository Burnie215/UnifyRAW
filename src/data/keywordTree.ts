/**
 * Keyword hierarchy utilities.
 *
 * Keywords use "|" as hierarchy separator:
 *   "Tiere|Hund|Labrador" → Tiere > Hund > Labrador
 *
 * A photo tagged with "Tiere|Hund|Labrador" implicitly matches
 * searches for "Tiere" and "Tiere|Hund" (ancestor matching).
 */

export interface KeywordNode {
  name: string;       // leaf name ("Labrador")
  path: string;       // full path ("Tiere|Hund|Labrador")
  count: number;      // photos with this exact tag
  totalCount: number; // photos with this tag or any descendant
  children: KeywordNode[];
  expanded?: boolean;
}

export interface KeywordAggregation {
  keyword: string;
  count: number;
  photoIdentities: ReadonlySet<string>;
}

export const SEPARATOR = '|';

/**
 * Build a tree from a flat list of keywords with counts.
 */
export function buildKeywordTree(keywords: KeywordAggregation[]): KeywordNode[] {
  interface MutableKeywordNode {
    name: string;
    path: string;
    exactPhotoIdentities: Set<string>;
    totalPhotoIdentities: Set<string>;
    children: MutableKeywordNode[];
  }

  const root: MutableKeywordNode[] = [];

  for (const { keyword, photoIdentities } of keywords) {
    const parts = keyword.split(SEPARATOR);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join(SEPARATOR);
      let node = current.find((n) => n.name === parts[i]);

      if (!node) {
        node = {
          name: parts[i],
          path,
          exactPhotoIdentities: new Set(),
          totalPhotoIdentities: new Set(),
          children: [],
        };
        current.push(node);
      }

      if (i === parts.length - 1) {
        for (const identity of photoIdentities) node.exactPhotoIdentities.add(identity);
      }
      for (const identity of photoIdentities) node.totalPhotoIdentities.add(identity);
      current = node.children;
    }
  }

  const finalizeNodes = (nodes: MutableKeywordNode[]): KeywordNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return nodes.map((node) => ({
      name: node.name,
      path: node.path,
      count: node.exactPhotoIdentities.size,
      totalCount: node.totalPhotoIdentities.size,
      children: finalizeNodes(node.children),
    }));
  };

  return finalizeNodes(root);
}

/**
 * Get the display name (last segment) of a hierarchical keyword.
 */
export function getKeywordDisplayName(keyword: string): string {
  const parts = keyword.split(SEPARATOR);
  return parts[parts.length - 1];
}

/**
 * Get ancestor paths for a keyword.
 * "Tiere|Hund|Labrador" → ["Tiere", "Tiere|Hund"]
 */
export function getAncestors(keyword: string): string[] {
  const parts = keyword.split(SEPARATOR);
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join(SEPARATOR));
  }
  return ancestors;
}

/**
 * Check if a photo's keywords match a search keyword (including ancestors).
 */
export function matchesKeyword(photoKeywords: string[], search: string): boolean {
  return photoKeywords.some((k) => k === search || k.startsWith(search + SEPARATOR));
}

/**
 * Create a child keyword path.
 */
export function createChildPath(parent: string, child: string): string {
  return parent ? `${parent}${SEPARATOR}${child}` : child;
}

/**
 * Flatten a tree back to a sorted list of paths.
 */
export function flattenTree(nodes: KeywordNode[]): string[] {
  const result: string[] = [];
  const walk = (list: KeywordNode[]) => {
    for (const node of list) {
      result.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return result;
}
