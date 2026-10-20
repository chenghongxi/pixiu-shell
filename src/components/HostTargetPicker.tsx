import { useState } from "react";
import { Search, Server, ListFilter } from "lucide-react";
import { Button } from "./ui/button";
import { SearchInput } from "./ui/input";
import { Choice } from "./Choice";
import type { Host } from "@/lib/api";
export function HostTargetPicker({
  hosts,
  selected,
  onChange,
  disabled,
}: {
  hosts: Host[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState(""),
    [group, setGroup] = useState("all"),
    [tag, setTag] = useState("all"),
    [selectedOnly, setSelectedOnly] = useState(false);
  const paths = (host: Host) => host.groupPaths ?? [host.group];
  const groups = [
    ...new Set(
      hosts.flatMap((host) =>
        paths(host).flatMap((path) =>
          path.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")),
        ),
      ),
    ),
  ].sort();
  const tags = [...new Set(hosts.flatMap((host) => host.tags))].sort();
  const visible = hosts.filter(
    (host) =>
      (!selectedOnly || selected.includes(host.id)) &&
      (group === "all" ||
        paths(host).some(
          (path) =>
            path === group.slice(2) || path.startsWith(`${group.slice(2)}/`),
        )) &&
      (tag === "all" || host.tags.includes(tag.slice(2))) &&
      [
        host.name,
        host.address,
        ...(host.searchAddresses ?? []),
        ...paths(host),
        ...host.tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const hiddenCount = selected.filter(
    (id) => !visible.some((host) => host.id === id),
  ).length;
  const missing = selected.filter(
    (id) => !hosts.some((host) => host.id === id),
  );
  return (
    <aside className="script-targets" aria-label="脚本目标主机">
      <header>
        <div>
          <Server />
          <strong>目标主机</strong>
        </div>
        <span>已选 {selected.length}</span>
      </header>
      <div className="target-filters">
        <div className="target-search">
          <Search />
          <SearchInput
            aria-label="搜索目标主机"
            placeholder="搜索名称、IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Choice
          label="按分组筛选目标"
          value={group}
          onChange={setGroup}
          options={[
            { value: "all", label: "全部分组" },
            ...groups.map((group) => ({ value: `g:${group}`, label: group })),
          ]}
        />
        <Choice
          label="按标签筛选目标"
          value={tag}
          onChange={setTag}
          options={[
            { value: "all", label: "全部标签" },
            ...tags.map((tag) => ({ value: `t:${tag}`, label: tag })),
          ]}
        />
        <div className="target-selection-actions">
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || !visible.length}
            onClick={() =>
              onChange([
                ...new Set([...selected, ...visible.map((host) => host.id)]),
              ])
            }
          >
            全选筛选结果
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || !visible.length}
            onClick={() =>
              onChange(
                selected.filter(
                  (id) => !visible.some((host) => host.id === id),
                ),
              )
            }
          >
            取消筛选结果
          </Button>
        </div>
      </div>
      <div className="target-list">
        {visible.map((host) => (
          <label
            key={host.id}
            className="target-host"
            data-selected={selected.includes(host.id)}
          >
            <input
              type="checkbox"
              disabled={disabled}
              aria-label={`${host.name} · ${host.address}`}
              checked={selected.includes(host.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, host.id]
                    : selected.filter((id) => id !== host.id),
                )
              }
            />
            <span>
              <strong>{host.name}</strong>
              <small>{host.address}</small>
              <em title={paths(host).join(" · ")}>{paths(host).join(" · ")}</em>
              {host.tags.length ? (
                <span className="target-tags">
                  {host.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </span>
              ) : null}
            </span>
          </label>
        ))}
        {!visible.length ? (
          <div className="target-empty">
            <ListFilter />
            <p>没有匹配的主机</p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setSearch("");
                setGroup("all");
                setTag("all");
                setSelectedOnly(false);
              }}
            >
              清除筛选
            </Button>
          </div>
        ) : null}
      </div>
      <footer>
        <span>
          匹配 {visible.length} 台
          {hiddenCount ? ` · 筛选外已选 ${hiddenCount}` : ""}
        </span>
        <Button
          variant={selectedOnly ? "secondary" : "ghost"}
          size="xs"
          onClick={() => setSelectedOnly((value) => !value)}
        >
          {selectedOnly ? "显示全部" : "仅看已选"}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled || !selected.length}
          onClick={() => onChange([])}
        >
          清空选择
        </Button>
        {missing.length ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange(selected.filter((id) => !missing.includes(id)))
            }
          >
            移除 {missing.length} 个不可用目标
          </Button>
        ) : null}
      </footer>
    </aside>
  );
}
