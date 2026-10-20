import { ChevronDown, Folder, Tag, KeyRound } from "lucide-react";
import type { Host } from "@/lib/api";
import { HostOsIcon } from "./HostOsIcon";
interface Branch {
  path: string;
  label: string;
  hosts: Host[];
  children: Map<string, Branch>;
}
export function HostTree({
  groups,
  prefix,
  expanded,
  onExpand,
  selected,
  onSelect,
  onGroupSelect,
  onConnect,
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
  tags: boolean;
}) {
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
  const render = (branch: Branch) => {
    const key = `${prefix}${branch.path}`;
    const open = expanded.has(key);
    return (
      <details
        key={key}
        open={open}
        className="host-group"
        data-group-name={branch.path}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            onGroupSelect?.(branch.path);
            onExpand(key);
          }}
        >
          <ChevronDown />
          {tags ? <Tag /> : <Folder />}
          <span>{branch.label}</span>
          <small>{count(branch)}</small>
        </summary>
        {[...branch.children.values()].map(render)}
        {branch.hosts.map((host) => (
          <button
            key={host.id}
            className={`host-row${host.id === selected ? " selected" : ""}`}
            onClick={() => onSelect(host)}
            onDoubleClick={() => onConnect(host)}
            title={`${host.name}\n${host.address}:${host.port}`}
          >
            <HostOsIcon host={host} />
            <span>
              <strong>{host.name}</strong>
              <small>{host.address}</small>
            </span>
            {host.local?.hasPassword ? (
              <KeyRound className="saved-key" />
            ) : null}
          </button>
        ))}
      </details>
    );
  };
  return <>{[...roots.values()].map(render)}</>;
}
