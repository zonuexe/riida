export type BindingDirection = "left" | "right";

export type ViewerPreferencesLike = {
  Direction?: unknown;
  [key: string]: unknown;
};

export type TextStyleLike = {
  vertical?: boolean;
};

export type TextItemLike = {
  str: string;
  fontName: string;
  transform?: ReadonlyArray<number>;
};

export type TextContentSampleLike = {
  items: ReadonlyArray<TextItemLike | { type: string }>;
  styles: { [name: string]: TextStyleLike };
};

const VERTICAL_BINDING_THRESHOLD_RATIO = 0.5;
const VERTICAL_BINDING_MIN_CHARACTERS = 50;

// Geometry path thresholds. Aggregated across all sampled pages so that
// sparse-text PDFs (image-heavy CJK novels with only page-number text)
// can still surface a usable signal.
const GEOMETRY_BINDING_MIN_ITEMS = 30;
const GEOMETRY_BINDING_MIN_TOTAL_DELTA = 200;
const GEOMETRY_BINDING_RATIO = 1.3;

export function detectBindingFromViewerPreferences(
  preferences: ViewerPreferencesLike | null | undefined,
): BindingDirection | null {
  if (!preferences || typeof preferences !== "object") {
    return null;
  }
  const direction = preferences.Direction;
  if (direction === "R2L") {
    return "right";
  }
  if (direction === "L2R") {
    return "left";
  }
  return null;
}

export function detectBindingFromTextContent(
  samples: ReadonlyArray<TextContentSampleLike>,
): BindingDirection | null {
  let verticalChars = 0;
  let horizontalChars = 0;
  let geometryItems = 0;
  let cumulativeDx = 0;
  let cumulativeDy = 0;

  for (const sample of samples) {
    let previousTx: number | null = null;
    let previousTy: number | null = null;

    for (const item of sample.items) {
      if (!isTextItem(item)) continue;
      const length = item.str.length;
      if (length === 0) continue;

      const style = sample.styles[item.fontName];
      if (style?.vertical === true) {
        verticalChars += length;
      } else {
        horizontalChars += length;
      }

      const tx = item.transform?.[4];
      const ty = item.transform?.[5];
      if (typeof tx === "number" && typeof ty === "number") {
        if (previousTx !== null && previousTy !== null) {
          cumulativeDx += Math.abs(tx - previousTx);
          cumulativeDy += Math.abs(ty - previousTy);
        }
        previousTx = tx;
        previousTy = ty;
        geometryItems += 1;
      }
    }
  }

  const totalChars = verticalChars + horizontalChars;
  if (
    totalChars >= VERTICAL_BINDING_MIN_CHARACTERS &&
    verticalChars / totalChars >= VERTICAL_BINDING_THRESHOLD_RATIO
  ) {
    return "right";
  }

  // Geometry fallback: many CJK PDFs use horizontal CMaps (Identity-H) but
  // position each glyph individually, stacking them top-to-bottom. In those
  // cases the per-item transform deltas accumulate predominantly along the
  // Y axis even though style.vertical is false. Aggregating across pages
  // makes this robust against sparse front-matter or page-number-only pages.
  const totalDelta = cumulativeDx + cumulativeDy;
  // Treat purely vertical motion (dx === 0) as a definitive vertical signal
  // instead of dividing by zero.
  const ratio = cumulativeDx === 0 ? Infinity : cumulativeDy / cumulativeDx;
  if (
    geometryItems >= GEOMETRY_BINDING_MIN_ITEMS &&
    totalDelta >= GEOMETRY_BINDING_MIN_TOTAL_DELTA &&
    ratio >= GEOMETRY_BINDING_RATIO
  ) {
    return "right";
  }

  return null;
}

export function detectPdfBinding(
  preferences: ViewerPreferencesLike | null | undefined,
  samples: ReadonlyArray<TextContentSampleLike>,
): BindingDirection | null {
  const fromPrefs = detectBindingFromViewerPreferences(preferences);
  if (fromPrefs !== null) {
    return fromPrefs;
  }
  return detectBindingFromTextContent(samples);
}

function isTextItem(candidate: TextItemLike | { type: string }): candidate is TextItemLike {
  return (
    typeof (candidate as TextItemLike).str === "string" &&
    typeof (candidate as TextItemLike).fontName === "string"
  );
}
