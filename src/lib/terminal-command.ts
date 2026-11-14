import type { Terminal } from "@xterm/xterm";

export interface ShellInputState {
  prompt: string;
  commandBeforeCursor: string;
  fullCommand: string;
  atEnd: boolean;
}

const PROMPT_PATTERNS = [
  /^(?:\([^)]+\)\s*)?(?:\[[^\]]*\]\s*)?[\w.-]+@[\w.-]+:[^#$%]*[#$%]\s?/,
  /^(?:\([^)]+\)\s*)?\[[\w.-]+@[\w.-]+\s+[^\]]*\][#$%]\s?/,
  /^PS\s+[A-Za-z]:\\[^>]*>\s?/i,
  /^[A-Za-z]:\\[^>]*>\s?/,
  /^(?:➜|❯)\s+(?:[~/.][^\s]*\s+)?/u,
  /^(?:bash|zsh|sh|ash|fish)(?:-[\d.]+)?[#$%]\s?/,
  /^[\w.-]+:[~/.][^\s]*[#$%]\s?/,
];

function matchShellPrompt(line: string): string {
  for (const pattern of PROMPT_PATTERNS) {
    const match = line.match(pattern);
    if (match) return match[0];
  }
  return "";
}

function readLogicalCursorLine(
  terminal: Pick<Terminal, "buffer">,
  includeCursorSplit: boolean,
) {
  const buffer = terminal.buffer.active;
  const cursor = buffer.baseY + buffer.cursorY;
  let start = cursor;
  let end = cursor;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;

  let textBeforeCursor = "";
  let textAfterCursor = "";
  const cursorX =
    includeCursorSplit && typeof buffer.cursorX === "number"
      ? buffer.cursorX
      : undefined;
  for (let index = start; index <= end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index < cursor) {
      textBeforeCursor += line.translateToString(false);
    } else if (index === cursor) {
      if (cursorX === undefined) {
        textBeforeCursor += line.translateToString(index === end);
      } else {
        textBeforeCursor += line.translateToString(false, 0, cursorX);
        textAfterCursor += line.translateToString(index === end, cursorX);
      }
    } else {
      textAfterCursor += line.translateToString(index === end);
    }
  }
  return {
    bufferType: buffer.type,
    textBeforeCursor,
    textAfterCursor,
    fullText: textBeforeCursor + textAfterCursor,
  };
}

export function extractShellInputState(
  terminal: Pick<Terminal, "buffer">,
): ShellInputState | null {
  const { bufferType, textBeforeCursor, textAfterCursor, fullText } =
    readLogicalCursorLine(terminal, true);
  if (bufferType && bufferType !== "normal") return null;
  const prompt = matchShellPrompt(fullText);
  if (!prompt || textBeforeCursor.length < prompt.length) return null;
  return {
    prompt,
    commandBeforeCursor: textBeforeCursor.slice(prompt.length),
    fullCommand: fullText.slice(prompt.length),
    atEnd: textAfterCursor.length === 0,
  };
}

// Read the complete logical line, including wrapped rows after the cursor.
export function visibleShellCommand(
  terminal: Pick<Terminal, "buffer">,
): string {
  const { fullText } = readLogicalCursorLine(terminal, false);
  const prompt = matchShellPrompt(fullText);
  if (!prompt) return "";
  return fullText.slice(prompt.length).trim();
}

export function visibleShellPrompt(terminal: Pick<Terminal, "buffer">): string {
  const buffer = terminal.buffer.active;
  const cursor = buffer.baseY + buffer.cursorY;
  let start = cursor;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let text = "";
  for (let index = start; index <= cursor; index++)
    text += buffer.getLine(index)?.translateToString(index === cursor) ?? "";
  const line = text.trimEnd();
  const bash = line.match(
    /(?:^|\s)([\w.-]+@[\w.-]+):\s*((?:\/|~)[^\s]*?)[#$%]\s*$/,
  );
  if (bash) return `${bash[1]}:${bash[2]}`;
  const powershell = line.match(/\bPS\s+(.+?)>\s*$/i);
  if (powershell) return `PS ${powershell[1]}`;
  const cmd = line.match(/(?:^|\s)([A-Za-z]:\\[^>]*?)>\s*$/);
  if (cmd) return cmd[1];
  const zsh = line.match(/(?:^|\s)(?:➜|❯)\s+([~/.][^\s]*)\s*$/u);
  if (zsh) return zsh[1];
  const pathPrompt = line.match(
    /(?:^|\s)((?:\/|~|[A-Za-z]:\\)[^\s]*?)\s*[#$%>]\s*$/,
  );
  return pathPrompt?.[1] ?? "";
}

export function cleanTerminalTitle(title: string): string {
  const clean = Array.from(title, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 96 ? `${clean.slice(0, 93)}...` : clean;
}
