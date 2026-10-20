function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function primaryModifier(platform: string): "Meta" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "Meta" : "Ctrl";
}

function resolveModifiers(parts: string[], platform: string): Set<string> {
  return new Set(
    parts.map((part) => (part === "Mod" ? primaryModifier(platform) : part)),
  );
}

export const shortcutActions = [
  { id: "search", label: "搜索主机与终端", default: "Mod+K" },
  { id: "newShell", label: "新建本机终端", default: "Mod+T" },
  { id: "splitRight", label: "左右分屏", default: "Mod+D" },
  { id: "splitDown", label: "上下分屏", default: "Mod+Shift+D" },
  { id: "closeTab", label: "关闭当前标签", default: "Mod+W" },
  { id: "nextTab", label: "下一个标签", default: "Ctrl+Tab" },
  { id: "previousTab", label: "上一个标签", default: "Ctrl+Shift+Tab" },
  { id: "settings", label: "打开配置", default: "Mod+," },
  { id: "lock", label: "锁屏", default: "Mod+Shift+L" },
  { id: "zoomIn", label: "当前终端放大", default: "Mod+=" },
  { id: "zoomOut", label: "当前终端缩小", default: "Mod+-" },
  { id: "zoomReset", label: "当前终端恢复默认字号", default: "Mod+0" },
  { id: "fullscreen", label: "切换全屏", default: "Mod+Enter" },
] as const;
export type ShortcutAction = (typeof shortcutActions)[number]["id"];
export function effectiveShortcuts(overrides: Record<string, string> = {}) {
  return Object.fromEntries(
    shortcutActions.map((action) => [
      action.id,
      overrides[action.id] ?? action.default,
    ]),
  ) as Record<ShortcutAction, string>;
}
export function shortcutMatches(
  event: KeyboardEvent,
  binding: string,
  platform = currentPlatform(),
): boolean {
  if (!binding) return false;
  const parts = binding.split("+"),
    key = parts.pop()!.toLowerCase();
  const actual =
    event.code === "NumpadAdd" || event.key === "+"
      ? "="
      : event.code === "NumpadSubtract"
        ? "-"
        : event.key.toLowerCase();
  if (actual !== key) return false;
  const modifiers = resolveModifiers(parts, platform);
  if (
    event.metaKey !== modifiers.has("Meta") ||
    event.ctrlKey !== modifiers.has("Ctrl")
  )
    return false;
  return (
    event.altKey === modifiers.has("Alt") &&
    ((key === "=" && event.key === "+") ||
      event.shiftKey === modifiers.has("Shift"))
  );
}
export function captureShortcut(event: KeyboardEvent): string | null {
  if (
    event.isComposing ||
    ["Meta", "Control", "Alt", "Shift"].includes(event.key)
  )
    return null;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const key =
    event.key === "+"
      ? "="
      : event.code === "NumpadAdd"
        ? "="
        : event.code === "NumpadSubtract"
          ? "-"
          : event.key.length === 1
            ? event.key.toUpperCase()
            : event.key;
  if (
    !/^(?:[A-Z0-9,=\-[\]\\/;.'`]|Tab|Enter|Backspace|Delete|Escape|F\d{1,2})$/.test(
      key,
    )
  )
    return null;
  return [
    ...(event.metaKey ? ["Meta"] : []),
    ...(event.ctrlKey ? ["Ctrl"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey && key !== "=" ? ["Shift"] : []),
    key,
  ].join("+");
}
export function shortcutConflict(
  values: Record<string, string>,
  platform = currentPlatform(),
): string | undefined {
  const seen = new Map<string, string>();
  for (const action of shortcutActions) {
    const binding = values[action.id];
    if (!binding) continue;
    const parts = binding.split("+");
    const key = parts.pop()!.toLowerCase();
    const normalized =
      [...resolveModifiers(parts, platform)].sort().join("+") + "+" + key;
    const previous = seen.get(normalized);
    if (previous) return `${previous} 与 ${action.label} 使用了相同的快捷键`;
    seen.set(normalized, action.label);
  }
  return undefined;
}
export function shortcutLabel(value: string, platform = currentPlatform()) {
  const mac = primaryModifier(platform) === "Meta";
  return value
    .replaceAll("Mod", mac ? "⌘" : "Ctrl")
    .replaceAll("Meta", mac ? "⌘" : "Win")
    .replaceAll("Shift", "⇧");
}
