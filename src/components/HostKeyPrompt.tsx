import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, ShieldAlert } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  HOST_KEY_PROMPT_EVENT,
  HOST_KEY_RESOLVED_EVENT,
  answerHostKey,
  desktop,
  type HostKeyRequest,
} from "@/lib/api";

/** 三种询问的文案，差异集中在这里，渲染处不再逐个判断 kind。 */
const PRESENTATION: Record<
  HostKeyRequest["kind"],
  {
    title: string;
    /** 只给读屏软件，界面上不再显示。 */
    description: string;
    accept: string;
    dismiss: string;
  }
> = {
  new: {
    title: "主机指纹",
    description: "首次连接该主机，先核对指纹是否与服务器一致。",
    accept: "信任并记住",
    dismiss: "取消",
  },
  changed: {
    title: "主机指纹已变化",
    description: "本机记录的指纹与服务器返回的不一致，确认无误后再继续。",
    accept: "更新并记住",
    dismiss: "拒绝连接",
  },
  prompt: {
    title: "主机指纹",
    description: "系统 SSH 引擎提出了确认请求，请核对后决定。",
    accept: "信任并记住",
    dismiss: "取消",
  },
};

/** 把 "SHA256:xxxx" 拆成算法前缀与指纹本体，便于弱化前缀、突出指纹。 */
function splitFingerprint(value: string) {
  const match = /^(SHA1|SHA256|MD5):(.*)$/i.exec(value);
  return match ? [match[1] + ":", match[2]] : ["", value];
}

function FingerprintFact({
  label,
  value,
  muted = false,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  muted?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const [algo, body] = splitFingerprint(value);
  return (
    <div className="host-key-fact" data-muted={muted}>
      <span className="host-key-fact__label">{label}</span>
      <code className="host-key-fact__value">
        {algo ? <span className="host-key-fact__algo">{algo}</span> : null}
        {body}
        <button
          type="button"
          className="host-key-copy"
          data-copied={copied}
          aria-label={copied ? "已复制" : "复制指纹"}
          title={copied ? "已复制" : "复制指纹"}
          onClick={onCopy}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </code>
    </div>
  );
}

/**
 * 替换系统原生的指纹确认弹窗：连接线程会阻塞等这个窗口，所以每个请求都必须
 * 有结果——回答、取消，或者由后端超时收回。
 */
export function HostKeyPrompt() {
  const [requests, setRequests] = useState<HostKeyRequest[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const listening = [
      listen<HostKeyRequest>(HOST_KEY_PROMPT_EVENT, (event) => {
        setRequests((items) => [...items, event.payload]);
      }),
      listen<{ id: string }>(HOST_KEY_RESOLVED_EVENT, (event) => {
        // 连接已经放弃等待（超时或会话已关闭），弹窗不能继续留在屏幕上。
        setRequests((items) =>
          items.filter((item) => item.id !== event.payload.id),
        );
      }),
    ];
    return () => {
      void Promise.all(listening).then((off) =>
        off.forEach((unlisten) => unlisten()),
      );
    };
  }, []);
  const current = requests[0];
  async function settle(id: string, accept: boolean, remember: boolean) {
    setRequests((items) => items.filter((item) => item.id !== id));
    setCopied(null);
    try {
      await answerHostKey(id, accept, remember);
    } catch {
      // 连接可能已经结束，没有人在等这个回答。
    }
  }
  async function copyFingerprint(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(key);
    window.setTimeout(
      () => setCopied((item) => (item === key ? null : item)),
      1600,
    );
  }
  if (!current) return null;
  const view = PRESENTATION[current.kind];
  const changed = current.kind === "changed";
  const raw = current.kind === "prompt";
  const stored = current.stored;
  const target = current.address
    ? `${current.address}:${current.port}`
    : "未知主机";
  const reject = () => void settle(current.id, false, false);
  const trustOnce = () => void settle(current.id, true, false);
  const remember = () => void settle(current.id, true, true);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) reject();
      }}
    >
      <DialogContent key={current.id} className="host-key-dialog">
        <DialogHeader className="host-key-header">
          <DialogTitle>{view.title}</DialogTitle>
        </DialogHeader>
        <div className="host-key-body">
          {/* 说明文字只留给读屏软件，界面上靠标题和指纹本身表达。 */}
          <DialogDescription className="sr-only">
            {view.description}
          </DialogDescription>
          {raw ? (
            <pre className="host-key-raw">{current.prompt}</pre>
          ) : (
            <>
              <div className="host-key-target">
                <code>{target}</code>
                {current.keyType ? <span>{current.keyType}</span> : null}
              </div>
              {changed ? (
                <div className="host-key-warning">
                  <ShieldAlert />
                  <div>
                    <b>指纹变化也可能是中间人攻击</b>
                    <p>服务器重装或更换过密钥会这样，被劫持也会这样。</p>
                  </div>
                </div>
              ) : null}
              <div className="host-key-card">
                <FingerprintFact
                  label={changed ? "服务器当前指纹" : "服务器指纹"}
                  value={current.fingerprint}
                  copied={copied === "current"}
                  onCopy={() =>
                    void copyFingerprint("current", current.fingerprint)
                  }
                />
                {stored ? (
                  <FingerprintFact
                    label="本机已记录的指纹"
                    value={stored}
                    muted
                    copied={copied === "stored"}
                    onCopy={() => void copyFingerprint("stored", stored)}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
        <DialogFooter className="host-key-footer">
          <Button autoFocus variant="outline" onClick={reject}>
            {view.dismiss}
          </Button>
          {/* 系统引擎交给 OpenSSH 自己写 known_hosts，做不到「只信任本次」。 */}
          {current.supportsOnce !== false ? (
            <Button variant="outline" onClick={trustOnce}>
              仅本次信任
            </Button>
          ) : null}
          {/* 危险提示交给上面的面板，主按钮保持主色（pixiu-ui 的危险确认也是蓝按钮）。 */}
          <Button onClick={remember}>{view.accept}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
