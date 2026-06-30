// Apply a PDF page viewport's transform matrix to a PDF-space rectangle,
// returning it in viewport (device) coordinates.
//
// This replicates `PageViewport.convertToViewportRectangle`, which pdfjs-dist
// removed in 6.1. The viewport transform is the affine matrix [a, b, c, d, e, f]
// (`viewport.transform`); each corner maps as (x, y) -> (a*x + c*y + e,
// b*x + d*y + f). Callers normalize the result with min/max, so corner order
// does not matter.
export function convertPdfRectToViewport(rect: number[], transform: number[]): number[] {
  const a = transform[0] ?? 1;
  const b = transform[1] ?? 0;
  const c = transform[2] ?? 0;
  const d = transform[3] ?? 1;
  const e = transform[4] ?? 0;
  const f = transform[5] ?? 0;
  const x1 = rect[0] ?? 0;
  const y1 = rect[1] ?? 0;
  const x2 = rect[2] ?? 0;
  const y2 = rect[3] ?? 0;
  return [a * x1 + c * y1 + e, b * x1 + d * y1 + f, a * x2 + c * y2 + e, b * x2 + d * y2 + f];
}
