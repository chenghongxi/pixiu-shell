import {
  Server,
  Tags,
  KeyRound,
  Network,
  Users,
  Route,
  Plus,
  Search,
  RefreshCw,
  Pencil,
  ChevronLeft,
  ChevronRight,
  PlugZap,
  CheckCircle2,
  AlertCircle,
  LoaderCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { ObjectStorageFolderIcon } from "./ObjectStorageFolderIcon";
import { Button } from "./ui/button";
import { Input, SearchInput } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Alert, AlertDescription } from "./ui/alert";
import { Choice } from "./Choice";
import { SearchableChoice } from "./SearchableChoice";
import {
  resource,
  errorMessage,
  platformGroupPaths,
  type HostNode,
} from "@/lib/api";
type Row = Record<string, unknown> & { id: string; name?: string };
type Kind =
  | "hosts"
  | "nodes"
  | "tags"
  | "credentials"
  | "proxies"
  | "accounts"
  | "access-paths";
interface Spec {
  key: string;
  label: string;
  type?: "number" | "secret" | "textarea" | "check";
  options?: string[];
  source?: Kind;
  required?: boolean;
}
const specs: Record<Kind, Spec[]> = {
  hosts: [
    { key: "displayName", label: "显示名称", required: true },
    { key: "hostname", label: "主机名" },
    { key: "ip", label: "登录 IP", required: true },
    { key: "sshPort", label: "SSH 端口", type: "number" },
    {
      key: "osType",
      label: "系统类型",
      options: ["linux", "windows", "macos", "freebsd", "other"],
    },
    { key: "osVersion", label: "系统版本" },
    { key: "arch", label: "架构" },
    { key: "description", label: "备注", type: "textarea" },
    { key: "bastionEnabled", label: "启用堡垒机", type: "check" },
  ],
  nodes: [
    { key: "name", label: "分组名称", required: true },
    { key: "parentId", label: "父分组", source: "nodes" },
    { key: "description", label: "备注" },
  ],
  tags: [
    { key: "name", label: "标签名称", required: true },
    { key: "color", label: "颜色" },
    { key: "description", label: "备注" },
  ],
  credentials: [
    { key: "name", label: "凭据名称", required: true },
    {
      key: "credentialType",
      label: "认证类型",
      options: ["password", "private_key"],
    },
    {
      key: "encryptedValue",
      label: "密码 / 私钥（编辑留空保留）",
      type: "secret",
    },
    {
      key: "passphraseEncrypted",
      label: "私钥口令（编辑留空保留）",
      type: "secret",
    },
  ],
  proxies: [
    { key: "name", label: "代理名称", required: true },
    { key: "proxyType", label: "协议", options: ["socks5", "http"] },
    { key: "host", label: "代理地址", required: true },
    { key: "port", label: "代理端口", type: "number" },
    { key: "username", label: "代理用户名" },
    { key: "credentialId", label: "代理凭据", source: "credentials" },
  ],
  accounts: [
    { key: "name", label: "账号名称", required: true },
    { key: "username", label: "SSH 用户名", required: true },
    {
      key: "authType",
      label: "认证类型",
      options: ["password", "private_key"],
    },
    { key: "credentialId", label: "凭据", source: "credentials" },
    { key: "isDefault", label: "默认账号", type: "check" },
  ],
  "access-paths": [
    { key: "name", label: "通道名称", required: true },
    {
      key: "accessType",
      label: "连接方式",
      options: ["direct", "ssh_jump", "ssh_tunnel", "socks5", "http_proxy"],
    },
    { key: "targetPort", label: "目标 SSH 端口", type: "number" },
    { key: "jumpHostId", label: "跳板主机", source: "hosts" },
    { key: "jumpAccountId", label: "跳板账号" },
    { key: "proxyId", label: "网络代理", source: "proxies" },
    { key: "tunnelHost", label: "隧道入口地址" },
    { key: "tunnelPort", label: "隧道入口端口", type: "number" },
    { key: "isDefault", label: "默认通道", type: "check" },
  ],
};
const labels: Record<Kind, string> = {
  hosts: "主机",
  nodes: "分组",
  tags: "标签",
  credentials: "凭据",
  proxies: "代理",
  accounts: "主机账号",
  "access-paths": "连接通道",
};
function rows(value: Row[] | { data?: Row[]; items?: Row[] }): Row[] {
  return Array.isArray(value) ? value : (value.data ?? value.items ?? []);
}

