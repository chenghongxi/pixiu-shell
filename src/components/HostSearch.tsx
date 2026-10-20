import { useId, useState } from "react";
import { Search, Server, TerminalSquare, ArrowUpRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { SearchInput } from "./ui/input";
import type { Host } from "@/lib/api";
export function HostSearch({
  hosts,
  sessions,
  onClose,
  onHost,
  onSession,
}: {
  hosts: Host[];
  sessions: { id: string; name: string; host: Host }[];
  onClose: () => void;
  onHost: (host: Host) => void;
  onSession: (id: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [index, setIndex] = useState(0);
  const id = useId();
  const match = (host: Host, name: string) =>
    [
      name,
      host.address,
      ...(host.searchAddresses ?? []),
      ...(host.groupPaths ?? [host.group]),
      ...host.tags,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const entries = [
    ...sessions
      .filter((session) => match(session.host, session.name))
      .map((session) => ({
        key: `session:${session.id}`,
        kind: "session",
        name: session.name,
        host: session.host,
        select: () => onSession(session.id),
      })),
    ...hosts
      .filter((host) => match(host, host.name))
      .map((host) => ({
        key: `host:${host.mode}:${host.id}`,
        kind: "host",
        name: host.name,
        host,
        select: () => onHost(host),
      })),
  ];
  const selected = Math.min(index, Math.max(0, entries.length - 1));
  function pick(position: number) {
    const entry = entries[position];
    if (entry) {
      onClose();
      entry.select();
    }
  }
  function move(next: number) {
    const position = (next + entries.length) % entries.length;
    setIndex(position);
    document
      .getElementById(`${id}-${position}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="host-search-dialog"
        style={{
          position: "fixed",
          top: 24,
          right: "auto",
          bottom: 24,
          left: "50%",
          width: "min(700px, calc(100vw - 56px))",
          maxWidth: "min(700px, calc(100vw - 56px))",
          height: "auto",
          maxHeight: "calc(100dvh - 48px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transform: "translateX(-50%)",
          translate: "none",
          zIndex: 100,
        }}
        showCloseButton={false}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">搜索主机与终端</DialogTitle>
        <DialogDescription className="sr-only">
          输入主机名、IP、分组或标签，方向键选择，回车连接主机或切换已有终端。
        </DialogDescription>
        <div className="host-search-input">
          <Search />
          <SearchInput
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-results`}
            aria-activedescendant={
              entries.length ? `${id}-${selected}` : undefined
            }
            aria-autocomplete="list"
            aria-label="搜索主机与终端"
            placeholder="搜索主机、IP、标签或已打开的终端…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (entries.length)
                  move(selected + (event.key === "ArrowDown" ? 1 : -1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                pick(selected);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div
          className="host-search-results"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            maxHeight: "none",
            overflowY: "auto",
          }}
          role="listbox"
          id={`${id}-results`}
          aria-label="搜索结果"
        >
          {entries.map((entry, i) => (
            <div key={entry.key}>
              {i === 0 || entries[i - 1].kind !== entry.kind ? (
                <div className="host-search-section">
                  {entry.kind === "session" ? "已打开的终端" : "主机"}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={`${id}-${i}`}
                aria-selected={i === selected}
                className="host-search-result"
                onMouseMove={() => setIndex(i)}
                onClick={() => pick(i)}
              >
                <span className={`host-search-symbol ${entry.kind}`}>
                  {entry.kind === "session" ? <TerminalSquare /> : <Server />}
                </span>
                <span>
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.host.address} · {entry.host.group}
                  </small>
                </span>
                <em>
                  {entry.kind === "session"
                    ? "切换终端"
                    : entry.host.mode === "platform"
                      ? "平台主机"
                      : "离线主机"}
                </em>
                <ArrowUpRight />
              </button>
            </div>
          ))}
          {!entries.length ? (
            <p className="host-search-empty">没有匹配的主机或终端</p>
          ) : null}
        </div>
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>选择
          </span>
          <span>
            <kbd>Enter</kbd>连接 / 切换
          </span>
          <small>{entries.length} 个结果</small>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
