export function transferCommand(
  line: string,
  upload: string,
  download: string,
): { direction: "upload" | "download"; path: string } | null {
  const match = line.trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match || ![upload, download].includes(match[1])) return null;
  let path = match[2]?.trim() ?? "";
  if (path.startsWith('"') || path.startsWith("'")) {
    if (path.length < 2 || path.at(-1) !== path[0])
      throw new Error("路径引号未闭合");
    path = path.slice(1, -1);
  }
  // oxlint-disable-next-line eslint/no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("路径含非法控制字符");

  return {
    direction: match[1] === upload ? "upload" : "download",
    path: path || ".",
  };
}
