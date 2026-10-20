import { useState, type FormEvent } from "react";
import {
  LoaderCircle,
  Plus,
  Trash2,
  KeyRound,
  Network,
  PlugZap,
  Server,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Choice } from "./Choice";
import { command, errorMessage, type LocalHost } from "@/lib/api";

const emptyHost: LocalHost = {
  id: null,
  name: "",
  address: "",
  port: 22,
  username: "root",
  group: "",
  identityFile: "",
  note: "",
  tags: [],
  tunnels: [],
  hasPassword: false,
};
export function HostEditor({
  host,
  groups,
  onClose,
  onSaved,
}: {
  host?: LocalHost;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<LocalHost>({ ...emptyHost, ...host });
  const [proxyPassword, setProxyPassword] = useState("");
  const [clearProxyPassword, setClearProxyPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [tags, setTags] = useState(host?.tags?.join(", ") ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const testKey = JSON.stringify([
    draft.address,
    draft.port,
    draft.username,
    draft.identityFile,
    draft.proxy,
    password,
    proxyPassword,
    clearPassword,
    clearProxyPassword,
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function update<K extends keyof LocalHost>(key: K, value: LocalHost[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function testConnection() {
    setTesting(true);
    setError("");
    setTestResult(null);
    try {
      const result = await command<{ message: string }>(
        "local_connectivity_test",
        {
          host: {
            ...draft,
            hasPassword: clearPassword ? false : draft.hasPassword,
            proxy: draft.proxy
              ? {
                  ...draft.proxy,
                  hasPassword: clearProxyPassword
                    ? false
                    : draft.proxy.hasPassword,
                }
              : null,
          },
          password: password || null,
          proxyPassword: proxyPassword || null,
        },
      );
      setTestResult({ key: testKey, message: result.message });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      !draft.name.trim() ||
      !draft.address.trim() ||
      !draft.username.trim() ||
      !Number.isInteger(draft.port) ||
      draft.port < 1 ||
      draft.port > 65535
    ) {
      setError(
        "请填写主机名称、地址、SSH 用户名，并设置 1–65535 范围内的端口。",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await command("save_host", {
        proxyPassword: proxyPassword || null,
        clearProxyPassword,
        host: {
          ...draft,
          name: draft.name.trim(),
          address: draft.address.trim(),
          username: draft.username.trim(),
          group: draft.group.trim(),
          tags: [
            ...new Set(
              tags
                .split(/[,，]/)
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ],
        },
        password: password || null,
        clearPassword,
      });
      toast.success("主机配置已保存");
      onSaved();
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !testing) onClose();
      }}
    >
      <DialogContent
        className="host-editor"
        showCloseButton={!busy && !testing}
      >
        <form noValidate onSubmit={save} className="flex flex-col gap-5">
          <DialogHeader className="local-host-heading">
            <span className="local-host-symbol">
              <Server />
            </span>
            <DialogTitle>{host ? "编辑主机" : "添加主机"}</DialogTitle>
            <DialogDescription>
              连接信息保存到本机，密码保存在系统凭据库。
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">基本信息</TabsTrigger>
              <TabsTrigger value="auth">
                <KeyRound />
                账号认证
              </TabsTrigger>
              <TabsTrigger value="proxy">网络代理</TabsTrigger>
              <TabsTrigger value="tunnels">
                <Network />
                隧道 {draft.tunnels.length || ""}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="proxy">
              <FieldGroup>
                <Field>
                  <FieldLabel>代理协议</FieldLabel>
                  <Choice
                    label="代理协议"
                    value={draft.proxy?.kind ?? "none"}
                    onChange={(value) =>
                      update(
                        "proxy",
                        value === "none"
                          ? null
                          : {
                              kind: value as "socks5" | "http",
                              address: draft.proxy?.address ?? "",
                              port: draft.proxy?.port ?? 1080,
                              username: draft.proxy?.username ?? "",
                              hasPassword: draft.proxy?.hasPassword ?? false,
                            },
                      )
                    }
                    options={[
                      { value: "none", label: "直连" },
                      { value: "socks5", label: "SOCKS5" },
                      { value: "http", label: "HTTP CONNECT" },
                    ]}
                  />
                </Field>
                {draft.proxy ? (
                  <>
                    <Field>
                      <FieldLabel>代理地址</FieldLabel>
                      <Input
                        aria-label="代理地址"
                        value={draft.proxy.address}
                        onChange={(e) =>
                          update("proxy", {
                            ...draft.proxy!,
                            address: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>代理端口</FieldLabel>
                      <Input
                        aria-label="代理端口"
                        type="number"
                        min={1}
                        max={65535}
                        value={draft.proxy.port}
                        onChange={(e) =>
                          update("proxy", {
                            ...draft.proxy!,
                            port: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>代理用户名</FieldLabel>
                      <Input
                        aria-label="代理用户名"
                        value={draft.proxy.username}
                        onChange={(e) =>
                          update("proxy", {
                            ...draft.proxy!,
                            username: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>代理密码</FieldLabel>
                      <Input
                        aria-label="代理密码"
                        type="password"
                        value={proxyPassword}
                        onChange={(e) => setProxyPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                      <FieldDescription>
                        密码仅保存在系统凭据库；SSH、SFTP 及快捷传输共用此代理。
                      </FieldDescription>
                    </Field>
                    {draft.proxy.hasPassword ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={clearProxyPassword}
                          onChange={(e) =>
                            setClearProxyPassword(e.target.checked)
                          }
                        />
                        删除已保存的代理密码
                      </label>
                    ) : null}
                  </>
                ) : null}
              </FieldGroup>
            </TabsContent>
            <TabsContent
              value="general"
              forceMount
              className="data-[state=inactive]:hidden"
            >
              <FieldGroup className="py-4">
                <Field>
                  <FieldLabel htmlFor="host-name">名称</FieldLabel>
                  <Input
                    autoFocus
                    id="host-name"
                    required
                    maxLength={120}
                    placeholder="例如：prod-api-01"
                    value={draft.name}
                    onChange={(event) => update("name", event.target.value)}
                  />
                </Field>
                <div className="grid grid-cols-[1fr_100px] gap-4">
                  <Field>
                    <FieldLabel htmlFor="host-address">
                      主机 / IP 地址
                    </FieldLabel>
                    <Input
                      id="host-address"
                      required
                      placeholder="192.168.1.10"
                      value={draft.address}
                      onChange={(event) =>
                        update("address", event.target.value)
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="host-port">SSH 端口</FieldLabel>
                    <Input
                      id="host-port"
                      type="number"
                      required
                      min={1}
                      max={65535}
                      value={draft.port || ""}
                      onChange={(event) =>
                        update("port", Number(event.target.value))
                      }
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="host-group">分组</FieldLabel>
                    <Input
                      id="host-group"
                      list="host-group-options"
                      placeholder="选择或输入分组"
                      value={draft.group}
                      onChange={(event) => update("group", event.target.value)}
                    />
                    <datalist id="host-group-options">
                      {groups.map((group) => (
                        <option key={group} value={group} />
                      ))}
                    </datalist>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="host-tags">标签</FieldLabel>
                    <Input
                      id="host-tags"
                      placeholder="生产, Linux, API"
                      value={tags}
                      onChange={(event) => setTags(event.target.value)}
                    />
                    <FieldDescription>
                      用逗号分隔，可按标签组织主机。
                    </FieldDescription>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="host-note">备注</FieldLabel>
                  <Textarea
                    id="host-note"
                    maxLength={2000}
                    value={draft.note}
                    onChange={(event) => update("note", event.target.value)}
                  />
                </Field>
              </FieldGroup>
            </TabsContent>
            <TabsContent
              value="auth"
              forceMount
              className="data-[state=inactive]:hidden"
            >
              <FieldGroup className="py-4">
                <Field>
                  <FieldLabel htmlFor="host-user">SSH 用户名</FieldLabel>
                  <Input
                    id="host-user"
                    required
                    value={draft.username}
                    onChange={(event) => update("username", event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="host-password">
                    密码 / 私钥口令
                  </FieldLabel>
                  <Input
                    id="host-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      draft.hasPassword && !clearPassword
                        ? "已保存；留空保持原密码"
                        : "留空则连接时交互认证"
                    }
                    disabled={clearPassword}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <FieldDescription>
                    用于 SSH 与 SFTP 自动认证。私钥已配置时，此处作为私钥口令。
                  </FieldDescription>
                  {draft.hasPassword ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setClearPassword((value) => !value);
                        setPassword("");
                      }}
                    >
                      {clearPassword ? "保留已保存密码" : "移除已保存密码"}
                    </Button>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="host-key">私钥路径（可选）</FieldLabel>
                  <Input
                    id="host-key"
                    placeholder="/Users/you/.ssh/id_ed25519"
                    value={draft.identityFile}
                    onChange={(event) =>
                      update("identityFile", event.target.value)
                    }
                  />
                  <FieldDescription>
                    私钥优先；未配置私钥或密码时使用 SSH Agent。SFTP
                    需要可用的保存凭据。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </TabsContent>
            <TabsContent
              value="tunnels"
              forceMount
              className="data-[state=inactive]:hidden"
            >
              <div className="flex flex-col gap-4 py-4">
                <p className="form-note">
                  随 SSH 终端建立、断开。监听地址固定为
                  127.0.0.1，避免暴露到外网。
                </p>
                {draft.tunnels.map((tunnel, index) => (
                  <div className="tunnel-card" key={index}>
                    <div className="flex items-center gap-3">
                      <Choice
                        label={`隧道 ${index + 1} 类型`}
                        value={tunnel.kind}
                        onChange={(kind) =>
                          update(
                            "tunnels",
                            draft.tunnels.map((item, i) =>
                              i === index
                                ? { ...item, kind: kind as typeof tunnel.kind }
                                : item,
                            ),
                          )
                        }
                        options={[
                          { value: "local", label: "本地转发 (-L)" },
                          { value: "remote", label: "远程转发 (-R)" },
                          { value: "dynamic", label: "SOCKS 代理 (-D)" },
                        ]}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除隧道 ${index + 1}`}
                        onClick={() =>
                          update(
                            "tunnels",
                            draft.tunnels.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <FieldGroup className="mt-4">
                      <div className="grid grid-cols-3 gap-3">
                        {(["listenPort", "targetHost", "targetPort"] as const)
                          .filter(
                            (key) =>
                              tunnel.kind !== "dynamic" || key === "listenPort",
                          )
                          .map((key) => (
                            <Field key={key}>
                              <FieldLabel htmlFor={`tunnel-${index}-${key}`}>
                                {key === "listenPort"
                                  ? "监听端口"
                                  : key === "targetHost"
                                    ? "目标主机"
                                    : "目标端口"}
                              </FieldLabel>
                              <Input
                                id={`tunnel-${index}-${key}`}
                                type={key === "targetHost" ? "text" : "number"}
                                min={1}
                                max={65535}
                                value={tunnel[key]}
                                onChange={(event) =>
                                  update(
                                    "tunnels",
                                    draft.tunnels.map((item, i) =>
                                      i === index
                                        ? {
                                            ...item,
                                            [key]:
                                              key === "targetHost"
                                                ? event.target.value
                                                : Number(event.target.value),
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              />
                            </Field>
                          ))}
                      </div>
                    </FieldGroup>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    update("tunnels", [
                      ...draft.tunnels,
                      {
                        kind: "local",
                        listenPort: 8080,
                        targetHost: "127.0.0.1",
                        targetPort: 80,
                      },
                    ])
                  }
                  disabled={draft.tunnels.length >= 16}
                >
                  <Plus data-icon="inline-start" />
                  添加隧道
                </Button>
              </div>
            </TabsContent>
          </Tabs>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {testResult ? (
            <div
              className="connectivity-result"
              data-status={testResult.key === testKey ? "success" : "stale"}
              role="status"
            >
              <CheckCircle2 />
              <div>
                <strong>
                  {testResult.key === testKey
                    ? "SSH / SFTP 连通性检测通过"
                    : "连接配置已修改，请重新检测"}
                </strong>
                <p>{testResult.message}</p>
              </div>
            </div>
          ) : null}
          <DialogFooter className="local-host-footer">
            <Button
              type="button"
              variant="outline"
              disabled={busy || testing}
              onClick={() => void testConnection()}
            >
              {testing ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <PlugZap />
              )}
              {testing ? "正在检测…" : "连通性检测"}
            </Button>
            <span />

            <Button
              type="button"
              variant="outline"
              disabled={busy || testing}
              onClick={onClose}
            >
              取消
            </Button>
            <Button disabled={busy || testing} type="submit">
              {busy ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              保存主机
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
