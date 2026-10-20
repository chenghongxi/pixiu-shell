import { invoke, isTauri, Channel } from "@tauri-apps/api/core";

export type Mode = "local" | "platform";
export interface ProxyConfig {
  kind: "socks5" | "http";
  address: string;
  port: number;
  username: string;
  hasPassword: boolean;
}
export interface LocalHost {
  proxy?: ProxyConfig | null;
  id: string | null;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  identityFile: string;
  note: string;
  tags: string[];
  tunnels: Tunnel[];
  hasPassword: boolean;
}
export interface Tunnel {
  kind: "local" | "remote" | "dynamic";
  listenPort: number;
  targetHost: string;
  targetPort: number;
}
export interface PlatformHost {
  id: string;
  displayName?: string;
  hostname?: string;
  ip?: string;
  primaryIp?: string;
  sshPort: number;
  nodeNames: string[];
  nodeIds?: string[];
  tagNames: string[];
  osType?: string;
}
export interface HostNode {
  id: string;
  name: string;
  parentId?: string;
  children?: HostNode[];
}
export interface PlatformHostDetail extends PlatformHost {
  osVersion?: string;
  arch?: string;
  provider?: string;
  region?: string;
  zone?: string;
  cloudInstanceId?: string;
  lifecycleStatus?: string;
  description?: string;
}
export interface HostIp {
  id: string;
  ip: string;
  ipType: "public" | "private" | "elastic" | "vip" | "other" | string;
  isPrimary: boolean;
  networkCidr?: string;
  interfaceName?: string;
}
export interface Host {
  groupPaths?: string[];
  id: string;
  name: string;
  address: string;
  searchAddresses?: string[];
  port: number;
  group: string;
  mode: Mode;
  tags: string[];
  osType?: string;
  local?: LocalHost;
}
export interface User {
  username: string;
  realName?: string;
  displayName?: string;
  companyName?: string;
  permissionCodes: string[];
  roleCodes: string[];
}
export interface ConnectionOption {
  id: string;
  name: string;
  username?: string;
  status: number;
  isDefault: boolean;
}
export interface HostOptions {
  accounts: ConnectionOption[];
  paths: ConnectionOption[];
}
export interface Qrcode {
  qrcodeUrl: string;
  qrcodeId: string;
  expiresAt: number;
  expiresIn: number;
}
export interface QrcodeStatus {
  status:
    "WAIT" | "SCAN" | "CONFIRM" | "EXPIRED" | "SUCCESS" | "CANCELLED" | "ERROR";
  authCode?: string;
  message?: string;
}
export interface DingLogin {
  status: "success" | "selectOrganization";
  user?: User;
  loginTicket?: string;
  organizations: { companyId: string; companyName: string }[];
}
export type Target = {
  mode: Mode | "shell";
  id: string;
  accountId?: string;
  accessPathId?: string;
  protocol?: "ssh" | "rdp";
};
export type TerminalEvent =
  | { type: "output"; data: number[] }
  | { type: "rdp"; data: string }
  | {
      type: "command_guard"
      data: {
        blocked: boolean
        action: string
        riskLevel?: string
        matchedRule?: string
        message: string
        command: string
      }
    }
  | { type: "status" | "error"; data: string }
  | { type: "closed" };

export const desktop = isTauri();

