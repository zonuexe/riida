export type ViewerLayoutSettings = {
  pageMode: "single" | "spread";
  bindingDirection: "left" | "right";
  treatFirstPageAsCover: boolean;
};

export function buildPageGroups(totalPages: number, settings: ViewerLayoutSettings) {
  const groups: number[][] = [];

  if (settings.pageMode === "single") {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      groups.push([pageNumber]);
    }
    return groups;
  }

  let pageNumber = 1;

  if (settings.treatFirstPageAsCover && totalPages > 0) {
    groups.push([1]);
    pageNumber = 2;
  }

  while (pageNumber <= totalPages) {
    if (pageNumber === totalPages) {
      groups.push([pageNumber]);
      break;
    }

    groups.push([pageNumber, pageNumber + 1]);
    pageNumber += 2;
  }

  return groups;
}

export function getVisualPageOrder(group: number[], settings: ViewerLayoutSettings) {
  if (group.length < 2 || settings.bindingDirection === "left") {
    return group;
  }

  return [...group].reverse();
}
