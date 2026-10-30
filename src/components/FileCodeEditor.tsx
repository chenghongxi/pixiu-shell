import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";

type DiffRow = {
  type: "same" | "add" | "del";
  left?: string;
  right?: string;
  leftNo?: number;
  rightNo?: number;
};

function zipDiff(a: string[], b: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const n = Math.max(a.length, b.length);
  let leftNo = 1;
  let rightNo = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) {
      rows.push({
        type: "same",
        left: a[i],
        right: b[i],
        leftNo: leftNo++,
        rightNo: rightNo++,
      });
    } else if (a[i] == null) {
      rows.push({ type: "add", right: b[i], rightNo: rightNo++ });
    } else if (b[i] == null) {
      rows.push({ type: "del", left: a[i], leftNo: leftNo++ });
    } else {
      rows.push({ type: "del", left: a[i], leftNo: leftNo++ });
      rows.push({ type: "add", right: b[i], rightNo: rightNo++ });
    }
  }
  return rows;
}

function diffLines(original: string, current: string): DiffRow[] {
  const a = original.split("\n");
  const b = current.split("\n");
  if (a.length * b.length > 400000) return zipDiff(a, b);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let leftNo = 1;
  let rightNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({
        type: "same",
        left: a[i],
        right: b[j],
        leftNo: leftNo++,
        rightNo: rightNo++,
      });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", left: a[i], leftNo: leftNo++ });
      i += 1;
    } else {
      rows.push({ type: "add", right: b[j], rightNo: rightNo++ });
      j += 1;
    }
  }
  while (i < n) rows.push({ type: "del", left: a[i++], leftNo: leftNo++ });
  while (j < m) rows.push({ type: "add", right: b[j++], rightNo: rightNo++ });
  return rows;
}

function DiffPane({
  title,
  side,
  rows,
  scrollRef,
  onScroll,
}: {
  title: string;
  side: "left" | "right";
  rows: DiffRow[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  return (
    <div className="file-diff__pane">
      <header>{title}</header>
      <div
        ref={scrollRef}
        className="file-diff__scroll"
        onScroll={onScroll}
      >
        {rows.map((row, index) => {
          const empty =
            side === "left" ? row.type === "add" : row.type === "del";
          const text = side === "left" ? row.left : row.right;
          const number = side === "left" ? row.leftNo : row.rightNo;
          return (
            <div
              key={`${side}-${index}`}
              className={[
                "file-diff__line",
                empty
                  ? "file-diff__line--gap"
                  : `file-diff__line--${row.type}`,
              ].join(" ")}
            >
              <span className="file-diff__n">{number || ""}</span>
              <pre>{text ?? " "}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FileCodeEditor({
  value,
  original,
  fileName,
  onChange,
  onSave,
}: {
  value: string;
  original?: string;
  fileName: string;
  onChange: (value: string) => void;
  onSave?: () => void;
}) {
  const [wrap, setWrap] = useState(true);
  const [full, setFull] = useState(false);
  const [compare, setCompare] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const leftScroll = useRef<HTMLDivElement>(null);
  const rightScroll = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const lines = useMemo(() => {
    const count = value.split("\n").length;
    let text = "1";
    for (let i = 2; i <= count; i++) text += `\n${i}`;
    return { count, text };
  }, [value]);
  const diff = useMemo(
    () =>
      compare && original !== undefined ? diffLines(original, value) : [],
    [compare, original, value],
  );
  const changed = diff.filter((row) => row.type !== "same").length;

  useEffect(() => {
    function onFull() {
      setFull(document.fullscreenElement === shell.current);
    }
    document.addEventListener("fullscreenchange", onFull);
    return () => document.removeEventListener("fullscreenchange", onFull);
  }, []);

  function syncScroll() {
    if (gutter.current && area.current)
      gutter.current.scrollTop = area.current.scrollTop;
  }

  function syncDiff(source: "left" | "right") {
    const from = source === "left" ? leftScroll.current : rightScroll.current;
    const to = source === "left" ? rightScroll.current : leftScroll.current;
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  async function copyAll() {
    if (!value) {
      toast.warning("暂无内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success("已复制");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function download() {
    if (!value) {
      toast.warning("暂无内容");
      return;
    }
    const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "file.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function toggleFull() {
    const node = shell.current;
    if (!node) return;
    try {
      if (document.fullscreenElement === node) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      setFull((current) => !current);
    }
  }

  return (
    <div
      ref={shell}
      className={[
        "file-code-editor",
        full ? "file-code-editor--full" : "",
        compare ? "file-code-editor--compare" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="file-code-editor__actions">
        <span className="file-code-editor__meta">
          {compare
            ? changed
              ? `${changed} 处不同`
              : "内容相同"
            : `${lines.count} 行`}
        </span>
        {original !== undefined ? (
          <button
            type="button"
            className={compare ? "host-link is-on" : "host-link"}
            aria-pressed={compare}
            onClick={() => setCompare((current) => !current)}
          >
            {compare ? "返回编辑" : "对比"}
          </button>
        ) : null}
        <button type="button" className="host-link" onClick={() => void copyAll()}>
          复制
        </button>
        <button type="button" className="host-link" onClick={() => void toggleFull()}>
          {full ? "退出全屏" : "全屏"}
        </button>
        {compare ? null : (
          <label className="file-code-editor__wrap">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
            换行
          </label>
        )}
        <button
          type="button"
          className="host-link file-code-editor__download"
          title="下载"
          aria-label="下载"
          onClick={download}
        >
          <Download />
        </button>
      </div>
      {compare && original !== undefined ? (
        <div className="file-diff">
          <DiffPane
            title="原始"
            side="left"
            rows={diff}
            scrollRef={leftScroll}
            onScroll={() => syncDiff("left")}
          />
          <DiffPane
            title="当前"
            side="right"
            rows={diff}
            scrollRef={rightScroll}
            onScroll={() => syncDiff("right")}
          />
        </div>
      ) : (
        <div className="file-code-editor__body">
          {wrap ? null : (
            <pre ref={gutter} className="file-code-editor__gutter" aria-hidden>
              {lines.text}
            </pre>
          )}
          <textarea
            ref={area}
            value={value}
            spellCheck={false}
            wrap={wrap ? "soft" : "off"}
            aria-label={`编辑 ${fileName}`}
            onScroll={syncScroll}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                const el = event.currentTarget;
                const start = el.selectionStart;
                const end = el.selectionEnd;
                onChange(`${value.slice(0, start)}\t${value.slice(end)}`);
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = start + 1;
                });
                return;
              }
              if ((event.ctrlKey || event.metaKey) && event.key === "s") {
                event.preventDefault();
                onSave?.();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