const icons = {
  hosts: Server,
  nodes: ObjectStorageFolderIcon,
  tags: Tags,
  credentials: KeyRound,
  proxies: Network,
  accounts: Users,
  "access-paths": Route,
};
const optionLabels: Record<string, string> = {
  password: "密码认证",
  private_key: "SSH 私钥",
  direct: "直连",
  ssh_jump: "SSH 跳板",
  ssh_tunnel: "SSH 隧道",
  socks5: "SOCKS5",
  http: "HTTP CONNECT",
  http_proxy: "HTTP 代理",
};
const defaults = {
  sshPort: 22,
  targetPort: 22,
  bastionEnabled: true,
  credentialType: "password",
  authType: "password",
  accessType: "direct",
  proxyType: "socks5",
  status: 1,
  username: "root",
  osType: "linux",
};
interface Connectivity {
  status: string;
  message: string;
  hostname?: string;
  osType?: string;
  osVersion?: string;
  arch?: string;
}
export function PlatformResources({
  onChanged,
  createRequest = 0,
  onCreateHandled,
}: {
  createRequest?: number;
  onCreateHandled?: () => void;
  onChanged: () => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>("hosts"),
    [hostId, setHostId] = useState("");
  const [list, setList] = useState<Row[]>([]),
    [refs, setRefs] = useState<Partial<Record<Kind, Row[]>>>({});
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [total, setTotal] = useState(0),
    [group, setGroup] = useState("all"),
    [groupSearch, setGroupSearch] = useState(""),
    [remoteSearch, setRemoteSearch] = useState("");
  const [search, setSearch] = useState(""),
    [loading, setLoading] = useState(false),
    [editorOpen, setEditorOpen] = useState(false),
    [tab, setTab] = useState("basic");
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...defaults }),
    [id, setId] = useState<string | null>(null);
  const [creatingHost, setCreatingHost] = useState(false);
  const [quickCredentialOpen, setQuickCredentialOpen] = useState(false);
  const [quickCredential, setQuickCredential] = useState({
    name: "",
    credentialType: "password",
    encryptedValue: "",
    passphraseEncrypted: "",
  });
  const [relationsReady, setRelationsReady] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [jumpAccounts, setJumpAccounts] = useState<Row[]>([]),
    [nodeIds, setNodeIds] = useState<string[]>([]),
    [tagIds, setTagIds] = useState<string[]>([]),
    [previousNodes, setPreviousNodes] = useState<string[]>([]),
    [previousTags, setPreviousTags] = useState<string[]>([]);
  const [testing, setTesting] = useState(false),
    [tested, setTested] = useState<{
      signature: string;
      result: Connectivity;
    } | null>(null);
  const editorGeneration = useRef(0),
    setup = useRef<{ pending: boolean; account?: string; path?: string }>({
      pending: false,
    });
  const scoped = kind === "accounts" || kind === "access-paths";
  const endpoint =
    kind === "tags"
      ? "tags"
      : scoped
        ? `assets/hosts/${hostId}/${kind}`
        : `assets/${kind}`;
  const title = (row: Row) =>
    String(row.displayName || row.name || row.hostname || row.ip || row.id);
  const change = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    const timer = setTimeout(() => {
      setRemoteSearch(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let ignore = false;
    void Promise.allSettled(
      (["nodes", "tags", "credentials", "proxies"] as Kind[]).map(
        async (key) => {
          const value = await resource<Row[] | { data: Row[] }>(
            key === "tags" ? "tags?pageSize=1000" : `assets/${key}`,
          );
          if (!ignore)
            setRefs((current) => ({ ...current, [key]: rows(value) }));
        },
      ),
    );
    return () => {
      ignore = true;
    };
  }, [revision]);
  const needsHostRefs =
    scoped || (editorOpen && draft.accessType === "ssh_jump");
  useEffect(() => {
    if (!needsHostRefs) return;
    let ignore = false;
    void resource<Row[] | { data: Row[] }>("assets/hosts?pageSize=1000")
      .then((value) => {
        if (!ignore) setRefs((current) => ({ ...current, hosts: rows(value) }));
      })
      .catch((error) => {
        if (!ignore) setError(errorMessage(error));
      });
    return () => {
      ignore = true;
    };
  }, [needsHostRefs, revision]);
  useEffect(() => {
    let ignore = false;
    // Synchronize the requested resource page with the platform.
    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true);
    setError("");
    setList([]);
    if (scoped && !hostId) {
      setLoading(false);
      setTotal(0);
      return;
    }
    const query = new URLSearchParams(
      kind === "hosts"
        ? { page: String(page), pageSize: String(pageSize) }
        : { pageSize: "1000" },
    );
    if (kind === "hosts") {
      if (group !== "all") query.set("nodeId", group);
      if (remoteSearch) query.set("search", remoteSearch);
    }
    void resource<Row[] | { data: Row[]; total: number }>(
      `${endpoint}?${query}`,
    )
      .then((value) => {
        if (ignore) return;
        const records = rows(value),
          count = Array.isArray(value)
            ? value.length
            : (value.total ?? records.length);
        if (
          kind === "hosts" &&
          page > Math.max(1, Math.ceil(count / pageSize))
        ) {
          setPage(Math.max(1, Math.ceil(count / pageSize)));
          return;
        }
        setList(records);
        setTotal(count);
      })
      .catch((error) => {
        if (!ignore) {
          setError(errorMessage(error));
          setTotal(0);
        }
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [
    endpoint,
    revision,
    scoped,
    hostId,
    kind,
    page,
    pageSize,
    group,
    remoteSearch,
  ]);
  useEffect(() => {
    let ignore = false;
    // oxlint-disable-next-line react/set-state-in-effect
    setJumpAccounts([]);
    if (draft.jumpHostId)
      void resource<Row[]>(`assets/hosts/${draft.jumpHostId}/accounts`)
        .then((value) => {
          if (!ignore) setJumpAccounts(value);
        })
        .catch((error) => {
          if (!ignore) setError(errorMessage(error));
        });
    return () => {
      ignore = true;
    };
  }, [draft.jumpHostId]);
  function newResource() {
    editorGeneration.current++;
    setId(null);
    setDraft({ ...defaults });
    setNodeIds([]);
    setTagIds([]);
    setPreviousNodes([]);
    setPreviousTags([]);
    setRelationsReady(true);
    setTested(null);
    setError("");
    setTab("basic");
    setup.current = { pending: kind === "hosts" };
    setCreatingHost(kind === "hosts");
    setEditorOpen(true);
  }
  function openQuickCredential() {
    setQuickCredential({
      name: "",
      credentialType: "password",
      encryptedValue: "",
      passphraseEncrypted: "",
    });
    setQuickCredentialOpen(true);
  }
  async function saveQuickCredential() {
    if (!quickCredential.name.trim() || !quickCredential.encryptedValue) {
      setError("请填写凭据名称和密码或私钥");
      return;
    }
    try {
      const saved = await resource<Row>("assets/credentials", "POST", {
        name: quickCredential.name.trim(),
        credentialType: quickCredential.credentialType,
        encryptedValue: quickCredential.encryptedValue,
        passphraseEncrypted:
          quickCredential.credentialType === "private_key"
            ? quickCredential.passphraseEncrypted || null
            : null,
      });
      setRefs((current) => ({
        ...current,
        credentials: [...(current.credentials ?? []), saved],
      }));
      change("credentialId", saved.id);
      setQuickCredentialOpen(false);
      toast.success("凭据已创建并已选中");
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function edit(row: Row) {
    const generation = ++editorGeneration.current;
    setup.current = { pending: false };
    setCreatingHost(false);
    setId(row.id);
    setDraft({
      ...defaults,
      ...row,
      encryptedValue: "",
      passphraseEncrypted: "",
      tunnelHost: (row.tunnelConfig as { host?: string })?.host ?? "",
      tunnelPort: (row.tunnelConfig as { port?: number })?.port ?? 22,
    });
    setError("");
    setTested(null);
    setTab("basic");
    setEditorOpen(true);
    setRelationsReady(kind !== "hosts");
    if (kind === "hosts") {
      const bound = Array.isArray(row.nodeIds) ? row.nodeIds.map(String) : [];
      setNodeIds(bound);
      setPreviousNodes(bound);
      setTagIds([]);
      setPreviousTags([]);
      try {
        const tags = await resource<Row[]>(`tags/resource/host/${row.id}`);
        if (generation !== editorGeneration.current) return;
        setTagIds(tags.map((x) => x.id));
        setPreviousTags(tags.map((x) => x.id));
        setRelationsReady(true);
      } catch (error) {
        if (generation === editorGeneration.current)
          setError(errorMessage(error));
      }
    }
  }
  function accessBody() {
    return {
      accessType: draft.accessType || "direct",
      targetPort:
        kind === "hosts" && (!draft.accessType || draft.accessType === "direct")
          ? Number(draft.sshPort || 22)
          : Number(draft.targetPort || draft.sshPort || 22),
      ...(draft.accessType === "ssh_jump"
        ? { jumpHostId: draft.jumpHostId, jumpAccountId: draft.jumpAccountId }
        : {}),
      ...(["socks5", "http_proxy"].includes(String(draft.accessType))
        ? { proxyId: draft.proxyId }
        : {}),
      ...(draft.accessType === "ssh_tunnel"
        ? {
            tunnelConfig: {
              host: draft.tunnelHost,
              port: Number(draft.tunnelPort),
            },
          }
        : {}),
    };
  }
  function validateConnection() {
    if (!String(draft.ip ?? "").trim()) throw new Error("请填写登录 IP");
    if (!draft.credentialId || !String(draft.username ?? "").trim())
      throw new Error("请选择平台凭据并填写 SSH 用户名");
    if (
      draft.accessType === "ssh_jump" &&
      (!draft.jumpHostId || !draft.jumpAccountId)
    )
      throw new Error("请选择跳板主机和账号");
    if (
      ["socks5", "http_proxy"].includes(String(draft.accessType)) &&
      !draft.proxyId
    )
      throw new Error("请选择网络代理");
    if (
      draft.accessType === "ssh_tunnel" &&
      (!draft.tunnelHost || !draft.tunnelPort)
    )
      throw new Error("请填写隧道入口地址和端口");
  }
  const signature = JSON.stringify([
    draft.ip,
    draft.sshPort,
    draft.credentialId,
    draft.username,
    draft.authType,
    accessBody(),
  ]);
  async function testConnection() {
    setTesting(true);
    setTested(null);
    setError("");
    try {
      validateConnection();
      const result = await resource<Connectivity>(
        "assets/hosts/connectivity-test",
        "POST",
        {
          ip: String(draft.ip).trim(),
          sshPort: Number(draft.sshPort),
          credentialId: draft.credentialId,
          username: draft.username,
          authType: draft.authType,
          timeoutSeconds: 30,
          ...accessBody(),
        },
      );
      setTested({ signature, result });
      if (result.status === "success")
        setDraft((current) => ({
          ...current,
          ...Object.fromEntries(
            ["hostname", "osType", "osVersion", "arch"]
              .filter((key) => result[key as keyof Connectivity])
              .map((key) => [key, result[key as keyof Connectivity]]),
          ),
        }));
    } catch (error) {
      setTested({
        signature,
        result: { status: "failed", message: errorMessage(error) },
      });
    } finally {
      setTesting(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {};
      for (const field of specs[kind]) {
        const value = draft[field.key];
        if (field.required && !String(value ?? "").trim())
          throw new Error(`请填写${field.label}`);
        if (
          field.key.startsWith("tunnel") ||
          (field.type === "secret" && !value)
        )
          continue;
        body[field.key] = value === "" ? null : value;
      }
      if (kind === "credentials" && !id && !draft.encryptedValue)
        throw new Error("请填写密码或私钥");
      if (kind === "hosts" && setup.current.pending && draft.credentialId)
        validateConnection();
      if (kind === "access-paths") Object.assign(body, accessBody());
      const saved = await resource<Row>(
        `${endpoint}${id ? `/${id}` : ""}`,
        id ? "PUT" : "POST",
        body,
      );
      const savedId = id || saved.id;
      setId(savedId);
      if (kind === "hosts") {
        if (setup.current.pending && draft.credentialId) {
          if (!setup.current.account) {
            const account = await resource<Row>(
              `assets/hosts/${savedId}/accounts`,
              "POST",
              {
                name: `${draft.username} · 默认账号`,
                username: draft.username,
                authType: draft.authType,
                credentialId: draft.credentialId,
                isDefault: true,
              },
            );
            setup.current.account = account.id;
          }
          if (!setup.current.path) {
            const path = await resource<Row>(
              `assets/hosts/${savedId}/access-paths`,
              "POST",
              { name: "默认连接通道", ...accessBody(), isDefault: true },
            );
            setup.current.path = path.id;
          }
        }
        for (const node of nodeIds.filter(
          (node) => !previousNodes.includes(node),
        ))
          await resource(`assets/hosts/${savedId}/nodes/${node}`, "POST");
        for (const node of previousNodes.filter(
          (node) => !nodeIds.includes(node),
        ))
          await resource(`assets/hosts/${savedId}/nodes/${node}`, "DELETE");
        if (tagIds.length)
          await resource(`tags/resource/host/${savedId}`, "POST", { tagIds });
        for (const tag of previousTags.filter((tag) => !tagIds.includes(tag)))
          await resource(`tags/resource/host/${savedId}/${tag}`, "DELETE");
      }
      toast.success("平台资源已保存");
      setEditorOpen(false);
      setRevision((value) => value + 1);
      await onChanged();
    } catch (error) {
      setError(`保存未全部完成：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }
  const nodePaths = platformGroupPaths(
    (refs.nodes ?? []) as unknown as HostNode[],
  );
  function field(field: Spec) {
    return (
      <Field
        key={field.key}
        className={
          field.type === "textarea" || field.type === "secret"
            ? "resource-field-wide"
            : undefined
        }
      >
        <FieldLabel>{field.label}</FieldLabel>
        {field.source === "credentials" && field.key === "credentialId" ? (
          <SearchableChoice
            label={field.label}
            disabled={busy || testing}
            value={String(draft[field.key] || "none")}
            onCreate={openQuickCredential}
            onChange={(value) => {
              const credential = refs.credentials?.find(
                (row) => row.id === value,
              );
              const meta = credential?.metadata as
                { username?: string; authType?: string } | undefined;
              setDraft((current) => ({
                ...current,
                credentialId: value === "none" ? null : value,
                username: meta?.username || current.username,
                authType:
                  meta?.authType ||
                  credential?.credentialType ||
                  current.authType,
              }));
            }}
            options={[
              { value: "none", label: "请选择凭据" },
              ...(refs.credentials ?? []).map((row) => ({
                value: row.id,
                label: title(row),
              })),
            ]}
          />
        ) : field.options || field.source || field.key === "jumpAccountId" ? (
          <Choice
            label={field.label}
            disabled={busy || testing}
            value={String(draft[field.key] || "none")}
            onChange={(value) => {
              change(field.key, value === "none" ? null : value);
              if (field.key === "credentialId") {
                const credential = refs.credentials?.find(
                  (row) => row.id === value,
                );
                const meta = credential?.metadata as
                  { username?: string; authType?: string } | undefined;
                setDraft((current) => ({
                  ...current,
                  credentialId: value === "none" ? null : value,
                  username: meta?.username || current.username,
                  authType:
                    meta?.authType ||
                    credential?.credentialType ||
                    current.authType,
                }));
              }
            }}
            options={
              field.options?.map((value) => ({
                value,
                label: optionLabels[value] || value,
              })) ?? [
                { value: "none", label: "请选择" },
                ...(field.key === "jumpAccountId"
                  ? jumpAccounts
                  : (refs[field.source!] ?? [])
                )
                  .filter((row) => field.key !== "parentId" || row.id !== id)
                  .map((row) => ({
                    value: row.id,
                    label:
                      field.source === "nodes"
                        ? nodePaths.get(row.id) || title(row)
                        : title(row),
                  })),
              ]
            }
          />
        ) : field.type === "check" ? (
          <label className="resource-switch">
            <input
              aria-label={field.label}
              type="checkbox"
              disabled={busy || testing}
              checked={!!draft[field.key]}
              onChange={(event) => change(field.key, event.target.checked)}
            />
            <span>{draft[field.key] ? "已启用" : "未启用"}</span>
          </label>
        ) : field.type === "textarea" ||
          (field.type === "secret" &&
            draft.credentialType === "private_key" &&
            field.key === "encryptedValue") ? (
          <Textarea
            aria-label={field.label}
            disabled={busy || testing}
            autoComplete="off"
            value={String(draft[field.key] ?? "")}
            onChange={(event) => change(field.key, event.target.value)}
          />
        ) : (
          <Input
            aria-label={field.label}
            disabled={busy || testing}
            type={
              field.type === "number"
                ? "number"
                : field.type === "secret"
                  ? "password"
                  : "text"
            }
            autoComplete={field.type === "secret" ? "new-password" : undefined}
            min={field.type === "number" ? 1 : undefined}
            max={field.type === "number" ? 65535 : undefined}
            required={field.required}
            value={String(draft[field.key] ?? "")}
            onChange={(event) =>
              change(
                field.key,
                field.type === "number"
                  ? Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
      </Field>
    );
  }
  const accessFields = specs["access-paths"]
    .filter((item) => !["name", "isDefault"].includes(item.key))
    .filter(
      (item) =>
        item.key !== "targetPort" ||
        kind !== "hosts" ||
        draft.accessType !== "direct",
    )
    .filter(
      (item) =>
        !["jumpHostId", "jumpAccountId"].includes(item.key) ||
        draft.accessType === "ssh_jump",
    )
    .filter(
      (item) =>
        item.key !== "proxyId" ||
        ["socks5", "http_proxy"].includes(String(draft.accessType)),
    )
    .filter(
      (item) =>
        !item.key.startsWith("tunnel") || draft.accessType === "ssh_tunnel",
    );
  const visible =
    kind === "hosts"
      ? list
      : list.filter((row) =>
          [title(row), row.ip, row.host, row.username]
            .join(" ")
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
        );
  const Icon = icons[kind];
  const openFromSidebar = useEffectEvent(() => {
    setKind("hosts");
    newResource();
    setup.current = { pending: true };
    setCreatingHost(true);
    onCreateHandled?.();
  });
  useEffect(() => {
    // A sidebar action requests opening this editor after its tab mounts.
    // oxlint-disable-next-line react/set-state-in-effect
    if (createRequest) openFromSidebar();
  }, [createRequest]);
  return (
    <section className="platform-resources">
      <nav className="resource-navigation" aria-label="平台资源分类">
        <div>资源管理</div>
        {(Object.keys(labels) as Kind[]).map((key) => {
          const ItemIcon = icons[key];
          return (
            <button
              type="button"
              key={key}
              data-active={kind === key}
              onClick={() => {
                editorGeneration.current++;
                setKind(key);
                setSearch("");
                setRemoteSearch("");
                setGroup("all");
                setPage(1);
                setEditorOpen(false);
              }}
            >
              <ItemIcon />
              <span>{labels[key]}</span>
            </button>
          );
        })}
        <p>
          平台统一授权
          <br />
          操作全程审计
        </p>
      </nav>
      <div className="resource-main">
        <header>
          <div className="resource-heading">
            <span>
              <Icon />
            </span>
            <div>
              <h2>{labels[kind]}管理</h2>
              <p>
                {kind === "hosts"
                  ? "集中维护主机信息、账号和连接通道"
                  : "维护平台共享资源与关联配置"}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新平台资源"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" disabled={scoped && !hostId} onClick={newResource}>
            <Plus />
            新增{labels[kind]}
          </Button>
        </header>
        <div
          className={`resource-browse ${kind === "hosts" ? "with-groups" : ""}`}
        >
          {kind === "hosts" ? (
            <aside className="resource-host-groups" aria-label="平台主机分组">
              <h3>
                <ObjectStorageFolderIcon />
                主机分组
              </h3>
              <SearchInput
                aria-label="查找主机组"
                placeholder="查找分组…"
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
              />
              <div>
                <button
                  type="button"
                  data-active={group === "all"}
                  onClick={() => {
                    setGroup("all");
                    setPage(1);
                  }}
                >
                  全部主机
                </button>
                {(refs.nodes ?? [])
                  .filter((node) =>
                    (nodePaths.get(node.id) || title(node))
                      .toLowerCase()
                      .includes(groupSearch.toLowerCase()),
                  )
                  .map((node) => {
                    const path = nodePaths.get(node.id) || title(node);
                    return (
                      <button
                        key={node.id}
                        type="button"
                        data-active={group === node.id}
                        title={path}
                        style={{
                          paddingLeft:
                            10 + Math.min(4, path.split("/").length - 1) * 12,
                        }}
                        onClick={() => {
                          setGroup(node.id);
                          setPage(1);
                        }}
                      >
                        <ObjectStorageFolderIcon />
                        <span>{title(node)}</span>
                      </button>
                    );
                  })}
              </div>
            </aside>
          ) : null}
          <div className="resource-list-page">
            <div className="resource-list-toolbar">
              <div>
                <Search />
                <SearchInput
                  aria-label="搜索平台资源"
                  placeholder={`搜索${labels[kind]}名称、地址…`}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                />
              </div>
              {scoped ? (
                <Choice
                  label="所属主机"
                  value={hostId || "none"}
                  onChange={(value) => setHostId(value === "none" ? "" : value)}
                  options={[
                    { value: "none", label: "选择所属主机" },
                    ...(refs.hosts ?? []).map((row) => ({
                      value: row.id,
                      label: title(row),
                    })),
                  ]}
                />
              ) : null}
              <span>
                {kind === "hosts"
                  ? `${group === "all" ? "全部主机" : nodePaths.get(group) || "当前分组"} · ${total} 台`
                  : `${visible.length} 项资源`}
              </span>
            </div>
            {error && !editorOpen ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="resource-table-wrap">
              <table className="resource-data-table">
                <thead>
                  <tr>
                    <th>{labels[kind]}名称</th>
                    <th>{kind === "hosts" ? "连接地址" : "资源信息"}</th>
                    {kind === "hosts" ? <th>主机组</th> : null}
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="resource-row-title">
                          <Icon />
                          <strong>{title(row)}</strong>
                        </span>
                      </td>
                      <td>
                        <span className="resource-row-detail">
                          {kind === "hosts"
                            ? `${row.ip || row.primaryIp || "—"}:${row.sshPort || 22}`
                            : String(
                                row.username ||
                                  row.host ||
                                  optionLabels[
                                    String(
                                      row.accessType ||
                                        row.credentialType ||
                                        row.proxyType,
                                    )
                                  ] ||
                                  row.description ||
                                  "—",
                              )}
                        </span>
                      </td>
                      {kind === "hosts" ? (
                        <td className="resource-group-cell">
                          {(Array.isArray(row.nodeIds)
                            ? row.nodeIds
                                .map((id) => nodePaths.get(String(id)))
                                .filter(Boolean)
                            : Array.isArray(row.nodeNames)
                              ? row.nodeNames
                              : []
                          ).join(" / ") || "未分组"}
                        </td>
                      ) : null}
                      <td>
                        <span
                          className="resource-state"
                          data-disabled={row.status === 0}
                        >
                          {row.status === 0 ? "停用" : "可用"}
                        </span>
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-label={`编辑 ${title(row)}`}
                          onClick={() => void edit(row)}
                        >
                          <Pencil />
                          编辑
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {loading ? (
                <div className="resource-list-empty">
                  <LoaderCircle className="animate-spin" />
                  正在加载资源…
                </div>
              ) : !visible.length ? (
                <div className="resource-list-empty">
                  <Icon />
                  <strong>
                    {scoped && !hostId
                      ? "先选择一台主机"
                      : search
                        ? "没有匹配的资源"
                        : `尚无${labels[kind]}`}
                  </strong>
                  <p>
                    {scoped
                      ? "为选中的主机维护登录配置"
                      : "使用右上角按钮添加平台资源"}
                  </p>
                </div>
              ) : null}
            </div>
            {kind === "hosts" ? (
              <footer
                className="resource-pagination"
                role="navigation"
                aria-label="主机分页"
              >
                <span>共 {total} 台</span>
                <Choice
                  label="每页主机数量"
                  value={String(pageSize)}
                  onChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1);
                  }}
                  options={[10, 20, 50].map((value) => ({
                    value: String(value),
                    label: `${value} 条 / 页`,
                  }))}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="上一页主机"
                  disabled={loading || page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft />
                </Button>
                <span>
                  {page} / {Math.max(1, Math.ceil(total / pageSize))}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="下一页主机"
                  disabled={
                    loading || page >= Math.max(1, Math.ceil(total / pageSize))
                  }
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronRight />
                </Button>
              </footer>
            ) : null}
          </div>
        </div>
      </div>
      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!busy && !testing) {
            setEditorOpen(open);
            if (!open) editorGeneration.current++;
          }
        }}
      >
        <DialogContent
          className="resource-editor-dialog"
          showCloseButton={!busy && !testing}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <DialogHeader>
              <div className="resource-dialog-heading">
                <span>
                  <Icon />
                </span>
                <div>
                  <DialogTitle>
                    {id ? "编辑" : "新增"}
                    {labels[kind]}
                  </DialogTitle>
                  <DialogDescription>
                    {kind === "hosts"
                      ? "配置主机信息与登录方式，保存前可先检测 SSH 连通性。"
                      : "配置保存在运维平台，沿用当前账号权限。"}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="resource-editor-tabs">
                <TabsTrigger value="basic">基本信息</TabsTrigger>
                {kind === "hosts" ? (
                  <>
                    <TabsTrigger value="connection">登录与通道</TabsTrigger>
                    <TabsTrigger value="relations">分组与标签</TabsTrigger>
                  </>
                ) : null}
              </TabsList>
              <TabsContent value="basic" className="resource-editor-body">
                <FieldGroup className="resource-field-grid">
                  {(kind === "access-paths"
                    ? [specs[kind][0], ...accessFields, specs[kind].at(-1)!]
                    : specs[kind]
                  ).map(field)}
                </FieldGroup>
              </TabsContent>
              {kind === "hosts" ? (
                <>
                  <TabsContent
                    value="connection"
                    className="resource-editor-body"
                  >
                    <div className="resource-section-heading">
                      <KeyRound />
                      <div>
                        <strong>
                          {creatingHost ? "初始登录账号" : "检测登录账号"}
                        </strong>
                        <p>
                          {creatingHost
                            ? "选择已有平台凭据，保存时同时建立默认账号和通道。"
                            : "用于检测当前表单地址；已有账号与通道请在资源分类中维护。"}
                        </p>
                      </div>
                    </div>
                    <FieldGroup className="resource-field-grid">
                      {specs.accounts
                        .filter(
                          (item) => !["name", "isDefault"].includes(item.key),
                        )
                        .map(field)}
                    </FieldGroup>
                    <div className="resource-section-heading">
                      <Route />
                      <div>
                        <strong>连接通道</strong>
                        <p>从平台网络出发，使用直连、跳板机、隧道或代理。</p>
                      </div>
                    </div>
                    <FieldGroup className="resource-field-grid">
                      {accessFields.map(field)}
                    </FieldGroup>
                  </TabsContent>
                  <TabsContent
                    value="relations"
                    className="resource-editor-body"
                  >
                    <div className="resource-relations">
                      {(
                        [
                          ["分组", refs.nodes ?? [], nodeIds, setNodeIds],
                          ["标签", refs.tags ?? [], tagIds, setTagIds],
                        ] as const
                      ).map(([label, items, selected, setSelected]) => (
                        <section key={label}>
                          <h3>
                            {label}
                            <small>已选 {selected.length}</small>
                          </h3>
                          <div>
                            {items.map((item) => (
                              <label key={item.id}>
                                <input
                                  type="checkbox"
                                  disabled={busy || testing}
                                  checked={selected.includes(item.id)}
                                  onChange={(event) =>
                                    setSelected((current) =>
                                      event.target.checked
                                        ? [...current, item.id]
                                        : current.filter(
                                            (id) => id !== item.id,
                                          ),
                                    )
                                  }
                                />
                                {label === "分组"
                                  ? nodePaths.get(item.id)
                                  : title(item)}
                              </label>
                            ))}
                            {!items.length ? <p>暂无可选{label}</p> : null}
                          </div>
                        </section>
                      ))}
                    </div>
                  </TabsContent>
                </>
              ) : null}
            </Tabs>
            {tested ? (
              <div
                className="connectivity-result"
                data-status={
                  tested.signature === signature
                    ? tested.result.status
                    : "stale"
                }
                role="status"
              >
                {tested.signature !== signature ? (
                  <AlertCircle />
                ) : tested.result.status === "success" ? (
                  <CheckCircle2 />
                ) : (
                  <AlertCircle />
                )}
                <div>
                  <strong>
                    {tested.signature !== signature
                      ? "连接配置已修改，请重新检测"
                      : tested.result.status === "success"
                        ? "SSH 连通性检测通过"
                        : "SSH 连通性检测失败"}
                  </strong>
                  <p>{tested.result.message}</p>
                  {tested.signature === signature &&
                  tested.result.status === "success" ? (
                    <small>
                      {[
                        tested.result.hostname,
                        tested.result.osVersion,
                        tested.result.arch,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  ) : null}
                </div>
              </div>
            ) : null}
            <DialogFooter className="resource-editor-footer">
              {kind === "hosts" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || testing}
                  onClick={() => {
                    if (!draft.credentialId) setTab("connection");
                    void testConnection();
                  }}
                >
                  {testing ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <PlugZap />
                  )}
                  {testing ? "正在检测…" : "连通性检测"}
                </Button>
              ) : null}
              <span />
              <Button
                type="button"
                variant="outline"
                disabled={busy || testing}
                onClick={() => setEditorOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={busy || testing || !relationsReady}
              >
                {busy ? "保存中…" : id ? "保存修改" : `保存${labels[kind]}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={quickCredentialOpen} onOpenChange={setQuickCredentialOpen}>
        <DialogContent className="quick-credential-dialog">
          <DialogHeader>
            <DialogTitle>新建凭据</DialogTitle>
            <DialogDescription>创建后会自动回填到当前主机。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>凭据名称</FieldLabel>
              <Input
                value={quickCredential.name}
                onChange={(event) =>
                  setQuickCredential((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel>认证类型</FieldLabel>
              <Choice
                label="认证类型"
                value={quickCredential.credentialType}
                onChange={(value) =>
                  setQuickCredential((current) => ({
                    ...current,
                    credentialType: value,
                    encryptedValue: "",
                    passphraseEncrypted: "",
                  }))
                }
                options={[
                  { value: "password", label: "密码认证" },
                  { value: "private_key", label: "SSH 私钥" },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel>
                {quickCredential.credentialType === "private_key"
                  ? "私钥内容"
                  : "密码"}
              </FieldLabel>
              <Textarea
                value={quickCredential.encryptedValue}
                onChange={(event) =>
                  setQuickCredential((current) => ({
                    ...current,
                    encryptedValue: event.target.value,
                  }))
                }
              />
            </Field>
            {quickCredential.credentialType === "private_key" ? (
              <Field>
                <FieldLabel>私钥口令（可选）</FieldLabel>
                <Input
                  type="password"
                  value={quickCredential.passphraseEncrypted}
                  onChange={(event) =>
                    setQuickCredential((current) => ({
                      ...current,
                      passphraseEncrypted: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setQuickCredentialOpen(false)}
            >
              取消
            </Button>
            <Button onClick={() => void saveQuickCredential()}>创建凭据</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
