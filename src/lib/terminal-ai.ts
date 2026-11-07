export type AiAction =
  | "custom"
  | "chat"
  | "diagnose";
export type ContextScope = "selection" | "recent" | "none";
export interface TerminalContext {
  terminalId: string;
  recentOutput: string;
  selectedText: string;
  currentCommand: string;
  cwd: string;
}
export function scopeTerminalContext(
  context: TerminalContext,
  scope: ContextScope,
): TerminalContext {
  if (scope === "none") {
    return {
      ...context,
      recentOutput: "",
      selectedText: "",
      currentCommand: "",
      cwd: "",
    };
  }
  if (scope === "recent") return { ...context, selectedText: "" };
  return context;
}
export function recentDialogue(
  messages: { role: "user" | "assistant"; content: string; action?: AiAction }[],
  action: AiAction,
): string {
  if (action === "diagnose") return "";
  return messages
    .filter((message) => message.action === action && message.content.trim())
    .slice(-6)
    .map((message) => {
      const speaker = message.role === "user" ? "用户" : "助手";
      return `${speaker}：${redactContext(message.content.trim()).slice(0, 800)}`;
    })
    .join("\n\n")
    .slice(-4000);
}
export interface TerminalHandle {
  focus: () => void;
  context: () => TerminalContext;
  insert: (command: string) => Promise<void>;
  execute: (command: string) => Promise<void>;
  executeAndCapture: (command: string, signal?: AbortSignal) => Promise<string>;
}
export interface AgentEvent {
  eventType: string;
  sequence?: number;
  payload?: {
    content?: string;
    message?: string;
    status?: string;
    errorMessage?: string;
  };
}
export function redactContext(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[私钥已隐藏]",
    )
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|accesskeysecret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=***",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "***")
    .replace(/\b(?:LTAI|AKID)[A-Za-z0-9]{12,}\b/g, "***");
}
export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
}
export function suggestedCommand(content: string): string {
  const fenced = content.match(
    /```(?:bash|sh|shell|zsh|console)\s*\n([\s\S]*?)```/i,
  )?.[1];
  if (!fenced) return "";
  return (
    fenced
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\$\s*/, "").trim())
      .find(
        (line) => line && !line.startsWith("#") && !hasControlCharacters(line),
      ) ?? ""
  );
}