// Native IPC currently serializes errors as strings. Match only explicit
// authentication failures; network errors and resource denials preserve identity.
const platformAuthErrors = new Set([
  "平台登录已失效，请重新登录",
  "会话已过期，请重新登录",
  "请先登录运维平台",
]);
const authExpiredListeners = new Set<() => void>();
export function onPlatformAuthExpired(listener: () => void) {
  authExpiredListeners.add(listener);
  return () => {
    authExpiredListeners.delete(listener);
  };
}
export async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    throw new Error("请在 Pixiu Shell 桌面应用中使用此功能（npm run tauri dev）");
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    if (platformAuthErrors.has(errorMessage(error))) {
      for (const listener of authExpiredListeners) listener();
    }
    throw error;
  }
}
export function platform<T>(request: Record<string, unknown>) {
  return command<T>("platform_request", { request });
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function fromLocal(host: LocalHost): Host {
  if (!host.id) throw new Error("本地主机缺少 ID");
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    port: host.port,
    group: host.group || "未分组",
    mode: "local",
    tags: host.tags ?? [],
    local: host,
  };
}
export function fromPlatform(host: PlatformHost): Host {
  return {
    id: host.id,
    name: host.displayName || host.hostname || host.ip || "未命名主机",
    address: host.ip || host.primaryIp || "",
    searchAddresses: [
      ...new Set([host.ip, host.primaryIp].filter((ip): ip is string => !!ip)),
    ],
    port: host.sshPort,
    group: host.nodeNames?.[0] || "授权主机",
    mode: "platform",
    tags: host.tagNames ?? [],
    osType: host.osType,
  };
}
export function openTerminal(
  target: Target,
  cols: number,
  rows: number,
  onEvent: (event: TerminalEvent) => void,
) {
  const channel = new Channel<TerminalEvent>();
  channel.onmessage = onEvent;
  return command<string>("terminal_open", { target, cols, rows, channel });
}

export async function sendRdpInput(id: string, data: string) {
  return command<void>("rdp_input", { id, data });
}

export interface LockStatus {
  configured: boolean;
  locked: boolean;
}
export interface Preferences {
  shortcuts: Record<string, string>;
  uploadCommand: string;
  downloadCommand: string;
  aiPanelWidth: number;
  sidebarHidden: boolean;
  theme: "dark" | "light" | "system";
  terminalTheme: string;
  fontSize: number;
  scrollback: number;
  groupBy: "group" | "tag";
  mode: Mode;
  platformAddress: string;
}
export const defaultPreferences: Preferences = {
  shortcuts: {},
  uploadCommand: "cl-u",
  downloadCommand: "cl-d",
  aiPanelWidth: 400,
  sidebarHidden: false,
  theme: "dark",
  terminalTheme: "tshell",
  fontSize: 13,
  scrollback: 10000,
  groupBy: "group",
  mode: "local",
  platformAddress: "",
};
export interface FileItem {
  name: string;
  path: string;
  kind: string;
  size: number;
  permissions?: string;
  modifiedAt?: string;
}
export function directOptions(
  options: HostOptions,
): { accountId?: string; accessPathId?: string } | null {
  const accounts = options.accounts.filter((option) => option.status === 1);
  const paths = options.paths.filter((option) => option.status === 1);
  if (accounts.length > 1 || paths.length > 1) return null;
  return { accountId: accounts[0]?.id, accessPathId: paths[0]?.id };
}

export function resource<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return platform<T>({ type: "resource", path, method, body });
}

export interface CommandApproval {
  id: string;
  requesterId: string;
  hostId: string;
  accountId?: string;
  accessPathId?: string;
  subjectType: string;
  subjectId?: string;
  command: string;
  commandDigest: string;
  riskAction: string;
  riskLevel?: string;
  riskSummary: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "ignored" | "expired" | "cancelled" | string;
  expiresAt: string;
  approvedUntil?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  clientKind: string;
  createdAt: string;
  updatedAt: string;
}

export function createCommandApproval(
  params: {
    hostId: string;
    accountId?: string;
    accessPathId?: string;
    command: string;
    decision: "submit" | "ignore";
    clientKind?: string;
  },
) {
  return resource<CommandApproval>("assets/command-approvals", "POST", params);
}

export function getCommandApproval(id: string) {
  return resource<CommandApproval>(`assets/command-approvals/${id}`);
}

export function cancelCommandApproval(id: string) {
  return resource<CommandApproval>(`assets/command-approvals/${id}/cancel`, "POST");
}

export function platformGroupPaths(nodes: HostNode[]): Map<string, string> {
  const flat = new Map<string, HostNode>();
  const visit = (items: HostNode[]) => {
    for (const item of items) {
      flat.set(item.id, item);
      visit(item.children ?? []);
    }
  };
  visit(nodes);
  const paths = new Map<string, string>();
  for (const item of flat.values()) {
    const parts: string[] = [],
      seen = new Set<string>();
    let current: HostNode | undefined = item;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.name);
      current = current.parentId ? flat.get(current.parentId) : undefined;
    }
    paths.set(item.id, parts.join("/"));
  }
  return paths;
}
