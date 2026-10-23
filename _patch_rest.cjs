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
  const count = s.split(old).length - 1;
  if (count !== 1) throw new Error(label + " count=" + count);
  return s.replace(old, neu);
}

update("src/index.css", (s) =>
  replaceOnce(
    s,
    "  background: var(--background);\n  display: grid;\n  place-items: center;\n}",
    "  background: var(--background-solid);\n  display: grid;\n  place-items: center;\n}",
    "screen-lock first bg"
  )
);

update("src/lib/api.ts", (s) =>
  replaceOnce(
    s,
    `  aiBaseUrl: "",
  aiModel: "",
};
export interface FileItem {`,
    `  aiBaseUrl: "",
  aiModel: "",
};
export function applyWindowOpacity(opacity = defaultPreferences.windowOpacity) {
  const value = Math.min(
    100,
    Math.max(20, Math.round(Number(opacity) || 100)),
  );
  const root = document.documentElement;
  root.style.setProperty("--window-opacity", `${value}%`);
  root.style.removeProperty("opacity");
}
export interface FileItem {`,
    "applyWindowOpacity"
  )
);

update("src/App.tsx", (s) => {
  s = replaceOnce(
    s,
    `  defaultPreferences,
    directOptions,`,
    `  applyWindowOpacity,
  defaultPreferences,
    directOptions,`,
    "App import"
  );
  s = replaceOnce(
    s,
    `  return defaultPreferences;
}
export default function App() {`,
    `  return defaultPreferences;
}
applyWindowOpacity(cachedPreferences().windowOpacity);
export default function App() {`,
    "App bootstrap opacity"
  );
  s = replaceOnce(
    s,
    `  useEffect(() => {
    // The window is transparent, so the whole surface is blended with the
    // desktop in one pass; every panel keeps its own opaque color.
    document.documentElement.style.opacity = String(
      (preferences.windowOpacity ?? 100) / 100,
    );
  }, [preferences.windowOpacity]);`,
    `  useLayoutEffect(() => {
    applyWindowOpacity(preferences.windowOpacity);
  }, [preferences.windowOpacity]);`,
    "App opacity effect"
  );
  return s;
});

update("src/components/SettingsPage.tsx", (s) => {
  s = replaceOnce(
    s,
    `import { useEffect, useState, type FormEvent } from "react";`,
    `import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";`,
    "Settings useLayoutEffect import"
  );
  s = replaceOnce(
    s,
    `import {
  command,
  errorMessage,
  type LocalHost,
  type Preferences,
} from "@/lib/api";`,
    `import {
  applyWindowOpacity,
  command,
  errorMessage,
  type LocalHost,
  type Preferences,
} from "@/lib/api";`,
    "Settings api import"
  );
  s = replaceOnce(
    s,
    `  useEffect(() => {
    // Apply while dragging so the translucent window tracks the slider; the
    // cleanup restores the saved value if the edit is abandoned.
    const root = document.documentElement;
    root.style.opacity = String((draft.windowOpacity ?? 100) / 100);
    return () => {
      root.style.opacity = String((preferences.windowOpacity ?? 100) / 100);
    };
  }, [draft.windowOpacity, preferences.windowOpacity]);`,
    `  useLayoutEffect(() => {
    // Apply while dragging so the translucent window tracks the slider; the
    // cleanup restores the saved value if the edit is abandoned.
    applyWindowOpacity(draft.windowOpacity);
    return () => applyWindowOpacity(preferences.windowOpacity);
  }, [draft.windowOpacity, preferences.windowOpacity]);`,
    "Settings live preview"
  );
  s = replaceOnce(
    s,
    `                    拖动即时生效。0% 为完全不透明，数值越高窗口越透；整个窗口按同一比例与桌面混合，标题栏、侧边栏、终端和文字一起变淡，不会出现深浅不一。为保可读性上限 80%，保存后重启仍生效。`,
    `                    拖动即时生效。0% 为完全不透明，数值越高窗口越透；标题栏、侧边栏和终端背景会透出桌面，文字与图标保持清晰。为保可读性上限 80%，保存后重启仍生效。`,
    "Settings description"
  );
  return s;
});

update("src/lib/themes.ts", (s) =>
  replaceOnce(
    s,
    `export const terminalThemes: Record<string, Palette> = {`,
    `export function xtermTheme(id: string): ITheme {
  const theme = (terminalThemes[id] ?? terminalThemes["pixiu-shell"]).theme;
  return { ...theme, background: "#00000000" };
}
export const terminalThemes: Record<string, Palette> = {`,
    "xtermTheme helper"
  )
);

