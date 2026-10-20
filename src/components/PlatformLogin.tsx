import { useEffect, useRef, useState, type FormEvent } from "react";

import { Building2, LoaderCircle, QrCode, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  command,
  platform,
  errorMessage,
  type User,
  type Qrcode,
  type QrcodeStatus,
  type DingLogin,
} from "@/lib/api";

export function PlatformLogin({
  initialAddress,
  onClose,
  onLogin,
}: {
  initialAddress: string;
  onClose: () => void;
  onLogin: (user: User, address: string) => void;
}) {
  const address = initialAddress;
  const [tab, setTab] = useState("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qr, setQr] = useState<Qrcode | null>(null);
  const [qrMessage, setQrMessage] = useState("使用钉钉扫描二维码");
  const [organizations, setOrganizations] = useState<DingLogin | null>(null);
  const alive = useRef(true);
  const completed = useRef(false);
  const currentAddress = useRef(address);
  const onLoginRef = useRef(onLogin);
  useEffect(() => {
    onLoginRef.current = onLogin;
  }, [onLogin]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void command("dingtalk_close").catch(() => {});
    };
  }, []);

  function finish(user: User) {
    if (!alive.current) {
      void command("logout").catch(() => {});
      return;
    }
    completed.current = true;
    onLoginRef.current(user, currentAddress.current);
  }
  async function prepare() {
    setError("");
    setOrganizations(null);
    setQr(null);
    await command("configure_platform", { address: address.trim() });
    currentAddress.current = address.trim();
  }
  async function passwordLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await prepare();
      const user = await platform<User>({ type: "login", username, password });
      setPassword("");
      finish(user);
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function generateQr() {
    setBusy(true);
    try {
      await prepare();
      const qr = await command<Qrcode>("dingtalk_open");
      if (alive.current) {
        setQr(qr);
        setQrMessage("请在独立钉钉窗口扫码并确认登录");
      }
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function selectOrganization(companyId: string) {
    setBusy(true);
    setError("");
    try {
      const result = await platform<DingLogin>({
        type: "dingtalk",
        loginTicket: organizations?.loginTicket,
        companyId,
      });
      if (!result.user) throw new Error("平台未返回登录用户，请重新扫码");
      finish(result.user);
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!qr) return;
    let cancelled = false;
    let failures = 0;
    let exchanging = false;
    // This effect starts a new authorization attempt, not a render-time timestamp.
    // oxlint-disable-next-line react/purity
    const deadline = Date.now() + qr.expiresIn * 1000;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!qr || cancelled) return;
      if (Date.now() >= deadline) {
        setQr(null);
        setError("二维码已过期，请重新获取");
        return;
      }
      try {
        const status = await command<QrcodeStatus>("dingtalk_status", {
          id: qr.qrcodeId,
        });
        failures = 0;
        if (cancelled) return;
        if (status.status === "ERROR" || status.status === "CANCELLED") {
          setQr(null);
          setError(status.message || "钉钉登录窗口已关闭，请重新打开");
          return;
        }
        if (status.status === "EXPIRED") {
          setQr(null);
          setError("二维码已过期，请重新获取");
          return;
        }
        if (
          (status.status === "SUCCESS" || status.status === "CONFIRM") &&
          status.authCode
        ) {
          exchanging = true;
          setBusy(true);
          setQrMessage("授权成功，正在登录运维平台…");
          const result = await platform<DingLogin>({
            type: "dingtalk",
            authCode: status.authCode,
          });
          if (cancelled) {
            if (result.user && !completed.current)
              void command("logout").catch(() => {});
            return;
          }
          setQr(null);
          if (result.user) {
            completed.current = true;
            onLoginRef.current(result.user, currentAddress.current);
          } else if (
            result.status === "selectOrganization" &&
            result.loginTicket
          )
            setOrganizations(result);
          else throw new Error("钉钉登录响应不完整，请重试");
          setBusy(false);
          return;
        }
        setQrMessage(
          status.status === "SCAN"
            ? "已扫描，请在钉钉中确认"
            : "使用钉钉扫描二维码",
        );
        timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (!cancelled) {
          if (!exchanging && ++failures < 3 && Date.now() < deadline) {
            setQrMessage(`登录状态暂时不可用，正在重试（${failures}/3）…`);
            timer = setTimeout(() => void poll(), 2000);
          } else {
            setError(errorMessage(error));
            setQr(null);
            setBusy(false);
          }
        }
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void command("dingtalk_close", { id: qr.qrcodeId }).catch(() => {});
    };
  }, [qr]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="platform-login">
        <DialogHeader>
          <div className="login-symbol">
            <Building2 />
          </div>
          <DialogTitle>连接运维平台</DialogTitle>
          <DialogDescription>
            登录后获取平台分配给你的主机及连接权限。
          </DialogDescription>
        </DialogHeader>
        <div className="login-endpoint">
          <Building2 />
          <span>{address}</span>
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value);
            setQr(null);
            setOrganizations(null);
            setError("");
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="password" disabled={busy}>
              账号密码
            </TabsTrigger>
            <TabsTrigger value="dingtalk" disabled={busy}>
              钉钉扫码
            </TabsTrigger>
          </TabsList>
          <TabsContent value="password">
            <form onSubmit={passwordLogin} className="flex flex-col gap-5 py-3">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="platform-username">用户名</FieldLabel>
                  <Input
                    id="platform-username"
                    autoComplete="username"
                    required
                    disabled={busy}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="platform-password">密码</FieldLabel>
                  <Input
                    id="platform-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    disabled={busy}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <Button type="submit" disabled={busy || !address}>
                {busy ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : null}
                登录平台
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="dingtalk">
            <div className="qr-section">
              {organizations ? (
                <div className="flex w-full flex-col gap-3">
                  <p>选择要登录的组织</p>
                  {organizations.organizations.map((org) => (
                    <Button
                      variant="outline"
                      key={org.companyId}
                      disabled={busy}
                      onClick={() => void selectOrganization(org.companyId)}
                    >
                      {org.companyName}
                    </Button>
                  ))}
                </div>
              ) : qr ? (
                <>
                  <QrCode className="qr-placeholder" />
                  <p>{qrMessage}</p>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setQr(null)}
                  >
                    取消扫码
                  </Button>
                </>
              ) : (
                <>
                  <QrCode className="qr-placeholder" />
                  <p>在独立授权窗口中扫码登录，与 Web 平台使用相同流程</p>
                  <Button
                    disabled={busy || !address}
                    onClick={() => void generateQr()}
                  >
                    {busy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : null}
                    打开钉钉登录窗口
                  </Button>
                </>
              )}
            </div>
          </TabsContent>
        </Tabs>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <p className="login-footer">
          <ShieldCheck />
          权限由平台统一管理，主机凭据保留在平台。
        </p>
      </DialogContent>
    </Dialog>
  );
}
