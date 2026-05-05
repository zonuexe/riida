import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AstNode,
  type LeafNode,
  evaluateAst,
  parseSearchQueryAst,
  parseSearchQueryAstSafe,
} from "./search-query-ast.ts";

const acceptAll = () => true;
const rejectAll = () => false;

describe("parseSearchQueryAst", () => {
  it("returns always-true AST for empty input", () => {
    expect(parseSearchQueryAst("")).toEqual({ kind: "and", children: [] });
    expect(parseSearchQueryAst("   ")).toEqual({ kind: "and", children: [] });
  });

  it("parses a single bareword as a free leaf", () => {
    expect(parseSearchQueryAst("rust")).toEqual({ kind: "free", value: "rust" });
  });

  it("parses a known field token", () => {
    expect(parseSearchQueryAst("author:Knuth")).toEqual({
      kind: "field",
      field: "author",
      value: "Knuth",
    });
  });

  it("treats unknown field prefix as free text", () => {
    expect(parseSearchQueryAst("isbn:1234")).toEqual({
      kind: "free",
      value: "isbn:1234",
    });
  });

  it("normalises field names to lowercase", () => {
    expect(parseSearchQueryAst("AUTHOR:Knuth")).toEqual({
      kind: "field",
      field: "author",
      value: "Knuth",
    });
  });

  it("handles quoted values with spaces", () => {
    expect(parseSearchQueryAst('author:"Robert C. Martin"')).toEqual({
      kind: "field",
      field: "author",
      value: "Robert C. Martin",
    });
  });

  it("treats consecutive operands as implicit AND", () => {
    const ast = parseSearchQueryAst("rust go");
    expect(ast).toEqual({
      kind: "and",
      children: [
        { kind: "free", value: "rust" },
        { kind: "free", value: "go" },
      ],
    });
  });

  it("parses explicit AND", () => {
    const ast = parseSearchQueryAst("rust AND go");
    expect(ast).toEqual({
      kind: "and",
      children: [
        { kind: "free", value: "rust" },
        { kind: "free", value: "go" },
      ],
    });
  });

  it("parses OR with lower precedence than AND", () => {
    const ast = parseSearchQueryAst("a b OR c d");
    expect(ast).toEqual({
      kind: "or",
      children: [
        {
          kind: "and",
          children: [
            { kind: "free", value: "a" },
            { kind: "free", value: "b" },
          ],
        },
        {
          kind: "and",
          children: [
            { kind: "free", value: "c" },
            { kind: "free", value: "d" },
          ],
        },
      ],
    });
  });

  it("parses NOT keyword", () => {
    expect(parseSearchQueryAst("NOT rust")).toEqual({
      kind: "not",
      child: { kind: "free", value: "rust" },
    });
  });

  it("parses leading minus as NOT shortcut", () => {
    expect(parseSearchQueryAst("-tag:done")).toEqual({
      kind: "not",
      child: { kind: "field", field: "tag", value: "done" },
    });
  });

  it("parses parentheses for grouping", () => {
    const ast = parseSearchQueryAst("(rust OR go) -tag:archived");
    expect(ast).toEqual({
      kind: "and",
      children: [
        {
          kind: "or",
          children: [
            { kind: "free", value: "rust" },
            { kind: "free", value: "go" },
          ],
        },
        {
          kind: "not",
          child: { kind: "field", field: "tag", value: "archived" },
        },
      ],
    });
  });

  it("treats lowercase 'or' / 'and' / 'not' as free text", () => {
    expect(parseSearchQueryAst("or")).toEqual({ kind: "free", value: "or" });
    expect(parseSearchQueryAst("and")).toEqual({ kind: "free", value: "and" });
    expect(parseSearchQueryAst("not")).toEqual({ kind: "free", value: "not" });
  });

  it("preserves ADR-01 example queries", () => {
    expect(parseSearchQueryAst("tag:プログラミング -tag:未読")).toEqual({
      kind: "and",
      children: [
        { kind: "field", field: "tag", value: "プログラミング" },
        {
          kind: "not",
          child: { kind: "field", field: "tag", value: "未読" },
        },
      ],
    });
  });

  it("throws on unclosed parenthesis", () => {
    expect(() => parseSearchQueryAst("(rust OR go")).toThrow(SyntaxError);
  });

  it("throws on dangling operator", () => {
    expect(() => parseSearchQueryAst("rust OR")).toThrow(SyntaxError);
  });

  it("throws on stray closing paren", () => {
    expect(() => parseSearchQueryAst("rust )")).toThrow(SyntaxError);
  });
});

describe("parseSearchQueryAstSafe", () => {
  it("returns always-true AST for empty input", () => {
    expect(parseSearchQueryAstSafe("")).toEqual({ kind: "and", children: [] });
  });

  it("falls back to free leaf on parse error", () => {
    expect(parseSearchQueryAstSafe("(rust OR go")).toEqual({
      kind: "free",
      value: "(rust OR go",
    });
  });
});

