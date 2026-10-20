import { useState } from "react";
import { LockKeyhole, ShieldCheck, Unlock } from "lucide-react";
import { command, errorMessage, type LockStatus } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Alert, AlertDescription } from "./ui/alert";
export function ScreenLock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function unlock() {
    setBusy(true);
    setError("");
    try {
      await command("screen_unlock", { password });
      setPassword("");
      onUnlocked();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="screen-lock"
      role="dialog"
      aria-modal="true"
      aria-labelledby="screen-lock-title"
      aria-describedby="screen-lock-description"
      onKeyDown={(event) => {
        if (event.key === "Escape") event.preventDefault();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <LockKeyhole />
        <strong>Pixiu Shell</strong>
        <h2 id="screen-lock-title">工作区已锁定</h2>
        <p id="screen-lock-description">输入本机锁屏密码，继续使用现有会话。</p>
        <Input
          autoFocus
          type="password"
          aria-label="解锁密码"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button type="submit" disabled={busy || !password}>
          <Unlock />
          {busy ? "正在验证…" : "解锁工作区"}
        </Button>
      </form>
    </div>
  );
}
export function LockSettings({
  status,
  onStatus,
  onLock,
}: {
  status: LockStatus;
  onStatus: (status: LockStatus) => void;
  onLock: () => void;
}) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function configure(disable = false) {
    setError("");
    if (!disable && (next.length < 6 || next !== confirm)) {
      setError("请输入至少 6 个字符的密码，并保持两次输入一致");
      return;
    }
    setBusy(true);
    try {
      const value = await command<LockStatus>("lock_configure", {
        currentPassword: current,
        newPassword: disable ? "" : next,
      });
      onStatus(value);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="lock-settings">
      <CardHeader>
        <CardTitle>
          <ShieldCheck />
          锁屏保护
        </CardTitle>
        <CardDescription>
          手动锁定工作区，隐藏会话内容并暂停交互。解锁密码保存在本机系统凭据库中。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {status.configured ? (
            <Field>
              <FieldLabel>当前锁屏密码</FieldLabel>
              <Input
                aria-label="当前锁屏密码"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel>
              {status.configured ? "新锁屏密码" : "设置锁屏密码"}
            </FieldLabel>
            <Input
              aria-label="设置锁屏密码"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>确认锁屏密码</FieldLabel>
            <Input
              aria-label="确认锁屏密码"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </Field>
        </FieldGroup>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter>
        {status.configured ? (
          <Button
            variant="ghost"
            disabled={busy || !current}
            onClick={() => void configure(true)}
          >
            关闭锁屏保护
          </Button>
        ) : null}
        <span />
        {status.configured ? (
          <Button variant="outline" disabled={busy} onClick={onLock}>
            立即锁屏
          </Button>
        ) : null}
        <Button disabled={busy || !next} onClick={() => void configure()}>
          保存锁屏密码
        </Button>
      </CardFooter>
    </Card>
  );
}
