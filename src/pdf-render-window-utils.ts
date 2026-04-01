export type PdfRenderWindowPlan = {
  activeGroupIndex: number;
  renderMin: number;
  renderMax: number;
  keepMin: number;
  keepMax: number;
  renderOrder: number[];
};

export function buildPdfRenderWindowPlan(
  totalGroups: number,
  activeGroupIndex: number,
  renderRadius: number,
  keepRadius: number,
): PdfRenderWindowPlan {
  const renderMin = Math.max(0, activeGroupIndex - renderRadius);
  const renderMax = Math.min(totalGroups - 1, activeGroupIndex + renderRadius);
  const keepMin = Math.max(0, activeGroupIndex - keepRadius);
  const keepMax = Math.min(totalGroups - 1, activeGroupIndex + keepRadius);

  const renderOrder: number[] = [];
  for (let distance = 0; distance <= renderRadius; distance += 1) {
    const beforeIndex = activeGroupIndex - distance;
    const afterIndex = activeGroupIndex + distance;

    if (beforeIndex >= renderMin) {
      renderOrder.push(beforeIndex);
    }

    if (distance > 0 && afterIndex <= renderMax) {
      renderOrder.push(afterIndex);
    }
  }

  return {
    activeGroupIndex,
    renderMin,
    renderMax,
    keepMin,
    keepMax,
    renderOrder,
  };
}
