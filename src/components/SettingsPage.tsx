import { ShortcutSettings } from "./ShortcutSettings";
import { LockSettings } from "./ScreenLock";
import { effectiveShortcuts, shortcutConflict } from "@/lib/shortcuts";
import type { LockStatus } from "@/lib/api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
import { PlatformResources } from "./PlatformResources";
import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Keyboard,
  ShieldCheck,
  Monitor,
  Palette,
  Server,
  Building2,
  Sparkles,
  Search,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BatchImportDialog } from "./BatchImportDialog";
import { HostEditor } from "./HostEditor";
import { Choice } from "./Choice";
import { applyWindowOpacity, terminalThemes } from "@/lib/themes";
import {
  command,
  errorMessage,
  type LocalHost,
  type Preferences,
} from "@/lib/api";

/** 主机列表「认证类型」列：优先私钥，其次已保存密码，都没有则需要交互认证。 */
function authLabel(host: LocalHost) {
  if (host.identityFile) return "私钥";
  if (host.hasPassword) return "密码";
  return "交互";
}

/** 说明条图标：与 pixiu-ui 的 Element Plus InfoFilled 使用同一条图形路径。 */
function NoticeInfoIcon() {
  return (
    <svg
      className="host-notice__icon"
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896.064A448 448 0 0 1 512 64m67.2 275.072c33.28 0 60.288-23.104 60.288-57.344s-27.072-57.344-60.288-57.344c-33.28 0-60.16 23.104-60.16 57.344s26.88 57.344 60.16 57.344M590.912 699.2c0-6.848 2.368-24.64 1.024-34.752l-52.608 60.544c-10.88 11.456-24.512 19.392-30.912 17.28a12.99 12.99 0 0 1-8.256-14.72l87.68-276.992c7.168-35.136-12.544-67.2-54.336-71.296-44.096 0-108.992 44.736-148.48 101.504 0 6.784-1.28 23.68.064 33.792l52.544-60.608c10.88-11.328 23.552-19.328 29.952-17.152a12.8 12.8 0 0 1 7.808 16.128L388.48 728.576c-10.048 32.256 8.96 63.872 55.04 71.04 67.84 0 107.904-43.648 147.456-100.416z"
      />
    </svg>
  );
}

