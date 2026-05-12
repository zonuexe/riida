// Search query AST parser and evaluator.
//
// Grammar (see docs/ADR-02_shelves.md):
//
//   expr   := or
//   or     := and ( "OR" and )*
//   and    := unary ( ( "AND" | implicit ) unary )*
//   unary  := ( "NOT" | "-" ) atom | atom
//   atom   := "(" expr ")" | field_token | quoted | bareword
//
// AND, OR, NOT are reserved only in uppercase. Lowercase variants
// ("and", "or", "not") remain free-text barewords for backwards
// compatibility with ADR-01 queries.

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "author",
  "publisher",
  "tag",
  "lang",
  "file",
  "path",
  "source",
  "read",
  // Gmail-style time operators. Bare forms target last_read_at; the
  // `added_*` variants target indexed_at. See docs/ADR-03_time-based-search.md.
  "newer_than",
  "older_than",
  "after",
  "before",
  "newer",
  "older",
  "added_newer_than",
  "added_older_than",
  "added_after",
  "added_before",
  "added_newer",
  "added_older",
]);

export type LeafNode =
  | { kind: "field"; field: string; value: string }
  | { kind: "free"; value: string };

export type AstNode =
  | { kind: "and"; children: AstNode[] }
  | { kind: "or"; children: AstNode[] }
  | { kind: "not"; child: AstNode }
  | LeafNode;

type Tok =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "and" }
  | { kind: "or" }
  | { kind: "not" }
  | { kind: "minus" }
  | { kind: "atom"; raw: string };

function tokenize(raw: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === " " || c === "\t" || c === "\n") {
      i += 1;
      continue;
    }
    if (c === "(") {
      toks.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      toks.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    // Standalone leading "-" (NOT shortcut). Must be immediately followed
    // by an atom or paren — i.e. not by whitespace, ")", or end of input.
    if (c === "-") {
      const next = raw[i + 1];
      if (next !== undefined && next !== " " && next !== "\t" && next !== "\n" && next !== ")") {
        toks.push({ kind: "minus" });
        i += 1;
        continue;
      }
    }

    // Read an atom. Quoted segments contribute their inner text without
    // surrounding quotes, and parens / whitespace inside quotes are
    // treated as literal characters.
    let buf = "";
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "(" || ch === ")") {
        break;
      }
      if (ch === '"') {
        i += 1;
        while (i < raw.length && raw[i] !== '"') {
          buf += raw[i];
          i += 1;
        }
        if (i < raw.length) i += 1; // consume closing quote
        continue;
      }
      if (ch === "\\" && i + 1 < raw.length) {
        buf += raw[i + 1];
        i += 2;
        continue;
      }
      buf += ch;
      i += 1;
    }

    if (buf.length === 0) {
      continue;
    }

    if (buf === "AND") toks.push({ kind: "and" });
    else if (buf === "OR") toks.push({ kind: "or" });
    else if (buf === "NOT") toks.push({ kind: "not" });
    else toks.push({ kind: "atom", raw: buf });
  }
  return toks;
}

type Cursor = { pos: number };

function parseOr(toks: Tok[], cursor: Cursor): AstNode {
  const first = parseAnd(toks, cursor);
  const children: AstNode[] = [first];
  while (cursor.pos < toks.length && toks[cursor.pos]?.kind === "or") {
    cursor.pos += 1;
    children.push(parseAnd(toks, cursor));
  }
  if (children.length === 1) return first;
  return { kind: "or", children };
}

function parseAnd(toks: Tok[], cursor: Cursor): AstNode {
  const first = parseUnary(toks, cursor);
  const children: AstNode[] = [first];
  while (cursor.pos < toks.length) {
    const t = toks[cursor.pos];
    if (!t) break;
    if (t.kind === "or" || t.kind === "rparen") break;
    if (t.kind === "and") {
      cursor.pos += 1;
      children.push(parseUnary(toks, cursor));
      continue;
    }
    // Implicit AND between adjacent operands.
    children.push(parseUnary(toks, cursor));
  }
  if (children.length === 1) return first;
  return { kind: "and", children };
}

function parseUnary(toks: Tok[], cursor: Cursor): AstNode {
  const t = toks[cursor.pos];
  if (t?.kind === "not" || t?.kind === "minus") {
    cursor.pos += 1;
    const child = parseAtom(toks, cursor);
    return { kind: "not", child };
  }
  return parseAtom(toks, cursor);
}

function parseAtom(toks: Tok[], cursor: Cursor): AstNode {
  const t = toks[cursor.pos];
  if (!t) {
    throw new SyntaxError("Unexpected end of query");
  }
  if (t.kind === "lparen") {
    cursor.pos += 1;
    const inner = parseOr(toks, cursor);
    const closing = toks[cursor.pos];
    if (closing?.kind !== "rparen") {
      throw new SyntaxError("Missing closing parenthesis");
    }
    cursor.pos += 1;
    return inner;
  }
  if (t.kind === "atom") {
    cursor.pos += 1;
    const raw = t.raw;
    const colon = raw.indexOf(":");
    if (colon > 0) {
      const field = raw.slice(0, colon).toLowerCase();
      const value = raw.slice(colon + 1);
      if (KNOWN_FIELDS.has(field) && value.length > 0) {
        return { kind: "field", field, value };
      }
    }
    return { kind: "free", value: raw };
  }
  throw new SyntaxError(`Unexpected token: ${t.kind}`);
}

const ALWAYS_TRUE: AstNode = { kind: "and", children: [] };

/**
 * Parse a query string into an AST. Empty input produces an
 * always-true AST (`and` with no children).
 *
 * Throws `SyntaxError` on malformed input (unclosed paren, dangling
 * operator, etc.). Callers that need graceful behaviour should use
 * {@link parseSearchQueryAstSafe} instead.
 */
export function parseSearchQueryAst(raw: string): AstNode {
  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    return ALWAYS_TRUE;
  }
  const cursor: Cursor = { pos: 0 };
  const ast = parseOr(tokens, cursor);
  if (cursor.pos < tokens.length) {
    throw new SyntaxError(`Unexpected token at position ${cursor.pos}`);
  }
  return ast;
}

/**
 * Like {@link parseSearchQueryAst} but never throws. On parse failure
 * the entire input is treated as a single free-text token, preserving
 * legacy behaviour where any string was a valid (best-effort) query.
 */
export function parseSearchQueryAstSafe(raw: string): AstNode {
  try {
    return parseSearchQueryAst(raw);
  } catch {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return ALWAYS_TRUE;
    }
    return { kind: "free", value: trimmed };
  }
}

/**
 * Evaluate an AST against a single book, delegating leaf matching to
 * the caller. The leaf matcher receives only `field` / `free` nodes
 * (negation and grouping are handled here).
 */
export function evaluateAst<B>(
  ast: AstNode,
  book: B,
  matchLeaf: (leaf: LeafNode, book: B) => boolean,
): boolean {
  switch (ast.kind) {
    case "and":
      return ast.children.every((child) => evaluateAst(child, book, matchLeaf));
    case "or":
      return ast.children.some((child) => evaluateAst(child, book, matchLeaf));
    case "not":
      return !evaluateAst(ast.child, book, matchLeaf);
    case "field":
    case "free":
      return matchLeaf(ast, book);
  }
}
