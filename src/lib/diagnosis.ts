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
    commands: (value.commands ?? [])
      .filter((x: unknown): x is string => typeof x === "string")
      .slice(0, 3),
  };
}
// Automatic collection only supports a small, non-mutating command grammar.
// Validate each simple pipeline stage; command substitution and redirections stay blocked.
export function isAutomaticReadOnly(value: string): boolean {
  if (
    !value ||
    value.length > 1000 ||
    /[;&`$<>\\\r\n()]/.test(value) ||
    /\b(?:-exec|-delete|-ok|-i|--interactive|--remove)\b/.test(value)
  )
    return false;
  const allowed = new Set([
    "hostname",
    "whoami",
    "uname",
    "uptime",
    "df",
    "du",
    "free",
    "ls",
    "lsblk",
    "ps",
    "ss",
    "vmstat",
    "iostat",
    "ip",
    "systemctl",
    "journalctl",
    "cat",
    "grep",
    "head",
    "tail",
    "sort",
    "uniq",
    "wc",
    "mount",
    "lsof",
    "docker",
    "podman",
  ]);
  return value
    .split("|")
    .map((part) => part.trim())
    .every((part) => {
      const words = part.split(/\s+/);
      const program = words[0];
      if (!allowed.has(program)) return false;
      if (program === "hostname" || program === "whoami")
        return words.length === 1;
      if (program === "systemctl")
        return ["status", "is-active", "is-failed", "list-units"].includes(
          words[1],
        );
      if (program === "journalctl")
        return (
          words.includes("--no-pager") &&
          words.some((x) => x === "-n" || x.startsWith("--lines=")) &&
          !words.some(
            (x) =>
              /vacuum|rotate|flush|sync|follow|setup|update/.test(x) ||
              x === "-f",
          )
        );
      if (program === "ip")
        return /^ip (?:-(?:br|o|4|6) )?(?:(?:addr|address|link)(?: show)?(?: dev [a-zA-Z0-9_.-]+)?|route(?: show| get [a-zA-Z0-9.:]+)?)$/.test(
          part,
        );
      if (program === "ss")
        return words.slice(1).every((word) => /^-[tulnpanroes46]+$/.test(word));
      if (program === "ps")
        return words
          .slice(1)
          .every(
            (word) =>
              /^-[a-zA-Z0-9,]+$/.test(word) ||
              /^(?:--no-headers|--forest)$/.test(word) ||
              /^--sort=-?[a-zA-Z%_]+$/.test(word) ||
              /^[a-zA-Z_%]+(?:,[a-zA-Z_%]+)*$/.test(word),
          );
      if (program === "docker" || program === "podman")
        return words
          .slice(1)
          .every(
            (word) =>
              /^(?:ps|images|inspect|info|version|stats|top)$/.test(word) ||
              /^--(?:all|no-trunc|filter|format|quiet|latest|size)(?:=.*)?$/.test(
                word,
              ) ||
              /^-[-a-zA-Z0-9]+$/.test(word) ||
              /^[a-zA-Z0-9_.:/=-]+$/.test(word),
          );
      if (["head", "tail", "grep", "sort", "uniq", "wc"].includes(program))
        return words
          .slice(1)
          .every(
            (word) =>
              /^-[a-zA-Z]+$/.test(word) ||
              /^--[a-z-]+(?:=[a-zA-Z0-9_.%-]+)?$/.test(word) ||
              /^\d+$/.test(word) ||
              /^[a-zA-Z0-9_.%/-]+$/.test(word),
          );
      return true;
    });
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
