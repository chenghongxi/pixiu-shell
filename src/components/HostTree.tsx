import { ArrowRight, ChevronDown, Tag, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Host } from "@/lib/api";
import { ObjectStorageFolderIcon } from "./ObjectStorageFolderIcon";
interface Branch {
  path: string;
  label: string;
  hosts: Host[];
  children: Map<string, Branch>;
}
type DragItem = { kind: "host"; host: Host } | { kind: "group"; path: string };
export function HostTree({
  groups,
  prefix,
  expanded,
  onExpand,
  selected,
  onSelect,
  onGroupSelect,
  onConnect,
  onGroupContextMenu,
  onHostContextMenu,
  onRootContextMenu,
  onHostDrop,
  onGroupDrop,
  tags,
}: {
  groups: Map<string, Host[]>;
  prefix: string;
  expanded: ReadonlySet<string>;
  onExpand: (key: string) => void;
  selected: string | null;
  onSelect: (host: Host) => void;
  onGroupSelect?: (path: string) => void;
  onConnect: (host: Host) => void;
  onGroupContextMenu?: (path: string, event: MouseEvent<HTMLElement>) => void;
  onHostContextMenu?: (host: Host, event: MouseEvent<HTMLElement>) => void;
  onRootContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  onHostDrop?: (host: Host, group: string) => void;
  onGroupDrop?: (source: string, target: string) => void;
  tags: boolean;
}) {
  const [draggingItem, setDraggingItem] = useState<DragItem | null>(null);
  const pointerDrag = useRef<
    | { item: DragItem; startX: number; startY: number; dragging: boolean }
    | null
  >(null);
  const suppressClick = useRef(false);
  const suppressGroupClick = useRef(false);
  const dropGroupRef = useRef<string | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  function setDropTarget(item: DragItem | null, candidate: string | null) {
    const group =
      item?.kind === "group" &&
      candidate &&
      (candidate === item.path || candidate.startsWith(`${item.path}/`))
        ? null
        : candidate;
    if (dropGroupRef.current === group) return;
    dropGroupRef.current = group;
    setDropGroup(group);
  }
  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const current = pointerDrag.current;
      if (!current || tags) return;
      if (
        !current.dragging &&
        Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5
      )
        return;
      if (!current.dragging) {
        current.dragging = true;
        if (current.item.kind === "host") {
          suppressClick.current = true;
          onSelect(current.item.host);
        } else suppressGroupClick.current = true;
        setDraggingItem(current.item);
      }
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-host-tree-group]");
      setDropTarget(current.item, target?.dataset.hostTreeGroup ?? null);
    };
    const onPointerUp = () => {
      const current = pointerDrag.current;
      const target = dropGroupRef.current;
      pointerDrag.current = null;
      dropGroupRef.current = null;
      setDraggingItem(null);
      setDropGroup(null);
      if (
        current?.dragging &&
        target &&
        (current.item.kind === "group" || current.item.host.group !== target)
      )
        current.item.kind === "host"
          ? onHostDrop?.(current.item.host, target)
          : onGroupDrop?.(current.item.path, target);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [onGroupDrop, onHostDrop, onSelect, tags]);
  const roots = new Map<string, Branch>();
  for (const [path, hosts] of groups) {
    const segments = tags ? [path] : path.split("/").filter(Boolean);
    let siblings = roots;
    segments.forEach((label, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let branch = siblings.get(label);
      if (!branch) {
        branch = { path, label, hosts: [], children: new Map() };
        siblings.set(label, branch);
      }
      if (index === segments.length - 1) branch.hosts = hosts;
      siblings = branch.children;
    });
  }
  const count = (branch: Branch): number =>
    branch.hosts.length +
    [...branch.children.values()].reduce((sum, child) => sum + count(child), 0);
  const render = (branch: Branch, depth = 0) => {
    const key = `${prefix}${branch.path}`;
    const open = expanded.has(key);
    return (
      <details
        key={key}
        open={open}
        className="host-group"
        data-group-name={branch.path}
        data-depth={depth}
        data-host-tree-group={branch.path}
        data-drop-target={dropGroup === branch.path || undefined}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            if (suppressGroupClick.current) {
              suppressGroupClick.current = false;
              return;
            }
            onGroupSelect?.(branch.path);
            onExpand(key);
          }}
          onPointerDown={(event: PointerEvent<HTMLElement>) => {
            if (event.button !== 0 || tags) return;
            pointerDrag.current = {
              item: { kind: "group", path: branch.path },
              startX: event.clientX,
              startY: event.clientY,
              dragging: false,
            };
          }}
          onPointerEnter={() => {
            const current = pointerDrag.current;
            if (current?.dragging) setDropTarget(current.item, branch.path);
          }}
          onPointerUp={() => {
            const current = pointerDrag.current;
            if (current?.dragging) setDropTarget(current.item, branch.path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onGroupContextMenu?.(branch.path, event);
          }}
        >
          <ChevronDown />
          {tags ? <Tag /> : <ObjectStorageFolderIcon className="storage-folder-icon" />}
          <span>{branch.label}</span>
          <small>{count(branch)}</small>
        </summary>
        <div className="host-group-children">
          {[...branch.children.values()].map((child) => render(child, depth + 1))}
          {branch.hosts.map((host) => (
            <button
              key={host.id}
              className={`host-row${host.id === selected ? " selected" : ""}${draggingItem?.kind === "host" && draggingItem.host.id === host.id ? " dragging" : ""}`}
              onClick={(event) => {
                if (suppressClick.current) {
                  event.preventDefault();
                  suppressClick.current = false;
                  return;
                }
                onSelect(host);
              }}
              onDoubleClick={() => onConnect(host)}
              onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
                if (event.button !== 0 || tags) return;
                pointerDrag.current = {
                  item: { kind: "host", host },
                  startX: event.clientX,
                  startY: event.clientY,
                  dragging: false,
                };
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onHostContextMenu?.(host, event);
              }}
              title={`${host.name}\n${host.address}:${host.port}`}
            >
              <TerminalSquare aria-label="主机" />
              <span>
                <strong>{host.name}</strong>
                <small>{host.address}</small>
              </span>
              <ArrowRight
                className="host-connect-icon"
                role="button"
                tabIndex={0}
                aria-label={`连接 ${host.name}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onConnect(host);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onConnect(host);
                }}
              />
            </button>
          ))}
        </div>
      </details>
    );
  };
  return (
    <div
      className="host-tree-content"
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onRootContextMenu?.(event);
      }}
    >
      {[...roots.values()].map((branch) => render(branch))}
    </div>
  );
}
