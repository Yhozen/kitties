// Applies the saved colour mode before the first paint, so a page set to light never flashes
// dark. The same rules as src/theme.ts; the palette is the Motita design system (themes.css).
(function () {
  // Dark unless the person picked light or the system's.
  var mode = "dark";
  var q = /[?&]theme=(light|dark)/.exec(location.search);
  if (q) {
    mode = q[1];
  }
  try {
    if (q) {
      throw new Error("the query wins");
    }
    var raw = JSON.parse(localStorage.getItem("kitties.ui.theme") || "{}");
    if (raw.mode === "light" || raw.mode === "dark" || raw.mode === "system") {
      mode = raw.mode;
    }
  } catch {
    /* the defaults */
  }
  if (mode === "system") {
    mode = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  var root = document.documentElement;
  if (/[?&]motion=off/.test(location.search)) {
    root.dataset.motion = "off";
  }
  root.dataset.mode = mode;
  root.dataset.scheme = "motita";
  root.style.colorScheme = mode;
})();
