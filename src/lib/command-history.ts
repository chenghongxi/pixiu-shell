import { command, desktop, type Target } from "@/lib/api";

export interface CommandHistoryEntry {
  id: string;
  scope: string;
  hostName: string;
  hostAddress: string;
  command: string;
  useCount: number;
  lastUsedAt: number;
}

const STORAGE_KEY = "pixiu:command-history:v1";
const MAX_PREVIEW_ENTRIES = 500;
export const COMMAND_HISTORY_CHANGED_EVENT = "pixiu:command-history-changed";

export interface CommandSuggestion extends CommandHistoryEntry {
  source: "history" | "preset";
  description?: string;
  matchType: "prefix" | "contains";
  sameScope: boolean;
}

function notifyCommandHistoryChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(COMMAND_HISTORY_CHANGED_EVENT));
  }
}

export function commandHistoryScope(target: Target): string {
  return target.mode === "shell" ? "shell" : `${target.mode}:${target.id}`;
}

export function isSensitiveTerminalPrompt(line: string): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed) return false;
  return (
    /(?:password|passphrase|pin\s*code|passcode|otp|token|密码|口令|验证码)\s*(?:\([^)]+\))?\s*(?:for\s+[^:：]+)?\s*[:：]\s*$/i.test(
      trimmed,
    ) ||
    /\(yes\/no(?:\/\[fingerprint\])?\)\s*[?:：]?\s*$/i.test(trimmed)
  );
}

function readPreviewEntries(): CommandHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CommandHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writePreviewEntries(entries: CommandHistoryEntry[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_PREVIEW_ENTRIES)),
    );
  } catch {
    // Ignore storage quota errors in browser preview mode.
  }
}

export async function listCommandHistory(
  scope?: string,
  query?: string,
  limit = 200,
): Promise<CommandHistoryEntry[]> {
  if (desktop) {
    return command<CommandHistoryEntry[]>("command_history_list", {
      scope: scope || null,
      query: query || null,
      limit,
    });
  }
  const needle = query?.trim().toLowerCase() || "";
  const sorted = readPreviewEntries().sort(
    (a, b) => b.lastUsedAt - a.lastUsedAt,
  );
  if (scope) {
    return sorted
      .filter(
        (item) =>
          item.scope === scope &&
          (!needle || item.command.toLowerCase().includes(needle)),
      )
      .slice(0, limit);
  }
  const merged = new Map<string, CommandHistoryEntry>();
  for (const item of sorted) {
    if (
      needle &&
      !item.command.toLowerCase().includes(needle) &&
      !item.hostName.toLowerCase().includes(needle) &&
      !item.hostAddress.toLowerCase().includes(needle)
    ) {
      continue;
    }
    const existing = merged.get(item.command);
    if (existing) {
      existing.useCount += item.useCount;
      continue;
    }
    merged.set(item.command, { ...item });
  }
  return [...merged.values()].slice(0, limit);
}

export async function recordCommandHistory(entry: {
  scope: string;
  hostName: string;
  hostAddress: string;
  command: string;
}): Promise<void> {
  const text = entry.command.trim();
  if (!text || text.length > 4000) return;
  if (
    Array.from(text).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return;
  }
  if (desktop) {
    await command("command_history_record", {
      scope: entry.scope,
      hostName: entry.hostName,
      hostAddress: entry.hostAddress,
      command: text,
    });
    notifyCommandHistoryChanged();
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const entries = readPreviewEntries();
  const existing = entries.find(
    (item) => item.scope === entry.scope && item.command === text,
  );
  if (existing) {
    existing.hostName = entry.hostName;
    existing.hostAddress = entry.hostAddress;
    existing.useCount += 1;
    existing.lastUsedAt = now;
  } else {
    entries.unshift({
      id: crypto.randomUUID(),
      scope: entry.scope,
      hostName: entry.hostName,
      hostAddress: entry.hostAddress,
      command: text,
      useCount: 1,
      lastUsedAt: now,
    });
  }
  entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  writePreviewEntries(entries);
  notifyCommandHistoryChanged();
}

export async function deleteCommandHistory(
  id: string,
  allScopes = false,
): Promise<void> {
  if (desktop) {
    await command("command_history_delete", { id, allScopes });
    notifyCommandHistoryChanged();
    return;
  }
  const entries = readPreviewEntries();
  if (allScopes) {
    const target = entries.find((item) => item.id === id);
    if (target) {
      writePreviewEntries(
        entries.filter((item) => item.command !== target.command),
      );
      notifyCommandHistoryChanged();
      return;
    }
  }
  writePreviewEntries(entries.filter((item) => item.id !== id));
  notifyCommandHistoryChanged();
}

export function filterCommandSuggestions(
  entries: CommandHistoryEntry[],
  input: string,
  currentScope: string,
  limit = 6,
  presets: Array<{ command: string; description?: string }> = [],
): CommandSuggestion[] {
  const queryRaw = input.trimStart();
  const queryTrimmed = queryRaw.trim();
  if (!queryTrimmed || limit <= 0) return [];
  const prefixNeedle = queryRaw.toLowerCase();
  const containsNeedle = queryTrimmed.toLowerCase();
  const tokens = containsNeedle.split(/\s+/).filter(Boolean);

  function matchKind(cmd: string): "prefix" | "contains" | null {
    if (!cmd || cmd === queryRaw || cmd === queryTrimmed || cmd.trim() === queryTrimmed) {
      return null;
    }
    const cmdLower = cmd.toLowerCase();
    if (cmdLower.startsWith(prefixNeedle)) return "prefix";
    if (
      cmdLower.includes(containsNeedle) ||
      (tokens.length > 1 && tokens.every((token) => cmdLower.includes(token)))
    ) {
      return "contains";
    }
    return null;
  }

  const deduped = new Map<string, CommandSuggestion>();
  for (const entry of entries) {
    const cmd = entry.command;
    const kind = matchKind(cmd);
    if (!kind) continue;

    const sameScope = entry.scope === currentScope;
    const candidate: CommandSuggestion = {
      ...entry,
      source: "history",
      matchType: kind,
      sameScope,
    };
    const existing = deduped.get(cmd);
    if (!existing) {
      deduped.set(cmd, candidate);
    } else if (
      (!existing.sameScope && candidate.sameScope) ||
      (existing.sameScope === candidate.sameScope &&
        candidate.lastUsedAt > existing.lastUsedAt)
    ) {
      deduped.set(cmd, candidate);
    }
  }

  for (const preset of presets) {
    const cmd = preset.command;
    const kind = matchKind(cmd);
    if (!kind || deduped.has(cmd)) continue;
    deduped.set(cmd, {
      id: `preset:${cmd}`,
      scope: "preset",
      hostName: "常用命令",
      hostAddress: "",
      command: cmd,
      useCount: 0,
      lastUsedAt: 0,
      source: "preset",
      description: preset.description,
      matchType: kind,
      sameScope: false,
    });
  }

  return [...deduped.values()]
    .sort((a, b) => {
      if (a.matchType !== b.matchType) {
        return a.matchType === "prefix" ? -1 : 1;
      }
      if (a.source !== b.source) {
        return a.source === "history" ? -1 : 1;
      }
      if (a.sameScope !== b.sameScope) {
        return a.sameScope ? -1 : 1;
      }
      if (b.lastUsedAt !== a.lastUsedAt) {
        return b.lastUsedAt - a.lastUsedAt;
      }
      return b.useCount - a.useCount;
    })
    .slice(0, limit);
}

export function formatHistoryTime(epochSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return "昨天";
  const date = new Date(epochSeconds * 1000);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
