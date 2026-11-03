// The src/app/ feature modules are layered: a module imports only modules
// below it, and calls up the layers go through the app shell
// (src/app/shell.ts). This test keeps their value-import graph acyclic.
// Type-only imports are erased at build time and are left out.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("./app/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

function moduleName(path: string) {
  return path.replace(/^\.\/app\//, "").replace(/\.ts$/, "");
}

function valueImports(source: string): string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+"\.\/([\w-]+)";/gm)) {
    const [, typeOnly, clause = "", target = ""] = match;
    const specifiers = clause.trim().startsWith("{")
      ? clause
          .replace(/[{}]/g, "")
          .split(",")
          .map((specifier) => specifier.trim())
          .filter(Boolean)
      : [clause.trim()];
    if (!typeOnly && specifiers.some((specifier) => !specifier.startsWith("type "))) {
      targets.push(target);
    }
  }
  return targets;
}

const graph = new Map(
  Object.entries(sources).map(([path, source]) => [moduleName(path), valueImports(source)]),
);

// Depth-first search; returns the first cycle found as a module path.
function findCycle(): string[] | null {
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (name: string): string[] | null => {
    const onStack = stack.indexOf(name);
    if (onStack >= 0) return [...stack.slice(onStack), name];
    if (done.has(name)) return null;
    stack.push(name);
    for (const target of graph.get(name) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    done.add(name);
    return null;
  };

  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

describe("src/app/ module layering", () => {
  it("reads the feature modules' imports", () => {
    expect(graph.size).toBeGreaterThan(20);
    expect(graph.get("viewer")).toContain("pdf-viewer");
    expect(graph.get("shell")).toEqual([]);
  });

  it("has no value-import cycle", () => {
    expect(findCycle()?.join(" -> ") ?? null).toBeNull();
  });
});
