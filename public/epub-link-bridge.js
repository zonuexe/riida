(function () {
  if (window.__riidaEpubLinkBridgeInstalled) {
    return;
  }
  window.__riidaEpubLinkBridgeInstalled = true;

  function findClosestLink(target) {
    return target instanceof Element ? target.closest("a[href]") : null;
  }

  document.addEventListener(
    "click",
    function (event) {
      var link = findClosestLink(event.target);
      if (!link) {
        return;
      }

      var href = link.getAttribute("href");
      if (!href) {
        return;
      }

      var root = document.documentElement;
      var filePath = root ? root.getAttribute("data-riida-file-path") : null;
      var sectionIndexRaw = root ? root.getAttribute("data-riida-section-index") : null;
      var sectionIndex = sectionIndexRaw === null ? null : Number(sectionIndexRaw);

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      window.parent.postMessage(
        {
          type: "riida:epub-link",
          href: href,
          filePath: filePath || "",
          sectionIndex: Number.isFinite(sectionIndex) ? sectionIndex : -1,
        },
        "*",
      );
    },
    true,
  );
})();