describe("evaluateAst", () => {
  const containsLeaf = (text: string) => (leaf: LeafNode) => {
    if (leaf.kind === "field") return text.includes(`${leaf.field}:${leaf.value}`);
    return text.includes(leaf.value);
  };

  it("evaluates a single free leaf", () => {
    const ast = parseSearchQueryAst("rust");
    expect(evaluateAst(ast, null, containsLeaf("rust book"))).toBe(true);
    expect(evaluateAst(ast, null, containsLeaf("python book"))).toBe(false);
  });

  it("AND requires every child to match", () => {
    const ast = parseSearchQueryAst("rust go");
    expect(evaluateAst(ast, null, containsLeaf("rust go"))).toBe(true);
    expect(evaluateAst(ast, null, containsLeaf("rust"))).toBe(false);
  });

  it("OR requires any child to match", () => {
    const ast = parseSearchQueryAst("rust OR go");
    expect(evaluateAst(ast, null, containsLeaf("go"))).toBe(true);
    expect(evaluateAst(ast, null, containsLeaf("python"))).toBe(false);
  });

  it("NOT inverts the child", () => {
    const ast = parseSearchQueryAst("NOT rust");
    expect(evaluateAst(ast, null, containsLeaf("python"))).toBe(true);
    expect(evaluateAst(ast, null, containsLeaf("rust"))).toBe(false);
  });

  it("respects precedence: a b OR c is (a AND b) OR c", () => {
    const ast = parseSearchQueryAst("a b OR c");
    // matches only "a b" → true
    expect(evaluateAst(ast, null, containsLeaf("a b"))).toBe(true);
    // matches only "c" → true (right branch)
    expect(evaluateAst(ast, null, containsLeaf("c"))).toBe(true);
    // matches only "a" → false (left needs both, right needs c)
    expect(evaluateAst(ast, null, containsLeaf("a"))).toBe(false);
  });

  it("respects parenthesised grouping", () => {
    const ast = parseSearchQueryAst("(a OR b) c");
    expect(evaluateAst(ast, null, containsLeaf("a c"))).toBe(true);
    expect(evaluateAst(ast, null, containsLeaf("b c"))).toBe(true);
    expect(evaluateAst(ast, null, containsLeaf("a"))).toBe(false);
  });

  it("empty AST is always true", () => {
    const ast = parseSearchQueryAst("");
    expect(evaluateAst(ast, null, rejectAll)).toBe(true);
    expect(evaluateAst(ast, null, acceptAll)).toBe(true);
  });
});

// --- Property tests -------------------------------------------------------

const arbBareword = fc
  .stringMatching(/^[a-z]{1,5}$/)
  .filter((s) => s !== "and" && s !== "or" && s !== "not");

function arbAst(depth: number): fc.Arbitrary<AstNode> {
  if (depth <= 0) {
    return arbBareword.map((value) => ({ kind: "free", value }) as AstNode);
  }
  return fc.oneof(
    { weight: 3, arbitrary: arbBareword.map((value) => ({ kind: "free", value }) as AstNode) },
    {
      weight: 1,
      arbitrary: fc
        .array(arbAst(depth - 1), { minLength: 2, maxLength: 3 })
        .map((children) => ({ kind: "and", children }) as AstNode),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(arbAst(depth - 1), { minLength: 2, maxLength: 3 })
        .map((children) => ({ kind: "or", children }) as AstNode),
    },
    {
      weight: 1,
      arbitrary: arbAst(depth - 1).map((child) => ({ kind: "not", child }) as AstNode),
    },
  );
}

describe("evaluateAst — algebraic properties", () => {
  it("double NOT cancels", () => {
    fc.assert(
      fc.property(arbAst(3), fc.func(fc.boolean()), (ast, fn) => {
        const matchLeaf = (leaf: LeafNode) => fn(leaf);
        const doubled: AstNode = { kind: "not", child: { kind: "not", child: ast } };
        return evaluateAst(ast, null, matchLeaf) === evaluateAst(doubled, null, matchLeaf);
      }),
    );
    expect(true).toBe(true);
  });

  it("OR is commutative", () => {
    fc.assert(
      fc.property(arbAst(2), arbAst(2), fc.func(fc.boolean()), (a, b, fn) => {
        const matchLeaf = (leaf: LeafNode) => fn(leaf);
        const ab: AstNode = { kind: "or", children: [a, b] };
        const ba: AstNode = { kind: "or", children: [b, a] };
        return evaluateAst(ab, null, matchLeaf) === evaluateAst(ba, null, matchLeaf);
      }),
    );
    expect(true).toBe(true);
  });

  it("AND is commutative", () => {
    fc.assert(
      fc.property(arbAst(2), arbAst(2), fc.func(fc.boolean()), (a, b, fn) => {
        const matchLeaf = (leaf: LeafNode) => fn(leaf);
        const ab: AstNode = { kind: "and", children: [a, b] };
        const ba: AstNode = { kind: "and", children: [b, a] };
        return evaluateAst(ab, null, matchLeaf) === evaluateAst(ba, null, matchLeaf);
      }),
    );
    expect(true).toBe(true);
  });

  it("De Morgan: NOT (a AND b) === (NOT a) OR (NOT b)", () => {
    fc.assert(
      fc.property(arbAst(2), arbAst(2), fc.func(fc.boolean()), (a, b, fn) => {
        const matchLeaf = (leaf: LeafNode) => fn(leaf);
        const left: AstNode = { kind: "not", child: { kind: "and", children: [a, b] } };
        const right: AstNode = {
          kind: "or",
          children: [
            { kind: "not", child: a },
            { kind: "not", child: b },
          ],
        };
        return evaluateAst(left, null, matchLeaf) === evaluateAst(right, null, matchLeaf);
      }),
    );
    expect(true).toBe(true);
  });
});