export function SettingsPage({
  preferences,
  lockStatus,
  onLockStatus,
  onLock,
  resourceCreateRequest,
  onResourceCreateHandled,
  platformEnabled,
  refreshPlatform,
  onSave,
  hosts,
  refresh,
  onConnect,
  tab,
  onTab,
  createRequest,
}: {
  preferences: Preferences;
  lockStatus: LockStatus;
  onLockStatus: (status: LockStatus) => void;
  onLock: () => void;
  resourceCreateRequest: number;
  onResourceCreateHandled: () => void;
  platformEnabled: boolean;
  refreshPlatform: () => Promise<void>;
  onSave: (prefs: Preferences) => Promise<void>;
  hosts: LocalHost[];
  refresh: () => Promise<void>;
  onConnect: (host: LocalHost) => void;
  tab: string;
  onTab: (value: string) => void;
  createRequest: number;
}) {
  const [draft, setDraft] = useState(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [aiKeyConfigured, setAiKeyConfigured] = useState(false);
  const [editor, setEditor] = useState<{ host?: LocalHost } | null>(null);
  const [batchImportOpen, setBatchImportOpen] = useState(false);
  const [remove, setRemove] = useState<{
    kind: "host" | "hosts";
    id?: string;
    ids?: string[];
    name?: string;
  } | null>(null);
  /** 主机列表：提示条、搜索与多选（对齐 pixiu-ui 的主机管理页）。 */
  const [hostNotice, setHostNotice] = useState(true);
  const [hostKeyword, setHostKeyword] = useState("");
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [checkingHost, setCheckingHost] = useState<string | null>(null);
  const [hostPage, setHostPage] = useState(1);
  const [hostPageSize, setHostPageSize] = useState(10);
  const [hostPageJump, setHostPageJump] = useState("1");
  const [hostMoreOpen, setHostMoreOpen] = useState<string | null>(null);
  useEffect(() => {
    // Native bootstrap and global theme controls can update saved preferences.
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft(preferences);
  }, [preferences]);
  useEffect(() => {
    // Handle the sidebar create action while keeping this page mounted.
    // oxlint-disable-next-line react/set-state-in-effect
    if (createRequest) setEditor({});
  }, [createRequest]);
  useEffect(() => {
    // Apply while dragging so the translucent window tracks the slider; the
    // cleanup restores the saved value if the edit is abandoned.
    applyWindowOpacity(document.documentElement, draft.windowOpacity ?? 100);
    return () =>
      applyWindowOpacity(
        document.documentElement,
        preferences.windowOpacity ?? 100,
      );
  }, [draft.windowOpacity, preferences.windowOpacity]);
  useEffect(() => {
    void command<boolean>("ai_key_configured")
      .then(setAiKeyConfigured)
      .catch((error) => setError(errorMessage(error)));
  }, []);
  const scheme = terminalThemes[draft.terminalTheme] ?? terminalThemes["pixiu-shell"];
  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    setError("");
    try {
      const conflict = shortcutConflict(effectiveShortcuts(draft.shortcuts));
      if (conflict) throw new Error(conflict);
      await onSave({ ...draft, platformAddress: draft.platformAddress.trim() });
      toast.success("配置已保存，刷新和重启后仍然有效");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function saveAi(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (!draft.aiBaseUrl.trim() || !draft.aiModel.trim())
        throw new Error("请填写 OpenAI 兼容网关地址和模型名称");
      if (!aiKeyConfigured && !apiKey.trim())
        throw new Error("请填写 API Key；密钥只会保存到系统凭据库");
      await onSave({
        ...draft,
        aiBaseUrl: draft.aiBaseUrl.trim().replace(/\/+$/, ""),
        aiModel: draft.aiModel.trim(),
      });
      if (apiKey.trim()) {
        await command("ai_key_save", { apiKey: apiKey.trim() });
        setApiKey("");
        setAiKeyConfigured(true);
      }
      toast.success("AI 配置已保存");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function clearAiKey() {
    setSaving(true);
    setError("");
    try {
      await command("ai_key_save", { apiKey: "", clear: true });
      setAiKeyConfigured(false);
      toast.success("已清除本机 AI API Key");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function deleteItem() {
    if (!remove) return;
    setSaving(true);
    try {
      if (remove.kind === "hosts") {
        for (const id of remove.ids ?? []) {
          await command("delete_host", { id });
        }
        setSelectedHosts([]);
      } else {
        await command("delete_host", { id: remove.id });
      }
      await refresh();
      setRemove(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  /** 逐台测试 SSH/SFTP 连通性；未保存凭据的主机会由后端返回可读的失败原因。 */
  async function testHost(host: LocalHost) {
    setCheckingHost(host.id);
    try {
      await command<{ message: string }>(
        "local_connectivity_test",
        {
          host: { ...host, proxy: host.proxy ?? null },
          password: null,
          proxyPassword: null,
        },
      );
      toast.success(`${host.address} SSH 连通正常`, {
        className: "connectivity-toast",
      });
    } catch (error) {
      toast.error(`${host.name}：${errorMessage(error)}`);
    } finally {
      setCheckingHost(null);
    }
  }
  /** 名称、地址或分组模糊匹配，搜索时前端过滤即可（本地主机量级小）。 */
  const filteredHosts = hosts.filter((host) => {
    const keyword = hostKeyword.trim().toLowerCase();
    if (!keyword) return true;
    return (
      host.name.toLowerCase().includes(keyword) ||
      host.address.toLowerCase().includes(keyword) ||
      host.group.toLowerCase().includes(keyword)
    );
  });
  const hostPageCount = Math.max(1, Math.ceil(filteredHosts.length / hostPageSize));
  const safeHostPage = Math.min(hostPage, hostPageCount);
  const pagedHosts = filteredHosts.slice(
    (safeHostPage - 1) * hostPageSize,
    safeHostPage * hostPageSize,
  );
  const hostPageNumbers = Array.from(
    { length: Math.min(hostPageCount, 5) },
    (_, index) => {
      const first = Math.min(
        Math.max(1, safeHostPage - 2),
        Math.max(1, hostPageCount - 4),
      );
      return first + index;
    },
  );
  useEffect(() => {
    setHostPage(1);
    setHostPageJump("1");
  }, [hostKeyword, hostPageSize]);
  useEffect(() => {
    if (hostPage > hostPageCount) setHostPage(hostPageCount);
  }, [hostPage, hostPageCount]);
  function goToHostPage(page: number) {
    const next = Math.min(Math.max(1, page), hostPageCount);
    setHostPage(next);
    setHostPageJump(String(next));
  }
  return (
    <div className="settings-page" data-settings-tab={tab}>
      <Tabs
        value={tab}
        onValueChange={onTab}
        orientation="vertical"
        className="settings-navigation-layout"
      >
        <TabsList className="settings-tabs">
          <TabsTrigger value="appearance">
            <Palette />
            外观与终端
          </TabsTrigger>
          <TabsTrigger value="hosts">
            <Server />
            主机管理
          </TabsTrigger>
          <TabsTrigger value="platform">
            <Building2 />
            运维平台
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles />
            AI
          </TabsTrigger>
          <TabsTrigger value="shortcuts">
            <Keyboard />
            快捷键
          </TabsTrigger>
          <TabsTrigger value="security">
            <ShieldCheck />
            安全与锁屏
          </TabsTrigger>
          {platformEnabled ? (
            <>
              <TabsTrigger value="resources">
                <Database />
                平台资源
              </TabsTrigger>
            </>
          ) : null}
        </TabsList>
        <div className="settings-main">
          {platformEnabled ? (
            <>
              <TabsContent value="resources">
                <PlatformResources
                  onChanged={refreshPlatform}
                  createRequest={resourceCreateRequest}
                  onCreateHandled={onResourceCreateHandled}
                />
              </TabsContent>
            </>
          ) : null}
          <TabsContent value="shortcuts">
            <ShortcutSettings
              values={draft.shortcuts ?? {}}
              onChange={(value) => update("shortcuts", value)}
              onSave={() => void save()}
              busy={saving}
            />
          </TabsContent>
          <TabsContent value="security">
            <LockSettings
              status={lockStatus}
              onStatus={onLockStatus}
              onLock={onLock}
            />
          </TabsContent>
          <TabsContent value="ai">
            <form onSubmit={saveAi} className="settings-form">
              <div className="settings-section">
                <h2>离线 SSH AI</h2>
                <p>
                  用于本地主机终端分析。终端上下文会先在本机脱敏；AI
                  只能分析、建议和填入命令，不能自动执行命令。
                </p>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="settings-ai-url">
                      OpenAI 兼容网关地址
                    </FieldLabel>
                    <Input
                      id="settings-ai-url"
                      type="url"
                      placeholder="https://api.openai.com/v1"
                      value={draft.aiBaseUrl}
                      onChange={(event) =>
                        update("aiBaseUrl", event.target.value)
                      }
                    />
                    <FieldDescription>
                      支持 Pixiu AI 网关或任何兼容{" "}
                      <code>/chat/completions</code> 的地址。
                    </FieldDescription>
                  </Field>
                  <div className="settings-grid">
                    <Field>
                      <FieldLabel htmlFor="settings-ai-model">
                        模型名称
                      </FieldLabel>
                      <Input
                        id="settings-ai-model"
                        placeholder="gpt-4.1-mini"
                        value={draft.aiModel}
                        onChange={(event) =>
                          update("aiModel", event.target.value)
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="settings-ai-key">API Key</FieldLabel>
                      <Input
                        id="settings-ai-key"
                        type="password"
                        autoComplete="off"
                        placeholder={
                          aiKeyConfigured
                            ? "已保存在系统凭据库；输入可覆盖"
                            : "输入 API Key"
                        }
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </Field>
                  </div>
                </FieldGroup>
                <div className="platform-explanation">
                  <Sparkles />
                  <div>
                    <h3>
                      {aiKeyConfigured ? "API Key 已配置" : "尚未配置 API Key"}
                    </h3>
                    <p>
                      密钥只保存在当前操作系统的凭据库中，不写入数据库、偏好文件或终端上下文。
                    </p>
                  </div>
                </div>
              </div>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <div className="settings-save">
                {aiKeyConfigured ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void clearAiKey()}
                  >
                    清除 API Key
                  </Button>
                ) : (
                  <span />
                )}
                <Button disabled={saving}>保存 AI 配置</Button>
              </div>
            </form>
          </TabsContent>
          <TabsContent value="appearance">
            <form onSubmit={save} className="settings-form">
              <div className="shortcut-settings-form">
                <Card className="transfer-settings">
                  <CardHeader>
                    <CardTitle>快捷命令</CardTitle>
                    <CardDescription>
                      在终端中快速上传、下载文件。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup className="shortcut-fields">
                      <Field>
                        <FieldLabel>快捷上传命令</FieldLabel>
                        <Input
                          aria-label="快捷上传命令"
                          value={draft.uploadCommand ?? "cl-u"}
                          onChange={(event) =>
                            update("uploadCommand", event.target.value)
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>快捷下载命令</FieldLabel>
                        <Input
                          aria-label="快捷下载命令"
                          value={draft.downloadCommand ?? "cl-d"}
                          onChange={(event) =>
                            update("downloadCommand", event.target.value)
                          }
                        />
                      </Field>
                    </FieldGroup>
                  </CardContent>
                  <CardFooter>
                    <FieldDescription>
                      输入 cl-u [远端目录] 或 cl-d
                      远端文件路径，回车选择本地文件。
                    </FieldDescription>
                  </CardFooter>
                </Card>
              </div>
              <div className="settings-section">
                <h2>
                  <Monitor />
                  应用外观
                </h2>
                <FieldGroup>
                  <div className="settings-grid">
                    <Field>
                      <FieldLabel>界面主题</FieldLabel>
                      <Choice
                        label="界面主题"
                        value={draft.theme}
                        onChange={(value) =>
                          update("theme", value as Preferences["theme"])
                        }
                        options={[
                          { value: "dark", label: "深色 · Graphite" },
                          { value: "light", label: "浅色 · Porcelain" },
                          { value: "system", label: "跟随系统" },
                        ]}
                      />
                      <FieldDescription>
                        主机列表、配置页面和文件面板统一切换。
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel>主机列表组织方式</FieldLabel>
                      <Choice
                        label="主机列表组织方式"
                        value={draft.groupBy}
                        onChange={(value) =>
                          update("groupBy", value as Preferences["groupBy"])
                        }
                        options={[
                          { value: "group", label: "按分组" },
                          { value: "tag", label: "按标签" },
                        ]}
                      />
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel>透明度</FieldLabel>
                    <div className="opacity-field">
                      <Slider
                        className="opacity-slider"
                        aria-label="透明度"
                        min={0}
                        max={80}
                        step={1}
                        value={[100 - (draft.windowOpacity ?? 100)]}
                        onValueChange={(value) =>
                          update("windowOpacity", 100 - (value[0] ?? 0))
                        }
                      />
                      <span className="opacity-value">
                        {100 - (draft.windowOpacity ?? 100)}%
                      </span>
                    </div>
                    <FieldDescription>
                      拖动即时生效。0%
                      为完全不透明，数值越高窗口越透；整个窗口按同一比例与桌面混合，标题栏、侧边栏、终端和文字一起变淡，不会出现深浅不一。为保可读性上限
                      80%，保存后重启仍生效。
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </div>
              <div className="settings-section">
                <h2>
                  <Palette />
                  终端配色
                </h2>
                <p className="terminal-capability">
                  xterm-256color · ANSI 256 色 · 支持 24 位 RGB 输出
                </p>
                <div
                  className="palette-grid"
                  role="radiogroup"
                  aria-label="终端配色"
                >
                  {Object.entries(terminalThemes).map(([id, palette]) => (
                    <label
                      key={id}
                      className="palette-option"
                      data-selected={id === draft.terminalTheme}
                    >
                      <input
                        type="radio"
                        name="terminal-palette"
                        value={id}
                        checked={draft.terminalTheme === id}
                        onChange={() => update("terminalTheme", id)}
                      />
                      <span
                        className="palette-mini"
                        style={{
                          background: palette.theme.background,
                          color: palette.theme.foreground,
                        }}
                      >
                        <span style={{ color: palette.theme.green }}>
                          ops@server
                        </span>
                        <span> ~/workspace</span>
                        <span className="palette-swatches">
                          {[
                            "red",
                            "green",
                            "yellow",
                            "blue",
                            "magenta",
                            "cyan",
                          ].map((color) => (
                            <i
                              key={color}
                              style={{
                                background:
                                  palette.theme[
                                    color as
                                      | "red"
                                      | "green"
                                      | "yellow"
                                      | "blue"
                                      | "magenta"
                                      | "cyan"
                                  ],
                              }}
                            />
                          ))}
                        </span>
                      </span>
                      <span className="palette-label">
                        <strong>{palette.name}</strong>
                        {id === draft.terminalTheme ? <Check /> : null}
                      </span>
                      <small>{palette.description}</small>
                    </label>
                  ))}
                </div>
                <div
                  className="terminal-preview"
                  style={{
                    background: scheme.theme.background,
                    color: scheme.theme.foreground,
                  }}
                >
                  <div>
                    <span className="preview-label">LIVE PREVIEW</span>
                    <span>{scheme.name}</span>
                  </div>
                  <pre style={{ fontSize: draft.fontSize }}>
                    <span style={{ color: scheme.theme.green }}>
                      ops@production
                    </span>
                    <span style={{ color: scheme.theme.blue }}>
                      {" "}
                      ~/services
                    </span>
                    {" $ "}
                    <span>git status</span>
                    {"\n"}
                    <span style={{ color: scheme.theme.cyan }}>
                      On branch main
                    </span>
                    {"\n"}Your branch is up to date with 'origin/main'.{"\n\n"}
                    <span style={{ color: scheme.theme.green }}>✓</span> All
                    services healthy{" "}
                    <span style={{ color: scheme.theme.yellow }}>42 ms</span>{" "}
                    <span style={{ color: scheme.theme.magenta }}>UTF-8</span>
                    {"\n"}
                    <span style={{ color: scheme.theme.green }}>❯</span>{" "}
                    <span style={{ background: scheme.theme.cursor }}> </span>
                  </pre>
                </div>
                <FieldGroup>
                  <div className="settings-grid">
                    <Field>
                      <FieldLabel htmlFor="font-size">终端字号</FieldLabel>
                      <Input
                        id="font-size"
                        type="number"
                        min={10}
                        max={24}
                        required
                        value={draft.fontSize}
                        onChange={(event) =>
                          update("fontSize", Number(event.target.value))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="scrollback">保留历史行数</FieldLabel>
                      <Input
                        id="scrollback"
                        type="number"
                        min={1000}
                        max={100000}
                        step={1000}
                        required
                        value={draft.scrollback}
                        onChange={(event) =>
                          update("scrollback", Number(event.target.value))
                        }
                      />
                    </Field>
                  </div>
                </FieldGroup>
                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="settings-save settings-save-inset">
                  <span>
                    保存本页全部设置：快捷命令、界面外观与终端偏好；快捷键缩放只影响当前窗口。
                  </span>
                  <Button size="sm" disabled={saving}>
                    保存
                  </Button>
                </div>
              </div>
            </form>
          </TabsContent>
          <TabsContent value="hosts">
            <div className="settings-section host-manage">
              {hostNotice ? (
                <div className="host-notice">
                  <NoticeInfoIcon />
                  <span>
                    管理主机，支持新增、编辑、删除、批量导入节点。节点可用于远程 SSH
                    连接。
                  </span>
                  <button
                    type="button"
                    className="host-notice__close"
                    aria-label="关闭提示"
                    onClick={() => setHostNotice(false)}
                  >
                    <X />
                  </button>
                </div>
              ) : null}
              <div className="host-toolbar">
                {selectedHosts.length === 0 ? (
                  <Button
                    className="host-primary-action"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditor({})}
                  >
                    新增主机
                  </Button>
                ) : (
                  <div className="host-toolbar__selected">
                    <span>已选 {selectedHosts.length} 项</span>
                    <button
                      type="button"
                      className="host-link"
                      onClick={() => setSelectedHosts([])}
                    >
                      清空
                    </button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() =>
                        setRemove({
                          kind: "hosts",
                          ids: selectedHosts,
                          name: `${selectedHosts.length} 台主机`,
                        })
                      }
                    >
                      批量删除
                    </Button>
                  </div>
                )}
                <div className="host-toolbar__right">
                  <div className="host-toolbar__links">
                    <button
                      type="button"
                      className="host-link"
                      onClick={() => setBatchImportOpen(true)}
                    >
                      批量导入
                    </button>
                  </div>
                  <div className="host-toolbar__fields">
                    <label className="host-filter">
                      <Search />
                      <Input
                        value={hostKeyword}
                        onChange={(event) => setHostKeyword(event.target.value)}
                        placeholder="请输入主机名称、IP 或分组"
                        aria-label="搜索主机"
                      />
                    </label>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="刷新主机列表"
                      disabled={saving}
                      onClick={() => void refresh()}
                    >
                      <RefreshCw
                        className={saving ? "animate-spin" : undefined}
                      />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="host-table-wrap">
                <table className="host-table">
                  <thead>
                    <tr>
                      <th className="host-table__check">
                        <input
                          type="checkbox"
                          aria-label="全选主机"
                          checked={
                            filteredHosts.length > 0 &&
                            selectedHosts.length === filteredHosts.length
                          }
                          onChange={(event) =>
                            setSelectedHosts(
                              event.target.checked
                                ? filteredHosts.map((host) => host.id!)
                                : [],
                            )
                          }
                        />
                      </th>
                      <th>主机名称</th>
                      <th>IP</th>
                      <th className="host-table__port">端口</th>
                      <th>认证类型</th>
                      <th>分组</th>
                      <th className="host-table__actions-head">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedHosts.map((host) => (
                      <tr
                        key={host.id}
                        data-selected={selectedHosts.includes(host.id!)}
                      >
                        <td className="host-table__check">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${host.name}`}
                            checked={selectedHosts.includes(host.id!)}
                            onChange={(event) =>
                              setSelectedHosts((current) =>
                                event.target.checked
                                  ? [...current, host.id!]
                                  : current.filter((id) => id !== host.id),
                              )
                            }
                          />
                        </td>
                        <td className="host-table__name">{host.name}</td>
                        <td className="mono">{host.address}</td>
                        <td className="host-table__port mono">{host.port}</td>
                        <td>{authLabel(host)}</td>
                        <td>{host.group || "-"}</td>
                        <td>
                          <div className="host-table__actions">
                            <button
                              type="button"
                              className="host-link"
                              disabled={checkingHost === host.id}
                              onClick={() => void testHost(host)}
                            >
                              {checkingHost === host.id
                                ? "检测中…"
                                : "检测连通性"}
                            </button>
                            <button
                              type="button"
                              className="host-link"
                              onClick={() => onConnect(host)}
                            >
                              登录
                            </button>
                            <button
                              type="button"
                              className="host-link"
                              onClick={() => setEditor({ host })}
                            >
                              编辑
                            </button>
                            <div className="host-more">
                              <button
                                type="button"
                                className="host-link host-more__trigger"
                                aria-haspopup="menu"
                                aria-expanded={hostMoreOpen === host.id}
                                onClick={() =>
                                  setHostMoreOpen((current) =>
                                    current === host.id ? null : host.id!,
                                  )
                                }
                              >
                                更多
                                <ChevronDown />
                              </button>
                              {hostMoreOpen === host.id ? (
                                <div className="host-more__menu" role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setHostMoreOpen(null);
                                      setRemove({
                                        kind: "host",
                                        id: host.id!,
                                        name: host.name,
                                      });
                                    }}
                                  >
                                    删除
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filteredHosts.length ? (
                  <div className="table-empty">
                    {hosts.length
                      ? "没有匹配的主机，换个关键词试试。"
                      : "没有本地主机。添加主机后即可连接。"}
                  </div>
                ) : null}
                <div className="host-pagination" role="navigation" aria-label="主机列表分页">
                  <span className="host-pagination__total">共 {filteredHosts.length} 条</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="上一页"
                    disabled={safeHostPage <= 1}
                    onClick={() => goToHostPage(safeHostPage - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <div className="host-pagination__pages">
                    {hostPageNumbers.map((page) => (
                      <button
                        type="button"
                        key={page}
                        className="host-pagination__page"
                        data-active={page === safeHostPage}
                        aria-current={page === safeHostPage ? "page" : undefined}
                        onClick={() => goToHostPage(page)}
                      >
                        {page}
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="下一页"
                    disabled={safeHostPage >= hostPageCount}
                    onClick={() => goToHostPage(safeHostPage + 1)}
                  >
                    <ChevronRight />
                  </Button>
                  <Select
                    value={String(hostPageSize)}
                    onValueChange={(value) => setHostPageSize(Number(value))}
                  >
                    <SelectTrigger className="host-pagination__size" aria-label="每页条数">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="host-pagination__size-content">
                      {[10, 20, 30, 50, 100].map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}条/页
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label className="host-pagination__jump">
                    前往
                    <Input
                      inputMode="numeric"
                      aria-label="跳转页码"
                      value={hostPageJump}
                      onChange={(event) => setHostPageJump(event.target.value.replace(/[^0-9]/g, ""))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          goToHostPage(Number(hostPageJump) || 1);
                        }
                      }}
                      onBlur={() => goToHostPage(Number(hostPageJump) || 1)}
                    />
                    页
                  </label>
                </div>
              </div>
              <div className="host-engine">
                <FieldGroup>
                  <Field>
                    <FieldLabel>SSH 引擎</FieldLabel>
                    <Choice
                      label="SSH 引擎"
                      value={draft.sshEngine ?? "builtin"}
                      onChange={(value) =>
                        update("sshEngine", value as Preferences["sshEngine"])
                      }
                      options={[
                        { value: "builtin", label: "内置（推荐）" },
                        { value: "system", label: "系统 OpenSSH" },
                      ]}
                    />
                    <FieldDescription>
                      内置引擎在应用内完成连接、终端与隧道，不依赖系统 OpenSSH
                      组件。仅在算法协商失败或需要跳板机时切换回系统引擎，
                      该开关对所有本机会话生效。
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="platform">
            <form onSubmit={save} className="settings-form">
              <div className="settings-section">
                <h2>平台连接</h2>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="settings-platform">
                      运维平台地址
                    </FieldLabel>
                    <Input
                      id="settings-platform"
                      type="url"
                      placeholder="https://ops.example.com"
                      value={draft.platformAddress}
                      onChange={(event) =>
                        update("platformAddress", event.target.value)
                      }
                    />
                    <FieldDescription>
                      填写平台根地址，不含 /api/v1。仅本机开发允许
                      HTTP。修改地址会断开平台会话。
                    </FieldDescription>
                  </Field>
                </FieldGroup>
                <div className="platform-explanation">
                  <Building2 />
                  <div>
                    <h3>统一身份与资源授权</h3>
                    <p>
                      平台模式支持账号密码和钉钉弹窗登录，主机、账号、访问通道和审计沿用平台。离线模式始终无需登录。
                    </p>
                  </div>
                </div>
                {error ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="settings-save settings-save-inset">
                  <span>平台地址保存到本机，登录密码不会保存在这里。</span>
                  <Button size="sm" disabled={saving}>
                    保存
                  </Button>
                </div>
              </div>
            </form>
          </TabsContent>
        </div>
      </Tabs>
      {editor ? (
        <HostEditor
          host={editor.host}
          onClose={() => setEditor(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      <BatchImportDialog
        open={batchImportOpen}
        onOpenChange={setBatchImportOpen}
        onImported={() => refresh()}
      />
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open && !saving) setRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {remove?.kind === "hosts"
                ? `删除选中的 ${remove.ids?.length ?? 0} 台主机？`
                : `删除主机“${remove?.name}”？`}
            </DialogTitle>
            <DialogDescription>
              本地主机配置及保存的凭据将被删除。已打开的会话不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemove(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => void deleteItem()}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
