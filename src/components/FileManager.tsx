import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  ArrowUp,
  ArrowRight,
  Download,
  File,
  FileCode2,
  FileArchive,
  FileText,
  Image,
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
import { ObjectStorageFolderIcon } from "./ObjectStorageFolderIcon";

const directory = (file: FileItem) => ["directory", "dir"].includes(file.kind);
function fileStyle(file: FileItem) {
  if (directory(file)) return { kind: "folder", Icon: ObjectStorageFolderIcon };
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
  embedded = false,
}: {
  target: Target;
  name: string;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [path, setPath] = useState("/");
  const [input, setInput] = useState("/");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<FileItem | null>(null);
  const [transferTask, setTransferTask] = useState<{
    id: string;
    operation: "upload" | "download";
    name: string;
    transferred: number;
    total: number;
  } | null>(null);
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
      if (target.mode === "local") {
        const id = crypto.randomUUID();
        const name =
          operation === "download" ? (file?.name ?? "文件") : "选择的文件";
        const channel = new Channel<{
          eventType: string;
          payload?: { transferred?: number; total?: number };
        }>();
        channel.onmessage = (event) => {
          if (event.eventType === "progress")
            setTransferTask((current) =>
              current?.id === id
                ? {
                    ...current,
                    transferred:
                      event.payload?.transferred ?? current.transferred,
                    total: event.payload?.total ?? current.total,
                  }
                : current,
            );
        };
        setTransferTask({ id, operation, name, transferred: 0, total: 0 });
        const result = await command<{ cancelled: boolean }>(
          `file_${operation}_progress`,
          {
            target,
            id,
            channel,
            ...(operation === "upload"
              ? { directory: path }
              : { path: file?.path }),
          },
        );
        if (!result.cancelled) {
          toast.success(operation === "upload" ? "上传完成" : "下载完成");
          if (operation === "upload") await load();
        }
        return;
      }
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
      setTransferTask(null);
    }
  }
  async function cancelTransfer() {
    if (!transferTask) return;
    try {
      await command("file_transfer_cancel", { id: transferTask.id });
    } catch (error) {
      setError(errorMessage(error));
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
    <aside
      className={embedded ? "file-panel file-panel--embedded" : "file-panel"}
    >
      {embedded ? null : (
        <header>
          <div>
            <ObjectStorageFolderIcon />
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
      )}
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
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          disabled={busy || input === path}
          aria-label="打开路径"
          title="打开路径"
        >
          <ArrowRight />
        </Button>
      </form>
      <div className="file-toolbar">
        <span>
          {loading
            ? "读取目录…"
            : `${files.filter(directory).length} 个目录 · ${files.filter((file) => !directory(file)).length} 个文件`}
        </span>
        <div className="file-toolbar-actions">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="刷新文件列表"
            title="刷新文件列表"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={busy || loading || !!error}
            aria-label="上传文件"
            title="上传文件"
            onClick={() => void transfer("upload")}
          >
            <Upload />
          </Button>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive" className="file-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {transferTask ? (
        <div className="file-transfer-task" role="status" aria-live="polite">
          <div>
            <strong>
              {transferTask.operation === "upload" ? "正在上传" : "正在下载"}{" "}
              {transferTask.name}
            </strong>
            <span>
              {transferTask.total
                ? `${sizeLabel(transferTask.transferred)} / ${sizeLabel(transferTask.total)}`
                : "正在准备传输…"}
            </span>
          </div>
          <progress
            value={transferTask.total ? transferTask.transferred : undefined}
            max={transferTask.total || undefined}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void cancelTransfer()}
          >
            取消
          </Button>
        </div>
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
      {busy ? (
        <footer>
          <LoaderCircle className="animate-spin" />
          正在处理文件，请稍候…
        </footer>
      ) : null}
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
