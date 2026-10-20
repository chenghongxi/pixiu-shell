import { useRef, useState } from "react";
import { ChevronDown, Send, TerminalSquare, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { errorMessage } from "@/lib/api";
export function BatchCommand({
  windows,
  onExecute,
  onClose,
}: {
  windows: { id: string; name: string }[];
  onExecute: (id: string, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [results, setResults] = useState<
    { id: string; name: string; error?: string }[]
  >([]);
  const targets = windows.filter(
    (window) => all || selected.includes(window.id),
  );
  async function execute() {
    if (sending.current || !text.trim() || !targets.length) return;
    sending.current = true;
    setBusy(true);
    setResults([]);
    const value = text,
      snapshot = [...targets];
    try {
      const results = await Promise.all(
        snapshot.map(async (window) => {
          try {
            await onExecute(window.id, value);
            return { ...window };
          } catch (error) {
            return { ...window, error: errorMessage(error) };
          }
        }),
      );
      setResults(results);
      setText("");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const failed = results.filter((result) => result.error);
  return (
    <section className="batch-command-bar" aria-label="批量命令栏">
      <div className="batch-command-scope">
        <details className="batch-targets">
          <summary>
            <TerminalSquare />
            <strong>{all ? "全部窗口" : "指定窗口"}</strong>
            <span>
              {targets.length} / {windows.length}
            </span>
            <ChevronDown />
          </summary>
          <div className="batch-target-picker">
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={all}
                onChange={(event) => {
                  setAll(event.target.checked);
                  setSelected([]);
                }}
              />
              全部窗口（包含新建窗口）
            </label>
            {windows.map((window) => (
              <label key={window.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={all || selected.includes(window.id)}
                  onChange={(event) => {
                    const current = all
                      ? windows.map((item) => item.id)
                      : selected;
                    setAll(false);
                    setSelected(
                      event.target.checked
                        ? [...new Set([...current, window.id])]
                        : current.filter((id) => id !== window.id),
                    );
                  }}
                />
                {window.name}
              </label>
            ))}
            {!windows.length ? <p>打开 SSH 终端后即可批量执行</p> : null}
          </div>
        </details>
        <span className="batch-command-hint">
          Enter 执行到{all ? "全部" : "选中的"} {targets.length} 个终端
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="收起批量命令"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <form
        className="batch-command-input"
        onSubmit={(event) => {
          event.preventDefault();
          void execute();
        }}
      >
        <span aria-hidden="true">$</span>
        <Input
          autoFocus
          aria-label="批量命令"
          placeholder={
            targets.length ? "输入命令，回车批量执行…" : "请先打开 SSH 终端"
          }
          value={text}
          disabled={busy || !targets.length}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.nativeEvent.isComposing || event.keyCode === 229)
            )
              event.preventDefault();
          }}
          maxLength={4000}
        />
        <Button
          type="submit"
          size="icon-sm"
          aria-label={`执行到 ${targets.length} 个窗口`}
          title="回车执行"
          disabled={busy || !targets.length || !text.trim()}
        >
          <Send />
        </Button>
      </form>
      <div className="batch-command-result" aria-live="polite">
        {busy
          ? "正在发送…"
          : results.length
            ? `已发送 ${results.length - failed.length} / ${results.length} · 输出见对应终端`
            : "命令输出保留在各终端中"}
        {failed.length ? (
          <details>
            <summary>{failed.length} 个窗口发送失败</summary>
            {failed.map((result) => (
              <p key={result.id}>
                {result.name}：{result.error}
              </p>
            ))}
          </details>
        ) : null}
      </div>
    </section>
  );
}
