import { useEffect, useState, type FormEvent } from "react";
import { FolderOpen, KeyRound, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { command, errorMessage, type SshIdentity } from "@/lib/api";

type Draft = Pick<SshIdentity, "name" | "path"> & { id?: string };
const emptyDraft: Draft = { name: "", path: "" };

export function IdentityManager() {
  const [identities, setIdentities] = useState<SshIdentity[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<SshIdentity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setIdentities(await command<SshIdentity[]>("identities_list"));
    } catch (value) {
      setError(errorMessage(value));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await command("identity_save", {
        identity: {
          id: draft.id ?? crypto.randomUUID(),
          name: draft.name,
          path: draft.path,
          keyType: "",
          fingerprint: "",
        },
      });
      await refresh();
      setDraft(null);
      toast.success("SSH 密钥已保存");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function removeIdentity() {
    if (!remove) return;
    setBusy(true);
    try {
      await command("identity_delete", { id: remove.id });
      await refresh();
      setRemove(null);
      toast.success("SSH 密钥已移除");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section identity-manager">
      <div className="identity-manager__heading">
        <div>
          <h2>SSH 密钥</h2>
          <p>集中管理可复用的私钥引用。私钥文件不会复制或写入 Pixiu 数据库。</p>
        </div>
        <Button
          className="host-primary-action"
          variant="outline"
          size="sm"
          onClick={() => { setError(""); setDraft(emptyDraft); }}
        >
          添加 SSH 密钥
        </Button>
      </div>
      <div className="identity-list">
        {identities.map((identity) => (
          <div className="identity-list__row" key={identity.id}>
            <KeyRound aria-hidden="true" />
            <div className="identity-list__detail">
              <strong>{identity.name}</strong>
              <span>{identity.keyType} · {identity.fingerprint}</span>
              <code title={identity.path}>{identity.path}</code>
            </div>
            <div className="identity-list__actions">
              <Button variant="ghost" size="icon-sm" aria-label={`编辑 ${identity.name}`} title="编辑身份" onClick={() => { setError(""); setDraft(identity); }}><Pencil /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`移除 ${identity.name}`} title="移除身份" onClick={() => setRemove(identity)}><Trash2 /></Button>
            </div>
          </div>
        ))}
        {!identities.length ? <p className="identity-list__empty">还没有 SSH 密钥。添加已有私钥后，可在主机配置中直接选择。</p> : null}
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <Dialog open={!!draft} onOpenChange={(open) => { if (!open && !busy) setDraft(null); }}>
        <DialogContent className="identity-dialog">
          <form onSubmit={save}>
            <DialogHeader>
              <DialogTitle>{draft?.id ? "编辑 SSH 密钥" : "添加 SSH 密钥"}</DialogTitle>
              <DialogDescription>只保存名称、路径和公钥指纹。私钥仍由本机文件系统管理。</DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label>名称<Input autoFocus value={draft?.name ?? ""} maxLength={120} placeholder="例如：生产环境 Ed25519" onChange={(event) => setDraft((value) => value && { ...value, name: event.target.value })} /></label>
              <label>私钥文件
                <div className="identity-dialog__path">
                  <Input value={draft?.path ?? ""} placeholder="C:\\Users\\name\\.ssh\\id_ed25519" onChange={(event) => setDraft((value) => value && { ...value, path: event.target.value })} />
                  <Button type="button" variant="outline" size="icon-sm" aria-label="选择 SSH 私钥" title="选择 SSH 私钥" onClick={() => void command<string | null>("identity_file_pick").then((path) => { if (path) setDraft((value) => value && { ...value, path }); }).catch((value) => setError(errorMessage(value)))}><FolderOpen /></Button>
                </div>
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>取消</Button>
              <Button disabled={busy}>{busy ? "保存中…" : "保存身份"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!remove} onOpenChange={(open) => { if (!open && !busy) setRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除 SSH 密钥“{remove?.name}”？</DialogTitle>
            <DialogDescription>不会删除磁盘上的私钥文件。已使用此身份的主机仍保留最后解析出的文件路径。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemove(null)}>取消</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeIdentity()}>移除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