update("src/components/TerminalPane.tsx", (s) => {
  s = replaceOnce(
    s,
    `import { terminalThemes } from "@/lib/themes";`,
    `import { terminalThemes, xtermTheme } from "@/lib/themes";`,
    "TerminalPane theme import"
  );
  s = replaceOnce(
    s,
      `    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      overviewRuler: { width: 6 },
      theme: terminalThemes["pixiu-shell"].theme,
      // SearchAddon uses xterm's decoration API to highlight and scroll to matches.
      allowProposedApi: true,
    });`,
      `    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      overviewRuler: { width: 6 },
      theme: xtermTheme("pixiu-shell"),
      allowTransparency: true,
      // SearchAddon uses xterm's decoration API to highlight and scroll to matches.
      allowProposedApi: true,
    });`,
    "Terminal constructor"
  );
  s = replaceOnce(
    s,
    `    if (terminal.current) {
      const theme = (
        terminalThemes[preferences.terminalTheme] ?? terminalThemes["pixiu-shell"]
      ).theme;
      // The window itself is blended once from preferences, so the theme keeps
      // its opaque background here.
      terminal.current.options.theme = theme;`,
    `    if (terminal.current) {
      terminal.current.options.theme = xtermTheme(preferences.terminalTheme);`,
    "Terminal theme update"
  );
  s = replaceOnce(
    s,
    `          "--terminal-background": (
            terminalThemes[preferences.terminalTheme] ??
            terminalThemes["pixiu-shell"]
          ).theme.background,
          background: "var(--terminal-background)",`,
    `          "--terminal-background": (
            terminalThemes[preferences.terminalTheme] ??
            terminalThemes["pixiu-shell"]
          ).theme.background,
          background:
            "color-mix(in srgb, var(--terminal-background) var(--window-opacity), transparent)",`,
    "Terminal pane background"
  );
  return s;
});

update("index.html", (s) =>
  replaceOnce(
    s,
    `    <title>Pixiu Shell · 运维终端</title>
  </head>`,
    `    <title>Pixiu Shell · 运维终端</title>
    <style>
      html,
      body,
      #root {
        background: transparent;
      }
    </style>
  </head>`,
    "index.html transparent"
  )
);

update("src-tauri/tauri.conf.json", (s) =>
  replaceOnce(
    s,
    `        "titleBarStyle": "Overlay",
      "transparent": true,
        "hiddenTitle": true,`,
    `        "titleBarStyle": "Overlay",
        "transparent": true,
        "backgroundColor": "#00000000",
        "hiddenTitle": true,`,
    "tauri.conf transparent"
  )
);

update("src-tauri/src/lib.rs", (s) =>
  replaceOnce(
    s,
    `            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }`,
    `            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                window.set_decorations(false)?;
                window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))?;
            }`,
    "lib.rs background color"
  )
);

update("src-tauri/src/preferences.rs", (s) => {
  s = replaceOnce(
    s,
    `// The window is transparent; lower values blend the whole surface into the desktop.`,
    `// Chrome mixes with the desktop; 20 keeps the UI readable.`,
    "prefs comment"
  );
  s = replaceOnce(
    s,
    `            font_size: 16,
            ai_panel_width: 620,
            platform_address: "https://ops.example.com".into(),
            ..Preferences::default()
        };
        save(&mut crate::storage::open(&path)?, &prefs)?;
        let restored = load(&crate::storage::open(&path)?)?;
        assert_eq!(restored.theme, "light");
        assert_eq!(restored.font_size, 16);
        assert_eq!(restored.ai_panel_width, 620);
        assert_eq!(restored.platform_address, "https://ops.example.com");`,
    `            font_size: 16,
            ai_panel_width: 620,
            window_opacity: 45,
            platform_address: "https://ops.example.com".into(),
            ..Preferences::default()
        };
        save(&mut crate::storage::open(&path)?, &prefs)?;
        let restored = load(&crate::storage::open(&path)?)?;
        assert_eq!(restored.theme, "light");
        assert_eq!(restored.font_size, 16);
        assert_eq!(restored.ai_panel_width, 620);
        assert_eq!(restored.window_opacity, 45);
        assert_eq!(restored.platform_address, "https://ops.example.com");`,
    "prefs roundtrip test"
  );
  return s;
});
