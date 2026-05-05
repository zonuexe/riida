// Shelf query <-> structured-condition adapters.
//
// The Shelf editor exposes two structured modes (All / Any) on top of
// the same canonical raw-query string defined in ADR-02. This module
// converts between them so the structured editor can be a thin view
// on top of the raw query without persisting parallel state.

import { type AstNode, parseSearchQueryAstSafe } from "./search-query-ast.ts";

export type ShelfFieldKey =
  | "title"
  | "author"
  | "publisher"
  | "tag"
  | "lang"
  | "file"
  | "path"
  | "source"
  | "free";

export type ShelfMode = "all" | "any" | "custom";

export type ShelfCondition = {
  field: ShelfFieldKey;
  negate: boolean;
  value: string;
};

const STRUCTURED_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "author",
  "publisher",
  "tag",
  "lang",
  "file",
  "path",
  "source",
]);

function quoteIfNeeded(value: string): string {
  if (value.length === 0) return '""';
  if (/[\s()"]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function renderCondition(c: ShelfCondition): string {
  const prefix = c.negate ? "-" : "";
  if (c.field === "free") {
    return `${prefix}${quoteIfNeeded(c.value)}`;
  }
  return `${prefix}${c.field}:${quoteIfNeeded(c.value)}`;
}

/**
 * Build a canonical raw-query string from a structured editor state.
 * Empty input yields the empty string.
 */
export function composeShelfQuery(mode: ShelfMode, rows: ShelfCondition[]): string {
  const usable = rows.filter((row) => row.value.trim().length > 0);
  if (usable.length === 0) return "";
  if (usable.length === 1) {
    return renderCondition(usable[0]!);
  }
  const joiner = mode === "any" ? " OR " : " AND ";
  return usable.map(renderCondition).join(joiner);
}

function leafToCondition(leaf: AstNode, negate: boolean): ShelfCondition | null {
  if (leaf.kind === "field") {
    if (!STRUCTURED_FIELDS.has(leaf.field)) return null;
    return { field: leaf.field as ShelfFieldKey, negate, value: leaf.value };
  }
  if (leaf.kind === "free") {
    return { field: "free", negate, value: leaf.value };
  }
  return null;
}

function nodeToCondition(node: AstNode): ShelfCondition | null {
  if (node.kind === "not") {
    const inner = node.child;
    if (inner.kind === "field" || inner.kind === "free") {
      return leafToCondition(inner, true);
    }
    return null;
  }
  if (node.kind === "field" || node.kind === "free") {
    return leafToCondition(node, false);
  }
  return null;
}

/**
 * Try to interpret a raw query as a flat AND or OR of simple terms,
 * each of which is a known field or free-text leaf, optionally
 * negated. Returns null when the query is too complex (nested groups,
 * unknown fields, mixed AND/OR, etc.) and the editor should fall back
 * to Custom mode.
 */
export function decomposeShelfQuery(
  raw: string,
): { mode: "all" | "any"; rows: ShelfCondition[] } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { mode: "all", rows: [] };
  }
  let ast: AstNode;
  try {
    ast = parseSearchQueryAstSafe(trimmed);
  } catch {
    return null;
  }

  if (ast.kind === "and" && ast.children.length === 0) {
    return { mode: "all", rows: [] };
  }

  // Single leaf or single negated leaf — treat as single-row All.
  const single = nodeToCondition(ast);
  if (single) {
    return { mode: "all", rows: [single] };
  }

  if (ast.kind === "and" || ast.kind === "or") {
    const rows: ShelfCondition[] = [];
    for (const child of ast.children) {
      const c = nodeToCondition(child);
      if (!c) return null;
      rows.push(c);
    }
    return { mode: ast.kind === "or" ? "any" : "all", rows };
  }

  return null;
}
