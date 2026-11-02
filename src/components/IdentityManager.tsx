import { useEffect, useState, type FormEvent } from "react";
import { FolderOpen, KeyRound, LockKeyhole, Pencil, Trash2 } from "lucide-react";
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
import { Choice } from "./Choice";

type Draft = Pick<SshIdentity, "name" | "path" | "algorithm" | "hasPassphrase"> & { id?: string; passphrase: string };
const emptyDraft: Draft = { name: "", path: "", algorithm: "自动识别", hasPassphrase: false, passphrase: "" };
type GenerateDraft = { name: string; path: string; algorithm: "ed25519" | "rsa"; passphrase: string };
const emptyGenerate: GenerateDraft = { name: "", path: "", algorithm: "ed25519", passphrase: "" };

export function IdentityManager() {
  const [identities, setIdentities] = useState<SshIdentity[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<SshIdentity | null>(null);
  const [generate, setGenerate] = useState<GenerateDraft | null>(null);
  const [passphrase, setPassphrase] = useState<SshIdentity | null>(null);
  const [passphraseValue, setPassphraseValue] = useState("");
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
      const saved = await command<SshIdentity>("identity_save", {
        identity: {
          id: draft.id ?? crypto.randomUUID(),
          name: draft.name,
          path: draft.path,
          keyType: "",
          algorithm: draft.algorithm,
          fingerprint: "",
        },
      });
      if (draft.passphrase) {
        await command("identity_passphrase_save", {
          id: saved.id,
          passphrase: draft.passphrase,
          clear: false,
        });
      }
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

  async function generateIdentity(event: FormEvent) {
    event.preventDefault();
    if (!generate) return;
    setBusy(true);
    setError("");
    try {
      await command<SshIdentity>("identity_generate", { request: generate });
      await refresh();
      setGenerate(null);
      toast.success("SSH 密钥对已生成");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  async function pickGeneratedPath() {
    if (!generate) return;
    try {
      const path = await command<string | null>("identity_file_save_pick", {
        algorithm: generate.algorithm,
      });
      if (path) setGenerate((value) => value && { ...value, path });
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function savePassphrase(event: FormEvent) {
    event.preventDefault();
    if (!passphrase) return;
    setBusy(true);
    setError("");
    try {
      await command("identity_passphrase_save", {
        id: passphrase.id,
        passphrase: passphraseValue || null,
        clear: !passphraseValue,
      });
      await refresh();
      setPassphrase(null);
      setPassphraseValue("");
      toast.success(passphraseValue ? "SSH 密钥口令已保存" : "SSH 密钥口令已忘记");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  function editDraft(identity: SshIdentity) {
    setError("");
    setDraft({ ...identity, passphrase: "" });
  }

  return (
    <div className="settings-section identity-manager">
      <div className="identity-manager__heading">
        <div>
          <h2>SSH 密钥</h2>
          <p>集中管理可复用的私钥引用。私钥文件不会复制或写入 Pixiu 数据库。</p>
        </div>
        <div className="identity-manager__actions">
          <Button className="host-primary-action" variant="outline" size="sm" onClick={() => { setError(""); setGenerate(emptyGenerate); }}>生成密钥对</Button>
          <Button className="host-primary-action" variant="outline" size="sm" onClick={() => { setError(""); setDraft(emptyDraft); }}>添加 SSH 密钥</Button>
        </div>
      </div>
      <div className="identity-list">
        {identities.map((identity) => (
          <div className="identity-list__row" key={identity.id}>
            <KeyRound aria-hidden="true" />
            <div className="identity-list__detail">
              <strong>{identity.name}</strong>
              <span>{identity.keyType} · {identity.fingerprint}{identity.hasPassphrase ? " · 口令已保存" : ""}</span>
              <code title={identity.path}>{identity.path}</code>
            </div>
            <div className="identity-list__actions">
              <Button variant="ghost" size="icon-sm" aria-label={`管理 ${identity.name} 的口令`} title={identity.hasPassphrase ? "更新或忘记口令" : "保存私钥口令"} onClick={() => { setError(""); setPassphraseValue(""); setPassphrase(identity); }}><LockKeyhole className={identity.hasPassphrase ? "identity-list__saved-lock" : undefined} /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`编辑 ${identity.name}`} title="编辑 SSH 密钥" onClick={() => editDraft(identity)}><Pencil /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`移除 ${identity.name}`} title="移除 SSH 密钥" onClick={() => setRemove(identity)}><Trash2 /></Button>
            </div>
          </div>
        ))}
        {!identities.length ? <p className="identity-list__empty">还没有 SSH 密钥。添加已有私钥或生成密钥对后，可在主机配置中直接选择。</p> : null}
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <Dialog open={!!draft} onOpenChange={(open) => { if (!open && !busy) setDraft(null); }}>
        <DialogContent className="identity-dialog identity-dialog--key-form">
          <form onSubmit={save}>
            <DialogHeader>
              <DialogTitle>{draft?.id ? "编辑 SSH 密钥" : "添加 SSH 密钥"}</DialogTitle>
              <DialogDescription className="sr-only">只保存名称、路径和公钥指纹。私钥仍由本机文件系统管理。</DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label><span className="identity-dialog__label"><i aria-hidden="true">*</i>名称</span><Input autoFocus value={draft?.name ?? ""} maxLength={120} placeholder="例如：生产环境 Ed25519" onChange={(event) => setDraft((value) => value && { ...value, name: event.target.value })} /></label>
              <label><span className="identity-dialog__label"><i aria-hidden="true">*</i>私钥文件</span>
                <div className="identity-dialog__path">
                  <Input value={draft?.path ?? ""} placeholder="C:\Users\name\.ssh\id_ed25519" onChange={(event) => setDraft((value) => value && { ...value, path: event.target.value })} />
                  <Button type="button" variant="outline" size="icon-sm" aria-label="选择 SSH 私钥" title="选择 SSH 私钥" onClick={() => void command<string | null>("identity_file_pick").then((path) => { if (path) setDraft((value) => value && { ...value, path }); }).catch((value) => setError(errorMessage(value)))}><FolderOpen /></Button>
                </div>
              </label>
              <>
                {draft?.id ? (
                  <label><span className="identity-dialog__label">算法</span><Input disabled value={draft.algorithm || "未识别"} /></label>
                ) : null}
                <label><span className="identity-dialog__label">私钥口令</span><Input type="password" autoComplete="new-password" value={draft?.passphrase ?? ""} placeholder={draft?.id ? (draft.hasPassphrase ? "输入新口令；留空不修改" : "选填；输入后保存到系统凭据库") : "选填；输入后保存到系统凭据库"} onChange={(event) => setDraft((value) => value && { ...value, passphrase: event.target.value })} /></label>
              </>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>取消</Button>
              <Button disabled={busy}>{busy ? "保存中…" : "确定"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!generate} onOpenChange={(open) => { if (!open && !busy) setGenerate(null); }}>
        <DialogContent className="identity-dialog identity-dialog--key-form">
          <form onSubmit={generateIdentity}>
            <DialogHeader>
              <DialogTitle>生成 SSH 密钥对</DialogTitle>
              <DialogDescription className="sr-only">生成 OpenSSH 格式的私钥和对应 .pub 公钥，完成后自动加入 SSH 密钥库。</DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label><span className="identity-dialog__label"><i aria-hidden="true">*</i>名称</span><Input autoFocus value={generate?.name ?? ""} maxLength={120} placeholder="例如：生产环境 Ed25519" onChange={(event) => setGenerate((value) => value && { ...value, name: event.target.value })} /></label>
              <label><span className="identity-dialog__label"><i aria-hidden="true">*</i>保存位置</span>
                <div className="identity-dialog__path">
                  <Input value={generate?.path ?? ""} placeholder="C:\Users\name\.ssh\id_ed25519" onChange={(event) => setGenerate((value) => value && { ...value, path: event.target.value })} />
                  <Button type="button" variant="outline" size="icon-sm" aria-label="选择私钥保存位置" title="选择私钥保存位置" onClick={() => void pickGeneratedPath()}><FolderOpen /></Button>
                </div>
              </label>
              <div className="identity-dialog__choice">
                <span className="identity-dialog__label">算法</span>
                <Choice
                  label="密钥算法"
                  value={generate?.algorithm ?? "ed25519"}
                  triggerClassName="identity-dialog__select"
                  contentClassName="identity-dialog__select-content"
                  contentPosition="popper"
                  onChange={(algorithm) => setGenerate((value) => value && { ...value, algorithm: algorithm as GenerateDraft["algorithm"] })}
                  options={[{ value: "ed25519", label: "Ed25519（推荐）" }, { value: "rsa", label: "RSA 4096" }]}
                />
              </div>
              <label><span className="identity-dialog__label">私钥口令</span><Input type="password" autoComplete="new-password" value={generate?.passphrase ?? ""} placeholder="选填；留空则生成无口令私钥" onChange={(event) => setGenerate((value) => value && { ...value, passphrase: event.target.value })} /></label>
            </div>
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setGenerate(null)}>取消</Button><Button disabled={busy}>{busy ? "生成中…" : "确定"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!passphrase} onOpenChange={(open) => { if (!open && !busy) setPassphrase(null); }}>
        <DialogContent className="identity-dialog">
          <form onSubmit={savePassphrase}>
            <DialogHeader><DialogTitle>私钥口令</DialogTitle><DialogDescription className="sr-only">口令仅保存到当前系统的安全凭据库，不会写入 Pixiu 数据库。留空保存会忘记已有口令。</DialogDescription></DialogHeader>
            <div className="identity-dialog__fields"><label>SSH 密钥<Input disabled value={passphrase?.name ?? ""} /></label><label>私钥口令<Input autoFocus type="password" autoComplete="new-password" value={passphraseValue} placeholder={passphrase?.hasPassphrase ? "输入新口令，或留空忘记" : "输入私钥口令"} onChange={(event) => setPassphraseValue(event.target.value)} /></label></div>
            <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setPassphrase(null)}>取消</Button><Button disabled={busy}>{busy ? "保存中…" : passphrase?.hasPassphrase && !passphraseValue ? "忘记口令" : "保存口令"}</Button></DialogFooter>
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
