import type { UserShortcut } from "@/lib/api";

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

const namedCodes: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Escape: "Escape",
  NumpadAdd: "=",
  NumpadSubtract: "-",
  NumpadDecimal: ".",
  NumpadMultiply: "*",
  NumpadDivide: "/",
};

function shortcutKey(event: KeyboardEvent): string | null {
  if (event.key === "+" || event.code === "NumpadAdd") return "=";
  if (event.code === "NumpadSubtract") return "-";
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^Numpad[0-9]$/.test(event.code)) return event.code.slice(6);
  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return event.code;
  if (namedCodes[event.code]) return namedCodes[event.code];
  if (event.key.length === 1 && /[a-z0-9]/i.test(event.key)) return event.key.toUpperCase();
  return null;
}

function modifierDown(event: KeyboardEvent, name: "Meta" | "Control" | "Alt" | "Shift", flag: boolean) {
  return flag || event.getModifierState(name);
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
  const actual = shortcutKey(event)?.toLowerCase();
  if (actual !== key) return false;
  const modifiers = resolveModifiers(parts, platform);
  if (
    modifierDown(event, "Meta", event.metaKey) !== modifiers.has("Meta") ||
    modifierDown(event, "Control", event.ctrlKey) !== modifiers.has("Ctrl")
  )
    return false;
  const shift = modifierDown(event, "Shift", event.shiftKey);
  return (
    modifierDown(event, "Alt", event.altKey) === modifiers.has("Alt") &&
    ((key === "=" && (event.key === "+" || event.code === "NumpadAdd")) ||
      shift === modifiers.has("Shift"))
  );
}
export function captureShortcut(event: KeyboardEvent): string | null {
  if (/^(?:Meta|Control|Alt|Shift)(?:Left|Right)?$/.test(event.code) || ["Meta", "Control", "Alt", "Shift"].includes(event.key))
    return null;
  const key = shortcutKey(event);
  if (!key) return null;
  const meta = modifierDown(event, "Meta", event.metaKey);
  const ctrl = modifierDown(event, "Control", event.ctrlKey);
  const alt = modifierDown(event, "Alt", event.altKey);
  const shift = modifierDown(event, "Shift", event.shiftKey);
  if (!meta && !ctrl && !alt && !shift) return null;
  if (
    !/^(?:[A-Z0-9,=\-[\]\\/;.'`]|Tab|Enter|Backspace|Delete|Escape|F\d{1,2})$/.test(
      key,
    )
  )
    return null;
  return [
    ...(meta ? ["Meta"] : []),
    ...(ctrl ? ["Ctrl"] : []),
    ...(alt ? ["Alt"] : []),
    ...(shift && key !== "=" ? ["Shift"] : []),
    key,
  ].join("+");
}
export function shortcutConflict(
  values: Record<string, string>,
  platform = currentPlatform(),
  extras: { label: string; binding: string }[] = [],
): string | undefined {
  const seen = new Map<string, string>();
  const entries = [
    ...shortcutActions.map((action) => ({
      label: action.label,
      binding: values[action.id],
    })),
    ...extras,
  ];
  for (const action of entries) {
    const binding = action.binding;
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
export function decodeShortcutText(value: string) {
  let text = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char !== "\\") {
      text += char;
      continue;
    }
    const next = value[++index];
    text +=
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "\\"
              ? "\\"
              : `\\${next ?? ""}`;
  }
  return text;
}
export function userShortcutText(item: UserShortcut) {
  const text = decodeShortcutText(item.text);
  if (item.kind === "sendEnter" && !text.endsWith("\r")) return `${text}\r`;
  return text;
}
export function shortcutLabel(value: string, platform = currentPlatform()) {
  const mac = primaryModifier(platform) === "Meta";
  return value
    .replaceAll("Mod", mac ? "⌘" : "Ctrl")
    .replaceAll("Meta", mac ? "⌘" : "Win");
}
