export interface Decision {
  done: boolean;
  reason?: string;
  conclusion?: string;
  commands: string[];
}
export function parseDecision(raw: string): Decision {
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  const value = JSON.parse(raw.slice(start, end + 1));
  if (
    typeof value.done !== "boolean" ||
    (!value.done && !Array.isArray(value.commands))
  )
    throw new Error("AI 返回的排查步骤格式无效");
  return {
    done: value.done,
    reason: String(value.reason ?? ""),
    conclusion: String(value.conclusion ?? ""),
    commands: (Array.isArray(value.commands) ? value.commands : [])
      .filter((x: unknown): x is string => typeof x === "string")
      .map((command: string) => {
        const trimmed = command.trim();
        const fenced = trimmed.match(/^```(?:bash|sh|shell)?[ \t]*\r?\n([^\r\n]+)\r?\n```$/i);
        return fenced ? fenced[1].trim() : trimmed;
      })
      .slice(0, 3),
  };
}
export function hasDiagnosticPrompt(raw: string): boolean {
  /* oxlint-disable eslint/no-control-regex */
  const text = raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n");
  /* oxlint-enable eslint/no-control-regex */
  const line = text.slice(text.lastIndexOf("\n") + 1).trimEnd();
  return /(?:^|\s)[\w.-]+@[\w.-]+:\s*(?:\/|~)[^\s]*?[#$%]\s*$/.test(line) ||
    /(?:^|\s)(?:\/|~)[^\s]*?\s*[#$%]\s*$/.test(line) ||
    /(?:^|\s)(?:➜|❯)\s+[~/.][^\s]*\s*$/u.test(line);
}
// Keep this text beside the checker. The diagnose prompt is the only copy the model sees.
export const readOnlyCommandPolicy =
  "只允许这些只读命令：hostname、whoami、uptime、uname 加可选的 -[asnrvmo]、df 加可选的 -[hTi]、free 加可选的 -[hbmkg]、lsblk 加可选的 -[abdfilmnoPrst]、ps aux、ps -ef、ss 加可选的 -[tulnpanroes46]、ip 可选 -br 再加 addr、address、link 或 route 以及可选的 show、systemctl is-active 或 is-failed 加服务名、systemctl status --no-pager 加服务名、journalctl --no-pager -n 1到100 -u 加服务名、docker ps 或 docker container ls 可选 -a 或 --all、docker stats --no-stream、grep 可选 -[iv] 加一个不含空格的词、head 或 tail 可选 -n 1到100、wc -l、sort、uniq。可以用 |、&&、||、; 组合，最多 19 段。只允许重定向 2>&1、2>/dev/null、>/dev/null，且重定向前后有空格。不要使用引号、变量、通配符、括号、反斜杠或其他重定向。";
export function isAutomaticReadOnly(value: string): boolean {
  if (!value || value.length > 2000 || /[\r\n'"`$\\(){}[\]*?!#]/.test(value))
    return false;
  // Only allow output to be discarded or stderr to be merged into stdout.
  const stripped = value.replace(/(?:^|\s)(?:2>&1|2?>\s*\/dev\/null)(?=\s|$)/g, " ");
  if (/[<>]/.test(stripped)) return false;
  const parts = stripped.split(/(\|\||&&|[|;])/);
  if (parts.length > 19 || parts.some((part) => !part.trim())) return false;
  const commands = parts.filter((_, index) => index % 2 === 0);
  const allowed = [
    /^(?:hostname|whoami|uptime)$/,
    /^uname(?: -[asnrvmo]+)?$/,
    /^df(?: -[hTi]+)?$/,
    /^free(?: -[hbmkg]+)?$/,
    /^lsblk(?: -[abdfilmnoPrst]+)?$/,
    /^ps (?:aux|-ef)$/,
    /^ss(?: -[tulnpanroes46]+)?$/,
    /^ip (?:-br )?(?:addr|address|link|route)(?: show)?$/,
    /^systemctl (?:is-active|is-failed) [A-Za-z0-9_.@-]+$/,
    /^systemctl status --no-pager [A-Za-z0-9_.@-]+$/,
    /^journalctl --no-pager -n (?:[1-9]|[1-9][0-9]|100) -u [A-Za-z0-9_.@-]+$/,
    /^docker (?:ps|container ls)(?: -a| --all)?$/,
    /^docker stats --no-stream$/,
    /^grep(?: -[iv]+)? [A-Za-z0-9_.:/@-][A-Za-z0-9_.:/@-]*$/,
    /^(?:head|tail)(?: -n (?:[1-9]|[1-9][0-9]|100))?$/,
    /^wc -l$/,
    /^(?:sort|uniq)$/,
  ];
  return commands.every((command) =>
    allowed.some((pattern) => pattern.test(command.trim().replace(/\s+/g, " "))),
  );
}
// Strip ANSI on the assembled stream, not individual transport chunks.
export function cleanDiagnosticOutput(raw: string, command: string): string {
  /* oxlint-disable eslint/no-control-regex */
  const text = raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // oxlint-disable-next-line eslint/no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n");
  /* oxlint-enable eslint/no-control-regex */
  const lines = text.split("\n");
  const prompt = /^\s*(?:\[[^\]]*\]\s*)?[\w.-]+@[\w.-]+:[^\n]*?[$#]\s*/;
  while (
    lines.length &&
    (!lines[0].trim() ||
      lines[0].trim() === command.trim() ||
      (prompt.test(lines[0]) &&
        lines[0].replace(prompt, "").trim() === command.trim()))
  )
    lines.shift();
  while (
    lines.length &&
    (!lines.at(-1)!.trim() ||
      (prompt.test(lines.at(-1)!) && !lines.at(-1)!.replace(prompt, "").trim()))
  )
    lines.pop();
  return lines.join("\n").trim().slice(-12000) || "（命令未返回文本输出）";
}
