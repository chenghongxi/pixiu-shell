import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  File,
  FileCode2,
  FileArchive,
  FileText,
  Image,
  ShieldCheck,
  Folder,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { command, errorMessage, type FileItem, type Target } from "@/lib/api";

const directory = (file: FileItem) => ["directory", "dir"].includes(file.kind);
function fileStyle(file: FileItem) {
  if (directory(file)) return { kind: "folder", Icon: Folder };
  if (/\.(zip|gz|tgz|tar|7z|xz|bz2)$/i.test(file.name))
    return { kind: "archive", Icon: FileArchive };
  if (/\.(png|jpg|jpeg|webp|svg|gif)$/i.test(file.name))
    return { kind: "image", Icon: Image };
  if (/\.(sh|py|js|ts|json|yaml|yml|toml|conf|rs|go)$/i.test(file.name))
    return { kind: "code", Icon: FileCode2 };
  if (/\.(log|txt|md|csv)$/i.test(file.name))
    return { kind: "text", Icon: FileText };
  return { kind: "file", Icon: File };
}
const sizeLabel = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 ** 2).toFixed(1)} MiB`;
export function FileManager({
  target,
  name,
  onClose,
}: {
  target: Target;
  name: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/");
  const [input, setInput] = useState("/");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<FileItem | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    setFiles([]);
    try {
      const files = await command<FileItem[]>("file_list", { target, path });
      if (current === generation.current)
        setFiles(
          files.sort(
            (a, b) =>
              Number(directory(b)) - Number(directory(a)) ||
              a.name.localeCompare(b.name),
          ),
        );
    } catch (error) {
      if (current === generation.current) setError(errorMessage(error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [target, path]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
      // Invalidate pending IO, not a DOM reference.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [load]);
  function navigate(next: string) {
    setInput(next);
    setPath(next);
  }
  async function transfer(operation: "upload" | "download", file?: FileItem) {
    setBusy(true);
    setError("");
    try {
      const result = await command<{ cancelled: boolean }>(
        `file_${operation}`,
        {
          target,
          ...(operation === "upload"
            ? { directory: path }
            : { path: file?.path }),
        },
      );
      if (!result.cancelled) {
        toast.success(operation === "upload" ? "上传完成" : "下载完成");
        if (operation === "upload") await load();
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function deleteFile() {
    if (!remove) return;
    setBusy(true);
    try {
      await command("file_delete", { target, path: remove.path });
      setRemove(null);
      await load();
      toast.success("远程文件已删除");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="file-panel">
      <header>
        <div>
          <Folder />
          <strong>文件管理</strong>
          <span>{name}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭文件面板"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <form
        className="file-path"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(input);
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={busy || path === "/"}
          aria-label="上级目录"
          onClick={() =>
            navigate(
              path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/",
            )
          }
        >
          <ArrowUp />
        </Button>
        <Input
          aria-label="远程目录"
          value={input}
          disabled={busy}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          前往
        </Button>
      </form>
      <div className="file-toolbar">
        <span>
          {loading
            ? "读取目录…"
            : `${files.filter(directory).length} 个目录 · ${files.filter((file) => !directory(file)).length} 个文件`}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新文件列表"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || loading || !!error}
          onClick={() => void transfer("upload")}
        >
          <Upload data-icon="inline-start" />
          上传
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive" className="file-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="file-items" aria-busy={loading || busy}>
        {loading ? (
          <div className="table-empty">
            <LoaderCircle className="animate-spin" />
            读取远程文件…
          </div>
        ) : (
          files.map((file) => {
            const { kind, Icon } = fileStyle(file);
            return (
              <div key={file.path} className="file-row" data-kind={kind}>
                <button
                  disabled={busy || !directory(file)}
                  onClick={() => navigate(file.path)}
                  title={file.name}
                >
                  <span className="file-type-icon">
                    <Icon />
                  </span>
                  <span>
                    <strong>{file.name}</strong>
                    <small>
                      {directory(file) ? "目录" : sizeLabel(file.size)}
                      {file.permissions ? ` · ${file.permissions}` : ""}
                    </small>
                  </span>
                </button>
                {!directory(file) ? (
                  <div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      aria-label={`下载 ${file.name}`}
                      onClick={() => void transfer("download", file)}
                    >
                      <Download />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      aria-label={`删除文件 ${file.name}`}
                      onClick={() => setRemove(file)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
        {!loading && !error && !files.length ? (
          <div className="table-empty">此目录为空</div>
        ) : null}
      </div>
      <footer>
        {busy ? (
          <>
            <LoaderCircle className="animate-spin" />
            正在处理文件，请稍候…
          </>
        ) : (
          <>
            <ShieldCheck /> {target.mode === "local" ? "SFTP" : "平台文件网关"}{" "}
            · 单文件上限 64 MiB
          </>
        )}
      </footer>
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open && !busy) setRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除远程文件？</DialogTitle>
            <DialogDescription>
              将永久删除 {remove?.path}。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void deleteFile()}
            >
              确认删除文件
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
