const fs = require("fs");
const path = require("path");

function update(file, transform) {
  const full = path.resolve(file);
  const before = fs.readFileSync(full, "utf8");
  const after = transform(before);
  if (after === before) throw new Error("No change in " + file);
  fs.writeFileSync(full, after);
  console.log("updated", file);
}

function replaceOnce(s, old, neu, label) {
  if (!s.includes(old)) throw new Error("missing " + label);
  const next = s.replace(old, neu);
  if (next === s) throw new Error("failed " + label);
  return next;
}

update("src/index.css", (s) => {
  s = replaceOnce(
    s,
    `html,
body,
#root {
  height: 100%;
  overflow: hidden;
}
html {
  /* Tauri draws a transparent window, so unpainted pixels show the desktop. */
  background: transparent;
}
.app-shell {
  min-height: 0;
  display: grid;`,
    `html,
body,
#root {
  height: 100%;
  overflow: hidden;
  background: transparent;
}
.app-shell {
  background: transparent;
  min-height: 0;
  display: grid;`,
    "html/body/app-shell"
  );

  s = replaceOnce(
    s,
    `/* xterm ships a black viewport fallback; match the selected terminal surface.
   The whole window is blended once, so this stays opaque. */
.terminal-pane .terminal-host .xterm-viewport {
  background-color: var(--terminal-background);
}`,
    `/* xterm paints glyphs on a transparent canvas; the pane CSS supplies the tint. */
.terminal-pane .terminal-host .xterm,
.terminal-pane .terminal-host .xterm-viewport,
.terminal-pane .terminal-host .xterm-screen,
.terminal-pane .terminal-host .xterm-screen canvas {
  background: transparent;
}`,
    "xterm viewport"
  );

  s = replaceOnce(
    s,
    `:root {
  --panel: #ffffff;
  --gutter: #e7e9ed;
  --panel-shadow: 0 3px 14px #18243908;
}
:root.dark {
  --panel: #242424;
  --gutter: #181818;
  --panel-shadow: 0 3px 14px #00000012;
}`,
    `:root {
  --panel: color-mix(in srgb, #ffffff var(--window-opacity), transparent);
  --gutter: color-mix(in srgb, #e7e9ed var(--window-opacity), transparent);
  --panel-shadow: 0 3px 14px #18243908;
}
:root.dark {
  --panel: color-mix(in srgb, #242424 var(--window-opacity), transparent);
  --gutter: color-mix(in srgb, #181818 var(--window-opacity), transparent);
  --panel-shadow: 0 3px 14px #00000012;
}`,
    "panel/gutter"
  );

  s = replaceOnce(
    s,
    `.workspace,
.session-layout {
  background: var(--gutter);
}
.session-layout {
  padding: 4px 6px 6px;
  gap: 6px;
}
.session-content {
  background: var(--gutter);
}`,
    `.workspace {
  background: transparent;
}
.session-layout {
  background: var(--gutter);
  padding: 4px 6px 6px;
  gap: 6px;
}
.session-content {
  background: transparent;
}`,
    "workspace stacking"
  );

  s = replaceOnce(
    s,
    `.screen-lock {
  background: var(--background);
}

/* GFM tables keep their columns without widening the AI dock. */`,
    `.screen-lock {
  background: var(--background-solid);
}

/* GFM tables keep their columns without widening the AI dock. */`,
    "screen-lock"
  );

  return s;
});
