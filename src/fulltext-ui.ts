// Pure helpers for the full-text search UI. DOM rendering lives in main.ts;
// these side-effect-free functions are unit-tested.

export type FullTextHitKind = "metadata" | "note" | "body";

/** A single hit as returned by the `search_fulltext` command (camelCase). */
export type FullTextHit = {
  filePath: string;
  title: string;
  kind: FullTextHitKind;
  page: number | null;
  anchor: string | null;
  score: number;
  snippetHtml: string;
};

/** Status returned by the `fulltext_index_status` command. */
export type FullTextIndexStatus = {
  total: number;
  indexed: number;
  /** File-backed books whose body was skipped because they are online-only. */
  deferred: number;
  failed: number;
  building: boolean;
  built: boolean;
  /** Disk used by the on-disk index, in bytes. */
  indexSizeBytes: number;
};

/** One matched location within a book (a page, a section, or a metadata/note hit). */
export type FullTextHitLocation = {
  kind: FullTextHitKind;
  page: number | null;
  anchor: string | null;
  snippetHtml: string;
  score: number;
};

/** Hits for one book, grouped for display. */
export type FullTextBookGroup = {
  filePath: string;
  title: string;
  /** Best (highest) score among the book's hits; used for ordering. */
  score: number;
  locations: FullTextHitLocation[];
};

/**
 * Group flat hits (assumed already sorted by descending score) by book,
 * preserving that order, and cap the number of locations shown per book.
 */
export function groupHitsByBook(
  hits: readonly FullTextHit[],
  maxLocationsPerBook = 3,
): FullTextBookGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, FullTextBookGroup>();

  for (const hit of hits) {
    let group = byPath.get(hit.filePath);
    if (!group) {
      group = {
        filePath: hit.filePath,
        title: hit.title,
        score: hit.score,
        locations: [],
      };
      byPath.set(hit.filePath, group);
      order.push(hit.filePath);
    }
    if (hit.score > group.score) {
      group.score = hit.score;
    }
    if (group.locations.length < maxLocationsPerBook) {
      group.locations.push({
        kind: hit.kind,
        page: hit.page,
        anchor: hit.anchor,
        snippetHtml: hit.snippetHtml,
        score: hit.score,
      });
    }
  }

  return order.map((path) => byPath.get(path)!);
}

/**
 * Where to jump when a hit location is activated. Body hits jump to a PDF page
 * or an EPUB anchor/CFI; metadata/note hits have no location (just open the book).
 */
export function jumpTargetForHit(
  location: Pick<FullTextHitLocation, "kind" | "page" | "anchor">,
): { page?: number; cfi?: string } | null {
  if (location.kind !== "body") {
    return null;
  }
  if (typeof location.page === "number" && location.page > 0) {
    return { page: location.page };
  }
  if (location.anchor && location.anchor.length > 0) {
    return { cfi: location.anchor };
  }
  return null;
}

/** Short human label for a hit location ("p.42" / section / metadata / note). */
export function locationLabel(location: Pick<FullTextHitLocation, "kind" | "page">): string {
  if (location.kind === "metadata") {
    return "書誌情報";
  }
  if (location.kind === "note") {
    return "ノート";
  }
  if (typeof location.page === "number" && location.page > 0) {
    return `p.${location.page}`;
  }
  return "本文";
}

/** Format a byte count as a short human-readable size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[exponent]}`;
}

/** Human label describing index coverage / state, for the settings panel. */
export function formatIndexStatusLabel(status: FullTextIndexStatus): string {
  if (status.building) {
    return `索引を構築中… ${status.indexed.toLocaleString()} / ${status.total.toLocaleString()} 冊`;
  }
  if (!status.built) {
    return "全文検索の索引は未構築です";
  }
  const parts = [
    `索引済み ${status.indexed.toLocaleString()} / ${status.total.toLocaleString()} 冊`,
  ];
  if (status.deferred > 0) {
    parts.push(`オンラインのみ ${status.deferred.toLocaleString()} 冊は本文スキップ`);
  }
  if (status.failed > 0) {
    parts.push(`${status.failed.toLocaleString()} 冊が失敗`);
  }
  parts.push(formatBytes(status.indexSizeBytes));
  return parts.join("・");
}

/** Whether the "build index" action should be enabled right now. */
export function canStartBuild(status: FullTextIndexStatus): boolean {
  return !status.building;
}
