import { Fragment, useEffect, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, type Host, type Target, type Tunnel } from "@/lib/api";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { FileManager } from "./FileManager";
import { HostEditor } from "./HostEditor";

export type HostProfileTab =
  "overview" | "connection" | "auth" | "network" | "files";

const EMPTY = "-";

function authLabel(host: Host) {
  if (!host.local) return "平台凭据";
  if (host.local.identityFile) return "私钥";
  if (host.local.hasPassword) return "已保存密码";
  return "交互 / SSH Agent";
}

function proxyLabel(host: Host) {
  const proxy = host.local?.proxy;
  if (!proxy) return "";
  return proxy.kind === "socks5" ? "SOCKS5" : "HTTP";
}

function tunnelSummary(host: Host) {
  const tunnels = host.local?.tunnels ?? [];
  if (!host.local) return "平台管理";
  return tunnels.length ? `${tunnels.length} 条` : EMPTY;
}

function connectionString(host: Host) {
  const address = host.address || "平台解析";
  return host.local?.username
    ? `${host.local.username}@${address}:${host.port}`
    : `${address}:${host.port}`;
}

function tunnelKind(tunnel: Tunnel) {
  if (tunnel.kind === "local") return "本地转发";
  if (tunnel.kind === "remote") return "远程转发";
  return "动态转发";
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label}已复制`);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

function CopyButton({ label, value }: { label: string; value: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="host-profile-copy"
      aria-label={`复制${label}`}
      title={`复制${label}`}
      onClick={() => void copyText(value, label)}
    >
      <Copy />
    </Button>
  );
}

type InfoCell = {
  label: string;
  value?: string;
  copy?: string;
  empty?: boolean;
  wide?: boolean;
  mono?: boolean;
  content?: ReactNode;
};

function pairCells(cells: InfoCell[]) {
  const rows: InfoCell[][] = [];
  for (let i = 0; i < cells.length;) {
    const cell = cells[i];
    if (cell.wide || i === cells.length - 1 || cells[i + 1]?.wide) {
      rows.push([{ ...cell, wide: true }]);
      i += 1;
    } else {
      rows.push([cell, cells[i + 1]]);
      i += 2;
    }
  }
  return rows;
}

function InfoTable({ cells }: { cells: InfoCell[] }) {
  return (
    <table className="host-profile-kv">
      <colgroup>
        <col className="host-profile-kv__k" />
        <col />
        <col className="host-profile-kv__k" />
        <col />
      </colgroup>
      <tbody>
        {pairCells(cells).map((row, rowIndex) => (
          <tr key={row.map((cell) => cell.label).join("-") + rowIndex}>
            {row.map((cell) => (
              <Fragment key={cell.label}>
                <th>{cell.label}</th>
                <td
                  colSpan={cell.wide ? 3 : undefined}
                  className={[
                    "host-profile-kv__v",
                    cell.mono ? "host-profile-kv__v--mono" : "",
                    cell.empty ? "host-profile-empty" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {cell.content ?? (
                    <>
                      <span title={cell.value}>{cell.value}</span>
                      {cell.copy ? (
                        <CopyButton label={cell.label} value={cell.copy} />
                      ) : null}
                    </>
                  )}
                </td>
              </Fragment>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="host-profile-metric">
      <div className="host-profile-metric__label">{label}</div>
      <div className="host-profile-metric__value" title={value}>
        {value}
      </div>
    </div>
  );
}

export function HostProfile({
  host,
  editing,
  connecting,
  tab,
  fileSession,
  onTabChange,
  onEdit,
  onCancelEdit,
  onSaved,
  onConnect,
  onOpenFiles,
  onCloseFiles,
  extra,
}: {
  host: Host;
  editing: boolean;
  connecting: boolean;
  tab: HostProfileTab;
  fileSession: { target: Target; name: string } | null;
  onTabChange: (tab: HostProfileTab) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onConnect: () => void;
  onOpenFiles: () => void;
  onCloseFiles: () => void;
  extra?: ReactNode;
}) {
  const conn = connectionString(host);
  const username = host.local?.username || "平台授权账号";
  const address = host.address || "平台解析";
  const group = host.group || "未分组";
  const note = host.local?.note?.trim() || "";
  const identityFile = host.local?.identityFile?.trim() || "";
  const proxy = host.local?.proxy;
  const tunnels = host.local?.tunnels ?? [];
  const proxyText = proxyLabel(host) || "直连";
  const sourceText = host.mode === "local" ? "本地主机" : "平台主机";
  const hostKey =
    host.mode === "local"
      ? "尚未核验，首次 SSH 连接时确认"
      : "连接权限和操作审计由平台管理";

  function changeTab(value: string) {
    const next = value as HostProfileTab;
    onTabChange(next);
    if (next === "files" && !fileSession) onOpenFiles();
  }

  useEffect(() => {
    if (tab !== "files") return;
    return () => onCloseFiles();
  }, [tab, onCloseFiles]);

  return (
    <div className="host-profile">
      <section className="host-profile-hero">
        <div className="host-profile-identity">
          <div className="host-profile-who">
            <div>
              <h2>{host.name}</h2>
              <div className="host-profile-conn">
                <span>{conn}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="host-profile-copy host-profile-copy--always"
                  aria-label="复制连接串"
                  title="复制连接串"
                  onClick={() => void copyText(conn, "连接串")}
                >
                  <Copy />
                </Button>
              </div>
            </div>
          </div>
          {editing ? null : (
            <div className="host-profile-actions">
              <Button
                type="button"
                className="host-primary-action"
                variant="outline"
                size="sm"
                disabled={connecting}
                onClick={onConnect}
              >
                连接
              </Button>
              {host.local ? (
                <Button
                  type="button"
                  className="host-primary-action"
                  variant="outline"
                  size="sm"
                  onClick={onEdit}
                >
                  编辑
                </Button>
              ) : null}
            </div>
          )}
        </div>
        {editing ? null : (
          <div className="host-profile-metrics">
            <Metric label="来源" value={sourceText} />
            <Metric label="认证" value={authLabel(host)} />
            <Metric label="分组" value={group} />
            <Metric label="端口" value={String(host.port)} />
            <Metric label="代理" value={host.local ? proxyText : "平台管理"} />
            <Metric label="隧道" value={tunnelSummary(host)} />
          </div>
        )}
      </section>

      {editing && host.local ? (
        <section
          className="host-profile-body"
          aria-labelledby="host-edit-heading"
        >
          <h3 id="host-edit-heading" className="host-profile-sec">
            编辑主机
          </h3>
          <HostEditor
            key={host.id}
            host={host.local}
            inline
            onClose={onCancelEdit}
            onSaved={onSaved}
          />
        </section>
      ) : (
        <Tabs
          value={tab}
          onValueChange={changeTab}
          className="host-profile-body host-profile-tabs"
        >
          <TabsList
            variant="line"
            aria-label="主机详情分类"
            className="h-auto w-full justify-start rounded-none bg-transparent p-0"
          >
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="connection">连接</TabsTrigger>
            <TabsTrigger value="auth">认证</TabsTrigger>
            <TabsTrigger value="network">网络</TabsTrigger>
            <TabsTrigger
              value="files"
              onClick={() => {
                if (tab === "files" && !fileSession) onOpenFiles();
              }}
            >
              文件浏览
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="host-profile-panel">
            <h3 className="host-profile-sec">基本信息</h3>
            <InfoTable
              cells={[
                { label: "主机名称", value: host.name },
                {
                  label: "IP 地址",
                  value: address,
                  copy: host.address || undefined,
                  empty: !host.address,
                  mono: true,
                },
                { label: "用户名", value: username },
                {
                  label: "操作系统",
                  value: host.osType || EMPTY,
                  empty: !host.osType,
                },
                {
                  label: "连接串",
                  value: conn,
                  copy: conn,
                  mono: true,
                },
                { label: "主机密钥", value: hostKey },
                {
                  label: "标签",
                  empty: !host.tags.length,
                  content: host.tags.length ? (
                    <div className="host-profile-chips__group">
                      {host.tags.map((tag) => (
                        <span key={tag} className="host-profile-chip">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span>{EMPTY}</span>
                  ),
                },
                ...(host.local
                  ? [
                      {
                        label: "备注",
                        value: note || EMPTY,
                        empty: !note,
                      },
                    ]
                  : []),
              ]}
            />
            {extra ? <div className="host-profile-extra">{extra}</div> : null}
          </TabsContent>

          <TabsContent value="connection" className="host-profile-panel">
            <h3 className="host-profile-sec">连接信息</h3>
            <InfoTable
              cells={[
                { label: "主机名称", value: host.name },
                {
                  label: "IP 地址",
                  value: address,
                  copy: host.address || undefined,
                  empty: !host.address,
                  mono: true,
                },
                { label: "用户名", value: username },
                { label: "端口", value: String(host.port), mono: true },
                {
                  label: "操作系统",
                  value: host.osType || EMPTY,
                  empty: !host.osType,
                },
                { label: "连接串", value: conn, copy: conn, mono: true },
              ]}
            />
          </TabsContent>

          <TabsContent value="auth" className="host-profile-panel">
            <h3 className="host-profile-sec">认证</h3>
            <InfoTable
              cells={[
                { label: "认证类型", value: authLabel(host) },
                { label: "用户名", value: username },
                ...(host.local
                  ? [
                      {
                        label: "私钥",
                        value: identityFile || EMPTY,
                        empty: !identityFile,
                        mono: true,
                      },
                      {
                        label: "密码",
                        value: host.local.hasPassword ? "已保存" : "未保存",
                        empty: !host.local.hasPassword,
                      },
                    ]
                  : []),
              ]}
            />
          </TabsContent>

          <TabsContent value="network" className="host-profile-panel">
            {host.local ? (
              <>
                <h3 className="host-profile-sec">代理</h3>
                <InfoTable
                  cells={[
                    {
                      label: "代理协议",
                      value: proxyLabel(host) || EMPTY,
                      empty: !proxy,
                    },
                    {
                      label: "代理地址",
                      value: proxy
                        ? `${proxy.address}:${proxy.port}`
                        : EMPTY,
                      copy: proxy
                        ? `${proxy.address}:${proxy.port}`
                        : undefined,
                      empty: !proxy,
                      mono: true,
                    },
                    {
                      label: "代理账号",
                      value: proxy?.username || EMPTY,
                      empty: !proxy?.username,
                    },
                  ]}
                />
                <h3 className="host-profile-sec">隧道</h3>
                <div className="host-profile-table-wrap">
                  <table className="host-profile-table">
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th>监听端口</th>
                        <th>目标</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tunnels.map((tunnel, index) => (
                        <tr
                          key={`${tunnel.kind}-${tunnel.listenPort}-${index}`}
                        >
                          <td>{tunnelKind(tunnel)}</td>
                          <td className="host-profile-kv__v--mono">
                            {tunnel.listenPort}
                          </td>
                          <td className="host-profile-kv__v--mono">
                            {tunnel.kind === "dynamic"
                              ? "动态转发"
                              : `${tunnel.targetHost}:${tunnel.targetPort}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <h3 className="host-profile-sec">网络路径</h3>
                <InfoTable
                  cells={[
                    {
                      label: "访问方式",
                      value: "由平台授权和审计，本地不保存代理或隧道",
                      wide: true,
                    },
                  ]}
                />
              </>
            )}
          </TabsContent>

          <TabsContent
            value="files"
            className="host-profile-panel host-profile-panel--files"
          >
            {fileSession ? (
              <FileManager
                embedded
                target={fileSession.target}
                name={fileSession.name}
                username={host.local?.username}
              />
            ) : (
              <div className="host-profile-sftp-empty">正在打开文件浏览…</div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
