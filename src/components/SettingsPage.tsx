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
  Database,
  Keyboard,
  ShieldCheck,
  FolderPlus,
  Import,
  Monitor,
  Palette,
  Server,
  ServerPlus,
  Building2,
  Sparkles,
  Trash2,
  Pencil,
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
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HostEditor } from "./HostEditor";
import { Choice } from "./Choice";
import { terminalThemes } from "@/lib/themes";
import {
  command,
  errorMessage,
  type LocalHost,
  type Preferences,
} from "@/lib/api";

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
  groups,
  refresh,
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
  groups: string[];
  refresh: () => Promise<void>;
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
  const [groupEditor, setGroupEditor] = useState<{
    previous?: string;
    name: string;
  } | null>(null);
  const [remove, setRemove] = useState<{
    kind: "host" | "group";
    id: string;
    name: string;
  } | null>(null);
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
    const root = document.documentElement;
    root.style.opacity = String((draft.windowOpacity ?? 100) / 100);
    return () => {
      root.style.opacity = String((preferences.windowOpacity ?? 100) / 100);
    };
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
  async function saveGroup(event: FormEvent) {
    event.preventDefault();
    if (!groupEditor) return;
    setSaving(true);
    try {
      await command("group_save", {
        previous: groupEditor.previous ?? null,
        name: groupEditor.name,
      });
      await refresh();
      setGroupEditor(null);
      toast.success("分组已保存");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function deleteItem() {
    if (!remove) return;
    setSaving(true);
    try {
      await command(
        remove.kind === "host" ? "delete_host" : "group_delete",
        remove.kind === "host" ? { id: remove.id } : { name: remove.name },
      );
      await refresh();
      setRemove(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  async function importOpenSshConfig() {
    setSaving(true);
    try {
      const result = await command<{ cancelled: boolean; count: number }>("openssh_config_import");
      if (!result.cancelled) {
        await refresh();
        toast.success(result.count ? `已导入 ${result.count} 台 OpenSSH 主机` : "没有可导入的 OpenSSH 主机");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
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
            主机与分组
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
              <p>用于本地主机终端分析。终端上下文会先在本机脱敏；AI 只能分析、建议和填入命令，不能自动执行命令。</p>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="settings-ai-url">OpenAI 兼容网关地址</FieldLabel>
                  <Input
                    id="settings-ai-url"
                    type="url"
                    placeholder="https://api.openai.com/v1"
                    value={draft.aiBaseUrl}
                    onChange={(event) => update("aiBaseUrl", event.target.value)}
                  />
                  <FieldDescription>支持 Pixiu AI 网关或任何兼容 <code>/chat/completions</code> 的地址。</FieldDescription>
                </Field>
                <div className="settings-grid">
                  <Field>
                    <FieldLabel htmlFor="settings-ai-model">模型名称</FieldLabel>
                    <Input
                      id="settings-ai-model"
                      placeholder="gpt-4.1-mini"
                      value={draft.aiModel}
                      onChange={(event) => update("aiModel", event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="settings-ai-key">API Key</FieldLabel>
                    <Input
                      id="settings-ai-key"
                      type="password"
                      autoComplete="off"
                      placeholder={aiKeyConfigured ? "已保存在系统凭据库；输入可覆盖" : "输入 API Key"}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </Field>
                </div>
              </FieldGroup>
              <div className="platform-explanation">
                <Sparkles />
                <div>
                  <h3>{aiKeyConfigured ? "API Key 已配置" : "尚未配置 API Key"}</h3>
                  <p>密钥只保存在当前操作系统的凭据库中，不写入数据库、偏好文件或终端上下文。</p>
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
                <Button type="button" variant="ghost" disabled={saving} onClick={() => void clearAiKey()}>
                  清除 API Key
                </Button>
              ) : <span />}
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
                <CardDescription>在终端中快速上传、下载文件。</CardDescription>
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
                  输入 cl-u [远端目录] 或 cl-d 远端文件路径，回车选择本地文件。
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
                    拖动即时生效。0% 为完全不透明，数值越高窗口越透；整个窗口按同一比例与桌面混合，标题栏、侧边栏、终端和文字一起变淡，不会出现深浅不一。为保可读性上限 80%，保存后重启仍生效。
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
                  <span style={{ color: scheme.theme.blue }}> ~/services</span>
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
          <div className="settings-section">
            <div className="section-heading">
              <div>
                <h2>本地主机</h2>
                <p>管理独立主机配置，平台主机仍由运维平台授权。</p>
              </div>
              <Button onClick={() => setEditor({})}>
                <ServerPlus data-icon="inline-start" />
                添加本地主机
              </Button>
              <Button variant="outline" disabled={saving} onClick={() => void importOpenSshConfig()}>
                <Import data-icon="inline-start" />
                导入 OpenSSH
              </Button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>名称 / 地址</th>
                    <th>账号</th>
                    <th>分组 / 标签</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {hosts.map((host) => (
                    <tr key={host.id}>
                      <td>
                        <strong>{host.name}</strong>
                        <small>
                          {host.address}:{host.port}
                        </small>
                      </td>
                      <td>
                        {host.username}
                        <small>
                          {host.identityFile
                            ? "私钥"
                            : host.hasPassword
                              ? "已保存密码"
                              : "交互 / SSH Agent"}
                          {host.tunnels.length
                            ? ` · ${host.tunnels.length} 个隧道`
                            : ""}
                        </small>
                      </td>
                      <td>
                        {host.group || "未分组"}
                        <div className="tag-list">
                          {host.tags.map((tag) => (
                            <Badge key={tag} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`编辑 ${host.name}`}
                            onClick={() => setEditor({ host })}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`删除 ${host.name}`}
                            onClick={() =>
                              setRemove({
                                kind: "host",
                                id: host.id!,
                                name: host.name,
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!hosts.length ? (
                <div className="table-empty">
                  没有本地主机。添加主机后即可连接。
                </div>
              ) : null}
            </div>
          </div>
          <div className="settings-section">
            <div className="section-heading">
              <div>
                <h2>主机分组</h2>
                <p>空分组也会保留；删除分组不会删除其中的主机。</p>
              </div>
              <Button
                variant="outline"
                onClick={() => setGroupEditor({ name: "" })}
              >
                <FolderPlus data-icon="inline-start" />
                添加分组
              </Button>
            </div>
            <div className="group-settings">
              {groups.map((group) => (
                <div key={group}>
                  <span>{group}</span>
                  <small>
                    {hosts.filter((host) => host.group === group).length} 台
                  </small>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`重命名分组 ${group}`}
                    onClick={() =>
                      setGroupEditor({ previous: group, name: group })
                    }
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除分组 ${group}`}
                    onClick={() =>
                      setRemove({ kind: "group", id: group, name: group })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
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
          groups={groups}
          onClose={() => setEditor(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
      <Dialog
        open={!!groupEditor}
        onOpenChange={(open) => {
          if (!open && !saving) setGroupEditor(null);
        }}
      >
        <DialogContent>
          <form onSubmit={saveGroup} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>
                {groupEditor?.previous ? "重命名分组" : "添加分组"}
              </DialogTitle>
              <DialogDescription>
                分组独立保存，名称更改会同步更新其中的主机。
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="group-name">分组名称</FieldLabel>
              <Input
                id="group-name"
                required
                autoFocus
                maxLength={120}
                value={groupEditor?.name ?? ""}
                onChange={(event) =>
                  setGroupEditor((current) =>
                    current
                      ? { ...current, name: event.target.value }
                      : current,
                  )
                }
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                保存分组
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open && !saving) setRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              删除{remove?.kind === "group" ? "分组" : "主机"}“{remove?.name}”？
            </DialogTitle>
            <DialogDescription>
              {remove?.kind === "group"
                ? "主机将移动到未分组，主机配置和凭据会保留。"
                : "本地主机配置及保存的凭据将被删除。已打开的会话不受影响。"}
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
