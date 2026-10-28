import { useState, type FormEvent, type ReactNode } from "react";
import {
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  Minus,
  Plus,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/** 表单行：label 定宽右对齐，控件占满剩余宽度（对齐 pixiu-ui 的 el-form label-width）。 */
function Row({
  label,
  htmlFor,
  required,
  invalid,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="host-form-row" data-invalid={invalid || undefined}>
      <label className="host-form-row__label" htmlFor={htmlFor}>
        {required ? (
          <i className="host-form-required" aria-hidden="true">
            *
          </i>
        ) : null}
        {label}
      </label>
      <div className="host-form-row__control">{children}</div>
    </div>
  );
}

export function HostEditor({
  host,
  onClose,
  onSaved,
}: {
  host?: LocalHost;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<LocalHost>({ ...emptyHost, ...host });
  const [authMode, setAuthMode] = useState<"password" | "key">(
    host?.identityFile ? "key" : "password",
  );
  const [advanced, setAdvanced] = useState(false);
  const [proxyPassword, setProxyPassword] = useState("");
  const [clearProxyPassword, setClearProxyPassword] = useState(false);
  const [password, setPassword] = useState("");
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
    clearProxyPassword,
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 提交过一次后，才对缺失的必填项做字段级标红，避免刚打开就一片红框。 */
  const [fieldErrors, setFieldErrors] = useState(false);
  const hasSavedPassword = draft.hasPassword;
  const missing = {
    name: !draft.name.trim(),
    address: !draft.address.trim(),
    username: !draft.username.trim(),
    port: !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535,
    secret:
      authMode === "password"
        ? !password && !hasSavedPassword
        : !draft.identityFile.trim(),
  };
  function update<K extends keyof LocalHost>(key: K, value: LocalHost[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  /** 端口步进：保持在 1–65535，输入为空时按 22 起步。 */
  function stepPort(delta: number) {
    const next = (draft.port || 22) + delta;
    update("port", Math.min(65535, Math.max(1, next)));
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
      missing.name ||
      missing.address ||
      missing.username ||
      missing.port ||
      missing.secret
    ) {
      setFieldErrors(true);
      setError(
        authMode === "password"
          ? "请填写主机名称、IP 地址、SSH 用户与 SSH 密码。"
          : "请填写主机名称、IP 地址、SSH 用户与私钥路径。",
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
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <form
          noValidate
          autoComplete="off"
          onSubmit={save}
          className="host-editor__form"
        >
          <DialogHeader>
            <DialogTitle>{host ? "编辑节点" : "新增节点"}</DialogTitle>
            <DialogDescription className="sr-only">
              连接信息保存在本机，密码写入系统凭据库。
            </DialogDescription>
          </DialogHeader>
          <div className="host-form">
            <Row
              label="主机名称"
              htmlFor="host-name"
              required
              invalid={fieldErrors && missing.name}
            >
              <Input
                id="host-name"
                name="local-host-name"
                required
                autoComplete="off"
                maxLength={120}
                placeholder="小写字母、数字、中划线"
                aria-invalid={fieldErrors && missing.name}
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
              />
            </Row>
            <Row
              label="IP 地址"
              htmlFor="host-address"
              required
              invalid={fieldErrors && missing.address}
            >
              <Input
                id="host-address"
                name="local-host-address"
                required
                autoComplete="off"
                aria-invalid={fieldErrors && missing.address}
                value={draft.address}
                onChange={(event) => update("address", event.target.value)}
              />
            </Row>
            <Row label="分组" htmlFor="host-group">
              <Input
                id="host-group"
                placeholder="生产环境、测试环境（选填）"
                value={draft.group}
                onChange={(event) => update("group", event.target.value)}
              />
            </Row>
            <Row label="认证方式" required>
              <div
                className="host-radios"
                role="radiogroup"
                aria-label="认证方式"
              >
                <label className="host-radio">
                  <input
                    type="radio"
                    name="host-auth"
                    value="password"
                    checked={authMode === "password"}
                    onChange={() => {
                      setAuthMode("password");
                      update("identityFile", "");
                    }}
                  />
                  密码
                </label>
                <label className="host-radio">
                  <input
                    type="radio"
                    name="host-auth"
                    value="key"
                    checked={authMode === "key"}
                    onChange={() => setAuthMode("key")}
                  />
                  密钥
                </label>
              </div>
            </Row>
            <Row
              label="SSH 用户"
              htmlFor="host-user"
              invalid={fieldErrors && missing.username}
            >
              <Input
                id="host-user"
                required
                placeholder="root"
                aria-invalid={fieldErrors && missing.username}
                value={draft.username}
                onChange={(event) => update("username", event.target.value)}
              />
            </Row>
            {authMode === "password" ? (
              <Row
                label="SSH 密码"
                htmlFor="host-password"
                required
                invalid={fieldErrors && missing.secret}
              >
                <Input
                  id="host-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={hasSavedPassword ? "已保存；留空保持原密码" : undefined}
                  aria-invalid={fieldErrors && missing.secret}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Row>
            ) : (
              <Row
                label="SSH 私钥"
                htmlFor="host-key"
                required
                invalid={fieldErrors && missing.secret}
              >
                <div className="host-form-inline">
                  <Input
                    id="host-key"
                    placeholder="~/.ssh/id_ed25519"
                    aria-invalid={fieldErrors && missing.secret}
                    value={draft.identityFile}
                    onChange={(event) =>
                      update("identityFile", event.target.value)
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="选择 SSH 私钥"
                    title="选择 SSH 私钥"
                    onClick={() =>
                      void command<string | null>("identity_file_pick")
                        .then((path) => {
                          if (path) update("identityFile", path);
                        })
                        .catch((error) => setError(errorMessage(error)))
                    }
                  >
                    <FolderOpen />
                  </Button>
                </div>
                <p className="host-form-tip">
                  私钥优先于密码；填写口令时可在上方「SSH 密码」切换为密码认证。
                </p>
              </Row>
            )}
            <Row label="备注" htmlFor="host-note">
              <Textarea
                id="host-note"
                className="host-note"
                rows={3}
                maxLength={2000}
                placeholder="选填，例如用途、负责人、环境说明"
                value={draft.note}
                onChange={(event) => update("note", event.target.value)}
              />
            </Row>
            <button
              type="button"
              className="host-form-more"
              aria-expanded={advanced}
              onClick={() => setAdvanced((value) => !value)}
            >
              高级选项
              <ChevronDown data-open={advanced} />
            </button>
            {advanced ? (
              <div className="host-form-advanced">
                <Row
                  label="SSH 端口"
                  htmlFor="host-port"
                  invalid={fieldErrors && missing.port}
                >
                  <div className="host-port">
                    <button
                      type="button"
                      aria-label="减小端口"
                      onClick={() => stepPort(-1)}
                    >
                      <Minus />
                    </button>
                    <Input
                      id="host-port"
                      type="number"
                      required
                      min={1}
                      max={65535}
                      aria-invalid={fieldErrors && missing.port}
                      value={draft.port || ""}
                      onChange={(event) =>
                        update("port", Number(event.target.value))
                      }
                    />
                    <button
                      type="button"
                      aria-label="增大端口"
                      onClick={() => stepPort(1)}
                    >
                      <Plus />
                    </button>
                  </div>
                </Row>
                <Row label="标签" htmlFor="host-tags">
                  <Input
                    id="host-tags"
                    placeholder="生产, Linux, API"
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                  />
                  <p className="host-form-tip">
                    用逗号分隔，可按标签组织主机。
                  </p>
                </Row>
                <Row label="网络代理">
                  <Choice
                    label="代理协议"
                    triggerClassName="host-proxy-select"
                    contentClassName="host-proxy-select-content"
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
                  {draft.proxy ? (
                    <div className="host-proxy">
                      <Input
                        aria-label="代理地址"
                        placeholder="代理地址"
                        value={draft.proxy.address}
                        onChange={(event) =>
                          update("proxy", {
                            ...draft.proxy!,
                            address: event.target.value,
                          })
                        }
                      />
                      <Input
                        aria-label="代理端口"
                        type="number"
                        min={1}
                        max={65535}
                        placeholder="端口"
                        value={draft.proxy.port}
                        onChange={(event) =>
                          update("proxy", {
                            ...draft.proxy!,
                            port: Number(event.target.value),
                          })
                        }
                      />
                      <Input
                        aria-label="代理用户名"
                        placeholder="用户名（选填）"
                        value={draft.proxy.username}
                        onChange={(event) =>
                          update("proxy", {
                            ...draft.proxy!,
                            username: event.target.value,
                          })
                        }
                      />
                      <Input
                        aria-label="代理密码"
                        type="password"
                        autoComplete="new-password"
                        placeholder="密码（选填）"
                        value={proxyPassword}
                        onChange={(event) =>
                          setProxyPassword(event.target.value)
                        }
                      />
                      {draft.proxy.hasPassword ? (
                        <label className="host-check">
                          <input
                            type="checkbox"
                            checked={clearProxyPassword}
                            onChange={(event) =>
                              setClearProxyPassword(event.target.checked)
                            }
                          />
                          删除已保存的代理密码
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                </Row>
                <Row label="SSH 隧道">
                  <div className="host-tunnels">
                    {draft.tunnels.map((tunnel, index) => (
                      <div
                        className={`host-tunnel-row${
                          tunnel.kind === "dynamic"
                            ? " host-tunnel-row--dynamic"
                            : ""
                        }`}
                        key={index}
                      >
                          <Choice
                            label={`隧道 ${index + 1} 类型`}
                            triggerClassName="host-tunnel-kind"
                            contentClassName="host-tunnel-kind-content"
                            value={tunnel.kind}
                            onChange={(kind) =>
                              update(
                                "tunnels",
                                draft.tunnels.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        kind: kind as typeof tunnel.kind,
                                      }
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
                          {(["listenPort", "targetHost", "targetPort"] as const)
                            .filter(
                              (key) =>
                                tunnel.kind !== "dynamic" ||
                                key === "listenPort",
                            )
                            .map((key) => (
                              <Input
                                key={key}
                                aria-label={
                                  key === "listenPort"
                                    ? "监听端口"
                                    : key === "targetHost"
                                      ? "目标主机"
                                      : "目标端口"
                                }
                                placeholder={
                                  key === "listenPort"
                                    ? "监听端口"
                                    : key === "targetHost"
                                      ? "目标主机"
                                      : "目标端口"
                                }
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
                            ))}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="host-tunnel-remove"
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
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="host-tunnels__add"
                      disabled={draft.tunnels.length >= 16}
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
                    >
                      <Plus data-icon="inline-start" />
                      添加隧道
                    </Button>
                  </div>
                </Row>
              </div>
            ) : null}
          </div>
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
          <DialogFooter className="host-editor__footer">
            <Button
              type="button"
              variant="outline"
              className="host-editor__test"
              disabled={busy || testing}
              onClick={() => void testConnection()}
            >
              {testing ? <LoaderCircle className="animate-spin" /> : null}
              {testing ? "正在检测…" : "测试连接"}
            </Button>
            <div className="host-editor__footer-right">
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
                确定
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
