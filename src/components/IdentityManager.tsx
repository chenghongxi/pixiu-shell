import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Ellipsis, FolderOpen, KeyRound, LockKeyhole, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Draft = Pick<SshIdentity, "name" | "path" | "algorithm" | "hasPassphrase"> & {
  id?: string;
  passphrase: string;
};
const emptyDraft: Draft = {
  name: "",
  path: "",
  algorithm: "自动识别",
  hasPassphrase: false,
  passphrase: "",
};
type GenerateDraft = { name: string; path: string; algorithm: "ed25519" | "rsa"; passphrase: string };
const emptyGenerate: GenerateDraft = { name: "", path: "", algorithm: "ed25519", passphrase: "" };

function publicKeyLine(content: string) {
  const parts = content.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : content.trim();
}

export function IdentityManager() {
  const [identities, setIdentities] = useState<SshIdentity[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<SshIdentity | null>(null);
  const [generate, setGenerate] = useState<GenerateDraft | null>(null);
  const [passphrase, setPassphrase] = useState<SshIdentity | null>(null);
  const [passphraseValue, setPassphraseValue] = useState("");
  const [publicKey, setPublicKey] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [pageJump, setPageJump] = useState("1");

  async function refresh() {
    setIdentities(await command<SshIdentity[]>("identities_list"));
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh().catch((value) => setError(errorMessage(value)));
  }, []);

  const pageCount = Math.max(1, Math.ceil(identities.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedIdentities = identities.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pageNumbers = Array.from({ length: Math.min(pageCount, 5) }, (_, index) => {
    const first = Math.min(Math.max(1, safePage - 2), Math.max(1, pageCount - 4));
    return first + index;
  });

  useEffect(() => {
    setPage(1);
    setPageJump("1");
  }, [pageSize]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  function goToPage(nextPage: number) {
    const next = Math.min(Math.max(1, nextPage), pageCount);
    setPage(next);
    setPageJump(String(next));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await run(async () => {
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
    });
  }

  async function removeIdentity() {
    if (!remove) return;
    await run(async () => {
      await command("identity_delete", { id: remove.id });
      await refresh();
      setRemove(null);
      toast.success("SSH 密钥已移除");
    });
  }

  async function generateIdentity(event: FormEvent) {
    event.preventDefault();
    if (!generate) return;
    await run(async () => {
      await command<SshIdentity>("identity_generate", { request: generate });
      await refresh();
      setGenerate(null);
      toast.success("SSH 密钥对已生成");
    });
  }

  async function pickIdentityFile() {
    try {
      const path = await command<string | null>("identity_file_pick");
      if (path) setDraft((value) => value && { ...value, path });
    } catch (value) {
      setError(errorMessage(value));
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
    await run(async () => {
      await command("identity_passphrase_save", {
        id: passphrase.id,
        passphrase: passphraseValue || null,
        clear: !passphraseValue,
      });
      await refresh();
      setPassphrase(null);
      setPassphraseValue("");
      toast.success(passphraseValue ? "SSH 密钥口令已保存" : "SSH 密钥口令已忘记");
    });
  }

  function editDraft(identity: SshIdentity) {
    setError("");
    setDraft({ ...identity, passphrase: "" });
  }

  async function showPublicKey(identity: SshIdentity) {
    setError("");
    try {
      const key = await command<{ content: string }>("identity_public_key", { id: identity.id });
      setPublicKey({ name: identity.name, content: publicKeyLine(key.content) });
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function reveal(identity: SshIdentity, publicKeyFile = false) {
    try {
      await command("identity_reveal", { id: identity.id, publicKey: publicKeyFile });
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  return (
    <div className="settings-section identity-manager">
      <div className="identity-manager__heading">
        <div>
          <h2>SSH 密钥</h2>
          <p>集中管理可复用的私钥引用。私钥文件不会复制或写入 Pixiu 数据库。</p>
        </div>
        <div className="identity-manager__actions">
          <Button
            className="host-primary-action"
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setGenerate(emptyGenerate);
            }}
          >
            生成密钥对
          </Button>
          <Button
            className="host-primary-action"
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setDraft(emptyDraft);
            }}
          >
            添加 SSH 密钥
          </Button>
        </div>
      </div>
      <div className="identity-list">
        {pagedIdentities.map((identity) => (
          <div className="identity-list__row" key={identity.id}>
            <KeyRound aria-hidden="true" />
            <div className="identity-list__detail">
              <strong>{identity.name}</strong>
              <span>
                {identity.keyType} · {identity.fingerprint}
                {identity.hasPassphrase ? " · 口令已保存" : ""}
              </span>
              <code title={identity.path}>{identity.path}</code>
            </div>
            <div className="identity-list__actions">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`管理 ${identity.name} 的口令`}
                title={identity.hasPassphrase ? "更新或忘记口令" : "保存私钥口令"}
                onClick={() => {
                  setError("");
                  setPassphraseValue("");
                  setPassphrase(identity);
                }}
              >
                <LockKeyhole className={identity.hasPassphrase ? "identity-list__saved-lock" : undefined} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`编辑 ${identity.name}`}
                title="编辑 SSH 密钥"
                onClick={() => editDraft(identity)}
              >
                <Pencil />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`${identity.name} 的更多操作`} title="更多操作">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void showPublicKey(identity)}>查看公钥</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void reveal(identity)}>定位私钥</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void reveal(identity, true)}>定位公钥</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRemove(identity)}>删除</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
        {!identities.length ? (
          <p className="identity-list__empty">
            还没有 SSH 密钥。添加已有私钥或生成密钥对后，可在主机配置中直接选择。
          </p>
        ) : null}
        <div className="host-pagination" role="navigation" aria-label="SSH 密钥分页">
          <span className="host-pagination__total">共 {identities.length} 条</span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="上一页"
            disabled={safePage <= 1}
            onClick={() => goToPage(safePage - 1)}
          >
            <ChevronLeft />
          </Button>
          <div className="host-pagination__pages">
            {pageNumbers.map((item) => (
              <button
                type="button"
                key={item}
                className="host-pagination__page"
                data-active={item === safePage}
                aria-current={item === safePage ? "page" : undefined}
                onClick={() => goToPage(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="下一页"
            disabled={safePage >= pageCount}
            onClick={() => goToPage(safePage + 1)}
          >
            <ChevronRight />
          </Button>
          <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
            <SelectTrigger className="host-pagination__size" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="host-pagination__size-content" position="popper" side="bottom" align="start" sideOffset={6}>
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
              value={pageJump}
              onChange={(event) => setPageJump(event.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  goToPage(Number(pageJump) || 1);
                }
              }}
              onBlur={() => goToPage(Number(pageJump) || 1)}
            />
            页
          </label>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Dialog open={!!draft} onOpenChange={(open) => { if (!open && !busy) setDraft(null); }}>
        <DialogContent className="identity-dialog identity-dialog--key-form">
          <form onSubmit={save}>
            <DialogHeader>
              <DialogTitle>{draft?.id ? "编辑 SSH 密钥" : "添加 SSH 密钥"}</DialogTitle>
              <DialogDescription className="sr-only">
                只保存名称、路径和公钥指纹。私钥仍由本机文件系统管理。
              </DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label>
                <span className="identity-dialog__label">
                  <i aria-hidden="true">*</i>名称
                </span>
                <Input
                  autoFocus
                  value={draft?.name ?? ""}
                  maxLength={120}
                  placeholder="例如：生产环境 Ed25519"
                  onChange={(event) => setDraft((value) => value && { ...value, name: event.target.value })}
                />
              </label>
              <label>
                <span className="identity-dialog__label">
                  <i aria-hidden="true">*</i>私钥文件
                </span>
                <div className="identity-dialog__path">
                  <Input
                    value={draft?.path ?? ""}
                    placeholder="C:\Users\name\.ssh\id_ed25519"
                    onChange={(event) => setDraft((value) => value && { ...value, path: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="选择 SSH 私钥"
                    title="选择 SSH 私钥"
                    onClick={() => void pickIdentityFile()}
                  >
                    <FolderOpen />
                  </Button>
                </div>
              </label>
              {draft?.id ? (
                <label>
                  <span className="identity-dialog__label">算法</span>
                  <Input disabled value={draft.algorithm || "未识别"} />
                </label>
              ) : null}
              <label>
                <span className="identity-dialog__label">私钥口令</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={draft?.passphrase ?? ""}
                  placeholder={
                    draft?.id
                      ? draft.hasPassphrase
                        ? "输入新口令；留空不修改"
                        : "选填；输入后保存到系统凭据库"
                      : "选填；输入后保存到系统凭据库"
                  }
                  onChange={(event) => setDraft((value) => value && { ...value, passphrase: event.target.value })}
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
                取消
              </Button>
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
              <DialogDescription className="sr-only">
                生成 OpenSSH 格式的私钥和对应 .pub 公钥，完成后自动加入 SSH 密钥库。
              </DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label>
                <span className="identity-dialog__label">
                  <i aria-hidden="true">*</i>名称
                </span>
                <Input
                  autoFocus
                  value={generate?.name ?? ""}
                  maxLength={120}
                  placeholder="例如：生产环境 Ed25519"
                  onChange={(event) => setGenerate((value) => value && { ...value, name: event.target.value })}
                />
              </label>
              <label>
                <span className="identity-dialog__label">
                  <i aria-hidden="true">*</i>保存位置
                </span>
                <div className="identity-dialog__path">
                  <Input
                    value={generate?.path ?? ""}
                    placeholder="C:\Users\name\.ssh\id_ed25519"
                    onChange={(event) => setGenerate((value) => value && { ...value, path: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="选择私钥保存位置"
                    title="选择私钥保存位置"
                    onClick={() => void pickGeneratedPath()}
                  >
                    <FolderOpen />
                  </Button>
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
                  onChange={(algorithm) =>
                    setGenerate((value) => value && { ...value, algorithm: algorithm as GenerateDraft["algorithm"] })
                  }
                  options={[
                    { value: "ed25519", label: "Ed25519（推荐）" },
                    { value: "rsa", label: "RSA 4096" },
                  ]}
                />
              </div>
              <label>
                <span className="identity-dialog__label">私钥口令</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={generate?.passphrase ?? ""}
                  placeholder="选填；留空则生成无口令私钥"
                  onChange={(event) => setGenerate((value) => value && { ...value, passphrase: event.target.value })}
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setGenerate(null)}>
                取消
              </Button>
              <Button disabled={busy}>{busy ? "生成中…" : "确定"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!passphrase} onOpenChange={(open) => { if (!open && !busy) setPassphrase(null); }}>
        <DialogContent className="identity-dialog">
          <form onSubmit={savePassphrase}>
            <DialogHeader>
              <DialogTitle>私钥口令</DialogTitle>
              <DialogDescription className="sr-only">
                口令仅保存到当前系统的安全凭据库，不会写入 Pixiu 数据库。留空保存会忘记已有口令。
              </DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label>
                SSH 密钥
                <Input disabled value={passphrase?.name ?? ""} />
              </label>
              <label>
                私钥口令
                <Input
                  autoFocus
                  type="password"
                  autoComplete="new-password"
                  value={passphraseValue}
                  placeholder={passphrase?.hasPassphrase ? "输入新口令，或留空忘记" : "输入私钥口令"}
                  onChange={(event) => setPassphraseValue(event.target.value)}
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setPassphrase(null)}>
                取消
              </Button>
              <Button disabled={busy}>
                {busy ? "保存中…" : passphrase?.hasPassphrase && !passphraseValue ? "忘记口令" : "保存口令"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!publicKey} onOpenChange={(open) => { if (!open) setPublicKey(null); }}>
        <DialogContent
          className="identity-dialog identity-dialog--public-key"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{publicKey?.name}</DialogTitle>
            <DialogDescription>用于添加到远端主机的 authorized_keys 文件。</DialogDescription>
          </DialogHeader>
          <div className="identity-public-key">
            <div className="identity-public-key__field">
              <Input readOnly value={publicKey?.content ?? ""} aria-label="SSH 公钥内容" />
              <CopyButton
                className="identity-public-key__copy"
                label="复制公钥"
                value={publicKey?.content ?? ""}
                disabled={!publicKey}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setPublicKey(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteConfirmDialog
        open={!!remove}
        label={`确定要删除 SSH 密钥“${remove?.name}”吗？`}
        hint="不会删除磁盘上的私钥文件。已使用此密钥的主机仍会保留路径。"
        loading={busy}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
        onConfirm={() => void removeIdentity()}
      >
        确定要删除 SSH 密钥 “<strong>{remove?.name}</strong>” 吗？
      </DeleteConfirmDialog>
    </div>
  );
}
