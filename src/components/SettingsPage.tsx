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
import { lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import {
  Check,
  Bot,
  Database,
  Keyboard,
  ShieldCheck,
  Monitor,
  Palette,
  Pencil,
  Building2,
  RefreshCw,
  Trash2,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IdentityManager } from "./IdentityManager";
import type { AiConversation } from "@/lib/ai-history";
import { Choice } from "./Choice";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyWindowOpacity, terminalThemes } from "@/lib/themes";
import {
  command,
  errorMessage,
  type AiGateway,
  type Preferences,
} from "@/lib/api";

const AiHistoryManager = lazy(() =>
  import("./AiHistoryManager").then((module) => ({ default: module.AiHistoryManager })),
);

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
  tab,
  onTab,
  onContinueAi,
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
  tab: string;
  onTab: (value: string) => void;
  onContinueAi: (item: AiConversation) => void;
}) {
  const [draft, setDraft] = useState(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [aiTab, setAiTab] = useState("gateways");
  const [historyToolbar, setHistoryToolbar] = useState<HTMLDivElement | null>(null);
  const openGatewayEditor = useRef<(() => void) | null>(null);
  useEffect(() => {
    // Native bootstrap and global theme controls can update saved preferences.
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft(preferences);
  }, [preferences]);
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
  return (
    <div className="settings-page" data-settings-tab={tab === "hosts" ? "appearance" : tab}>
      <Tabs
        value={tab === "hosts" ? "appearance" : tab}
        onValueChange={onTab}
        orientation="vertical"
        className="settings-navigation-layout"
      >
        <TabsList className="settings-tabs">
          <TabsTrigger value="appearance">
            <Palette />
            外观与终端
          </TabsTrigger>
          <TabsTrigger value="identities">
            <KeyRound />
            SSH 密钥
          </TabsTrigger>
          <TabsTrigger value="platform">
            <Building2 />
            运维平台
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Bot />
            AI 管理
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
          <TabsContent value="identities">
            <IdentityManager />
          </TabsContent>
          <TabsContent value="ai">
            <div className="settings-section identity-manager ai-management">
              <div className="identity-manager__heading">
                <h2>AI 管理</h2>
                <p>管理网关、模型和本机上的会话。</p>
              </div>
              <Tabs value={aiTab} onValueChange={setAiTab} className="ai-management-tabs">
                <div className="ai-management__toolbar">
                  <TabsList variant="line">
                    <TabsTrigger value="gateways">网关</TabsTrigger>
                    <TabsTrigger value="history">会话</TabsTrigger>
                  </TabsList>
                  {aiTab === "gateways" ? (
                    <Button className="host-primary-action" variant="outline" size="sm" onClick={() => openGatewayEditor.current?.()}>
                      添加网关
                    </Button>
                  ) : (
                    <div className="ai-management__retention" ref={setHistoryToolbar} />
                  )}
                </div>
                <TabsContent value="gateways">
                  <AiGatewayManager preferences={preferences} onSave={onSave} opener={openGatewayEditor} />
                </TabsContent>
                <TabsContent value="history">
                  <Suspense fallback={<p className="identity-list__empty">正在加载会话…</p>}>
                    <AiHistoryManager onContinue={onContinueAi} toolbar={historyToolbar} />
                  </Suspense>
                </TabsContent>
              </Tabs>
            </div>
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
              </div>
              <div className="settings-section">
                  <h2>SSH 连接</h2>
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
                        组件。仅在算法协商失败或需要跳板机时切换回系统引擎，该开关对所有本机会话生效。
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </div>
              <div className="settings-save settings-save-inset">
                  <span>
                    保存本页全部设置：快捷命令、界面外观、终端偏好与 SSH 引擎；快捷键缩放只影响当前窗口。
                  </span>
                  <Button size="sm" disabled={saving}>
                    保存
                  </Button>
                </div>
            </form>
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
    </div>
  );
}

function AiGatewayManager({
  preferences,
  onSave,
  opener,
}: {
  preferences: Preferences;
  onSave: (preferences: Preferences) => Promise<void>;
  opener: { current: (() => void) | null };
}) {
  const [editing, setEditing] = useState<AiGateway | null>(null);
  const [removing, setRemoving] = useState<AiGateway | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const modelRequest = useRef(0);
  const modelTimer = useRef<number | undefined>(undefined);
  const editorVersion = useRef(0);
  const editorDialog = useRef<HTMLDivElement>(null);
  const gateways = preferences.aiGateways;
  const original = editing && gateways.find((gateway) => gateway.id === editing.id);
  const addressChanged = !!original && original.baseUrl !== editing?.baseUrl.trim().replace(/\/+$/, "");

  function updated(gateways: AiGateway[], activeAiGatewayId: string | null): Preferences {
    return {
      ...preferences,
      aiName: "",
      aiBaseUrl: "",
      aiModel: "",
      aiGateways: gateways,
      activeAiGatewayId,
    };
  }

  async function fetchModels(gateway: AiGateway, key: string, useSavedKey: boolean, silent = false) {
    window.clearTimeout(modelTimer.current);
    modelTimer.current = undefined;
    const request = ++modelRequest.current;
    setLoadingModels(true);
    setError("");
    setModels([]);
    try {
      if (!gateway.baseUrl.trim()) throw new Error("请先填写网关地址");
      if (!key.trim() && !useSavedKey) throw new Error("请先填写此网关的 API Key");
      const result = await command<string[]>("ai_models", {
        baseUrl: gateway.baseUrl.trim(),
        apiKey: key.trim(),
        gatewayId: useSavedKey ? gateway.id : null,
      });
      if (request !== modelRequest.current) return;
      if (!result.length) throw new Error("网关未返回可用模型");
      setModels(result);
      if (!silent) toast.success(`已获取 ${result.length} 个模型`);
    } catch (value) {
      if (request === modelRequest.current) setError(errorMessage(value));
    } finally {
      if (request === modelRequest.current) setLoadingModels(false);
    }
  }

  const editingId = editing?.id;
  const editingUrl = editing?.baseUrl;
  const originalUrl = original?.baseUrl;
  useEffect(() => {
    if (!editingId || !editingUrl?.trim()) return;
    const normalizedUrl = editingUrl.trim().replace(/\/+$/, "");
    const savedKey = !!originalUrl && originalUrl === normalizedUrl && keyConfigured;
    if (!apiKey.trim() && !savedKey) return;
    try {
      const url = new URL(normalizedUrl);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return;
    } catch {
      return;
    }
    const requestVersion = modelRequest;
    const timer = window.setTimeout(() => {
      void fetchModels(
        { id: editingId, name: "", baseUrl: normalizedUrl, model: "" },
        apiKey,
        savedKey,
        true,
      );
    }, 1000);
    modelTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      requestVersion.current++;
    };
  }, [editingId, editingUrl, originalUrl, apiKey, keyConfigured]);

  function invalidateModels() {
    window.clearTimeout(modelTimer.current);
    modelTimer.current = undefined;
    modelRequest.current++;
    setLoadingModels(false);
    setModels([]);
    setError("");
  }

  function closeEditor() {
    editorVersion.current++;
    invalidateModels();
    setEditing(null);
    setApiKey("");
    setKeyConfigured(false);
  }

  async function openEditor(gateway?: AiGateway) {
    if (busy) return;
    const version = ++editorVersion.current;
    const next = gateway ?? { id: crypto.randomUUID(), name: "", baseUrl: "", model: "" };
    invalidateModels();
    setEditing(next);
    setApiKey("");
    setKeyConfigured(false);
    if (!gateway) return;
    try {
      const configured = await command<boolean>("ai_key_configured", { gatewayId: gateway.id });
      if (version === editorVersion.current) setKeyConfigured(configured);
    } catch (value) {
      if (version === editorVersion.current) setError(errorMessage(value));
    }
  }

  useImperativeHandle(opener, () => () => { void openEditor(); });

  async function saveGateway(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    let createdKey = false;
    let updatedKey = false;
    try {
      const gateway = {
        ...editing,
        name: editing.name.trim(),
        baseUrl: editing.baseUrl.trim().replace(/\/+$/, ""),
        model: editing.model.trim(),
      };
      if (!gateway.name || !gateway.baseUrl || !gateway.model) throw new Error("请填写名称、网关地址并选择模型");
      if ((!keyConfigured || addressChanged) && !apiKey.trim()) throw new Error("请填写此网关的 API Key");
      if (apiKey.trim()) {
        await command("ai_key_save", { gatewayId: gateway.id, apiKey: apiKey.trim() });
        createdKey = !original;
        updatedKey = !!original;
      }
      const next = original
        ? gateways.map((item) => item.id === gateway.id ? gateway : item)
        : [...gateways, gateway];
      await onSave(updated(next, preferences.activeAiGatewayId ?? gateway.id));
      closeEditor();
      toast.success("AI 网关已保存");
    } catch (value) {
      if (createdKey) {
        try {
          await command("ai_key_save", { gatewayId: editing.id, apiKey: "", clear: true });
        } catch {
          setError(`${errorMessage(value)}；新网关的系统凭据清理失败`);
          setBusy(false);
          return;
        }
      }
      setError(updatedKey
        ? `API Key 已更新，但网关配置保存失败：${errorMessage(value)}`
        : errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function selectGateway(gateway: AiGateway) {
    if (busy || gateway.id === preferences.activeAiGatewayId) return;
    setBusy(true);
    setError("");
    try {
      await onSave(updated(gateways, gateway.id));
      toast.success(`已切换至 ${gateway.name || "AI 网关"}`);
    } catch (value) {
      toast.error(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGateway() {
    if (!removing) return;
    setBusy(true);
    let keyCleared = false;
    try {
      await command("ai_key_save", { gatewayId: removing.id, apiKey: "", clear: true });
      keyCleared = true;
      const remaining = gateways.filter((gateway) => gateway.id !== removing.id);
      const active = preferences.activeAiGatewayId === removing.id
        ? remaining[0]?.id ?? null
        : preferences.activeAiGatewayId;
      await onSave(updated(remaining, active));
      setRemoving(null);
      toast.success("AI 网关已删除");
    } catch (value) {
      toast.error(keyCleared
        ? `API Key 已清除，但删除网关配置失败：${errorMessage(value)}`
        : `删除 AI 网关失败：${errorMessage(value)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="identity-list ai-gateway-list">
        {gateways.map((gateway) => (
          <div className="identity-list__row ai-gateway-row" key={gateway.id}>
            <button type="button" className="identity-list__detail ai-gateway-select" disabled={busy}
              aria-label={`使用 AI 网关 ${gateway.name || "AI 网关"}`}
              aria-pressed={gateway.id === preferences.activeAiGatewayId}
              title={gateway.baseUrl}
              onClick={() => void selectGateway(gateway)}>
              <span className="ai-gateway-name">
                <strong>{gateway.name || "AI 网关"}</strong>
                {gateway.id === preferences.activeAiGatewayId ? <em className="ai-gateway-live">使用中</em> : null}
              </span>
              <span className="ai-gateway-meta">{gateway.model || "未选择模型"} · {gatewayHost(gateway.baseUrl)}</span>
            </button>
            <div className="identity-list__actions">
              <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`编辑 ${gateway.name || "AI 网关"}`} title="编辑 AI 网关" onClick={() => void openEditor(gateway)}>
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`删除 ${gateway.name || "AI 网关"}`} title="删除 AI 网关" onClick={() => setRemoving(gateway)}>
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
        {!gateways.length ? <p className="identity-list__empty">还没有配置 AI 网关。添加网关和模型后即可使用 AI。</p> : null}
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => {
        if (!open && !busy) closeEditor();
      }}>
        <DialogContent
          ref={editorDialog}
          className="identity-dialog identity-dialog--key-form ai-settings-dialog"
          onOpenAutoFocus={(event) => {
            if (original) {
              event.preventDefault();
              editorDialog.current?.focus();
            }
          }}
        >
          <form onSubmit={saveGateway}>
            <DialogHeader>
              <DialogTitle>{original ? "编辑 AI 网关" : "添加 AI 网关"}</DialogTitle>
              <DialogDescription className="sr-only">配置 OpenAI 兼容网关、模型和 API Key。</DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label>
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>名称</span>
                <Input maxLength={60} placeholder="例如：我的 AI 网关" value={editing?.name ?? ""}
                  onChange={(event) => setEditing((current) => current && { ...current, name: event.target.value })} />
              </label>
              <label>
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>网关地址</span>
                <Input type="url" placeholder="https://api.openai.com/v1" value={editing?.baseUrl ?? ""}
                  onChange={(event) => {
                    invalidateModels();
                    setEditing((current) => current && { ...current, baseUrl: event.target.value, model: "" });
                  }} />
              </label>
              <label>
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>API Key</span>
                <Input type="password" autoComplete="off"
                  placeholder={keyConfigured && !addressChanged ? "已保存；输入可覆盖" : "输入 API Key"}
                  value={apiKey} onChange={(event) => {
                    invalidateModels();
                    setApiKey(event.target.value);
                    setEditing((current) => current && { ...current, model: "" });
                  }} />
              </label>
              <div className="identity-dialog__choice">
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>模型</span>
                <div className="identity-dialog__path">
                  <Choice label="模型" value={editing?.model ?? ""}
                    onChange={(model) => setEditing((current) => current && { ...current, model })}
                    options={[...new Set([...(editing?.model ? [editing.model] : []), ...models])].map((model) => ({ value: model, label: model }))}
                    disabled={loadingModels || (!editing?.model && !models.length)}
                    placeholder={loadingModels ? "正在获取模型…" : models.length ? "请选择模型" : "填写网关地址和 API Key"}
                    triggerClassName="identity-dialog__select" contentClassName="identity-dialog__select-content" contentPosition="popper" />
                  <Button type="button" variant="outline" size="icon-sm" disabled={loadingModels} aria-label="获取模型" title="获取模型"
                    onClick={() => { if (editing) void fetchModels(editing, apiKey, keyConfigured && !addressChanged); }}>
                    <RefreshCw className={loadingModels ? "animate-spin" : undefined} />
                  </Button>
                </div>
              </div>
              {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>
                取消
              </Button>
              <Button disabled={busy || loadingModels}>{busy ? "保存中…" : "确定"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DeleteConfirmDialog open={!!removing} label={`确定要删除 AI 网关“${removing?.name || "AI 网关"}”吗？`}
        hint="将同时删除保存在系统凭据库中的 API Key。" loading={busy}
        onOpenChange={(open) => { if (!open) setRemoving(null); }} onConfirm={() => void deleteGateway()}>
        确定要删除 AI 网关“<strong>{removing?.name || "AI 网关"}</strong>”吗？
      </DeleteConfirmDialog>
    </>
  );
}

function gatewayHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}
