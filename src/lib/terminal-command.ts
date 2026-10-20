import type { Terminal } from "@xterm/xterm";

// Read the complete logical line, including wrapped rows after the cursor.
export function visibleShellCommand(
  terminal: Pick<Terminal, "buffer">,
): string {
  const buffer = terminal.buffer.active;
  const cursor = buffer.baseY + buffer.cursorY;
  let start = cursor;
  let end = cursor;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
  let text = "";
  for (let index = start; index <= end; index++) {
    text += buffer.getLine(index)?.translateToString(index === end) ?? "";
  }
  const prompt = text.match(
    /^(?:\[[^\]]*\]\s*)?[\w.-]+@[\w.-]+:[^#$%]*[#$%]\s?(.*)$/,
  );
  return prompt?.[1]?.trim() ?? "";
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
