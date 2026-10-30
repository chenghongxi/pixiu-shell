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
  FolderPlus,
  Image,
  LoaderCircle,
  EllipsisVertical,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Popover } from "radix-ui";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileCodeEditor } from "./FileCodeEditor";
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
  if (/\.(sh|bash|zsh|py|js|ts|tsx|jsx|json|yaml|yml|toml|conf|cfg|ini|env|rs|go|c|h|cpp|java|rb|php|pl|lua|sql|xml|html|htm|css|vue|ps1|bat|cmd)$/i.test(file.name))
    return { kind: "code", Icon: FileCode2 };
  if (/\.(log|txt|md|csv|rst)$/i.test(file.name) || /^\.[^.]+$/.test(file.name))
    return { kind: "text", Icon: FileText };
  return { kind: "file", Icon: File };
}
function canEdit(file: FileItem) {
  if (directory(file) || file.kind === "symlink" || file.size > 512 * 1024)
    return false;
  const { kind } = fileStyle(file);
  if (kind === "archive" || kind === "image") return false;
  return kind === "text" || kind === "code" || !file.name.includes(".");
}
const sizeLabel = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 ** 2).toFixed(1)} MiB`;

function permissionDenied(detail: string) {
  return detail === "权限不足" || /permission denied/i.test(detail);
}

function listError(path: string, username: string | undefined, error: unknown) {
  const detail = errorMessage(error).trim();
  if (permissionDenied(detail)) {
    return username
      ? `${username} 无权访问 ${path}`
      : `当前登录用户无权访问 ${path}`;
  }
  return detail;
}

function fileActionError(
  action: string,
  name: string | undefined,
  error: unknown,
  username?: string,
) {
  const detail = errorMessage(error).trim();
  const generic =
    !detail ||
    detail === "操作失败" ||
    /^(failure|failed|error)$/i.test(detail);
  let reason = generic ? "服务器拒绝了该操作" : detail;
  if (/^请/.test(reason)) return reason;
  const colon = reason.lastIndexOf("：");
  if (colon >= 0 && reason.startsWith("无法")) {
    const tail = reason.slice(colon + 1).trim();
    if (tail) reason = tail;
  }
  if (permissionDenied(reason)) {
    reason = username ? `${username} 权限不足` : "当前登录用户权限不足";
  }
  const label = name?.trim();
  return label ? `${action}「${label}」失败：${reason}` : `${action}失败：${reason}`;
}

type Prompt =
  | { kind: "mkdir"; name: string }
  | { kind: "rename"; file: FileItem; name: string }
  | { kind: "chmod"; file: FileItem; mode: string }
  | { kind: "edit"; file: FileItem; content: string; original: string }
  | { kind: "delete"; file: FileItem };

export function FileManager({
  target,
  name,
  username,
  onClose,
  embedded = false,
}: {
  target: Target;
  name: string;
  username?: string;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const local = target.mode === "local";
  const [path, setPath] = useState("");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [morePath, setMorePath] = useState<string | null>(null);
  const [transferTask, setTransferTask] = useState<{
    id: string;
    operation: "upload" | "download";
    name: string;
    transferred: number;
    total: number;
  } | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
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
      if (current === generation.current)
        setError(listError(path, username, error));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [target, path, username]);
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
  useEffect(() => {
    let cancelled = false;
    void command<string>("file_home", { target })
      .then((home) => {
        if (!cancelled) {
          setInput(home);
          setPath(home);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInput("/");
          setPath("/");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target]);
  function navigate(next: string) {
    setInput(next);
    setPath(next);
  }
  async function transfer(operation: "upload" | "download", file?: FileItem) {
    setBusy(true);
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
      toast.error(
        fileActionError(
          operation === "upload" ? "上传" : "下载",
          file?.name,
          error,
          username,
        ),
      );
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
      toast.error(fileActionError("取消传输", transferTask.name, error, username));
    }
  }
  async function openEdit(file: FileItem) {
    if (file.kind === "symlink") {
      toast.error(`编辑「${file.name}」失败：这是符号链接，无法在线编辑`);
      return;
    }
    setBusy(true);
    try {
      const content = await command<string>("file_read", {
        target,
        path: file.path,
      });
      setPrompt({ kind: "edit", file, content, original: content });
    } catch (error) {
      toast.error(fileActionError("编辑", file.name, error, username));
    } finally {
      setBusy(false);
    }
  }
  async function submitPrompt() {
    if (!prompt) return;
    setBusy(true);
    try {
      if (prompt.kind === "mkdir") {
        const name = prompt.name.trim();
        if (!name) throw new Error("请输入目录名称");
        await command("file_mkdir", { target, directory: path, name });
        toast.success("目录已创建");
      } else if (prompt.kind === "rename") {
        const name = prompt.name.trim();
        if (!name) throw new Error("请输入新名称");
        await command("file_rename", { target, path: prompt.file.path, name });
        toast.success("已重命名");
      } else if (prompt.kind === "chmod") {
        await command("file_chmod", {
          target,
          path: prompt.file.path,
          mode: prompt.mode.trim(),
        });
        toast.success("权限已更新");
      } else if (prompt.kind === "edit") {
        await command("file_write", {
          target,
          path: prompt.file.path,
          content: prompt.content,
        });
        toast.success("文件已保存");
      } else {
        await command("file_delete", { target, path: prompt.file.path });
        toast.success(directory(prompt.file) ? "远程目录已删除" : "远程文件已删除");
      }
      setPrompt(null);
      await load();
    } catch (error) {
      const name =
        prompt.kind === "mkdir" ? prompt.name : prompt.file.name;
      const action =
        prompt.kind === "mkdir"
          ? "创建目录"
          : prompt.kind === "rename"
            ? "重命名"
            : prompt.kind === "chmod"
              ? "修改权限"
              : prompt.kind === "edit"
                ? "保存"
                : "删除";
      toast.error(fileActionError(action, name, error, username));
    } finally {
      setBusy(false);
    }
  }
  const promptTitle =
    prompt?.kind === "mkdir"
      ? "新建目录"
      : prompt?.kind === "rename"
        ? directory(prompt.file)
          ? "重命名目录"
          : "重命名文件"
        : prompt?.kind === "chmod"
          ? "修改权限"
          : prompt?.kind === "edit"
            ? `编辑 ${prompt.file.name}`
            : prompt?.kind === "delete"
              ? directory(prompt.file)
                ? "删除远程目录？"
                : "删除远程文件？"
              : "";
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
          disabled={busy || !path || path === "/"}
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
          {username ? ` · 以 ${username} 访问` : ""}
        </span>
        <div className="file-toolbar-actions">
          {local ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="新建目录"
              title="新建目录"
              disabled={loading || busy || !!error}
              onClick={() => setPrompt({ kind: "mkdir", name: "" })}
            >
              <FolderPlus />
            </Button>
          ) : null}
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
        ) : error ? (
          <div className="table-empty">{error}</div>
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
                      {directory(file)
                        ? "目录"
                        : file.kind === "symlink"
                          ? "符号链接"
                          : sizeLabel(file.size)}
                      {file.permissions ? ` · ${file.permissions}` : ""}
                    </small>
                  </span>
                </button>
                <div className="file-row-actions">
                  {!directory(file) ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      aria-label={`下载 ${file.name}`}
                      title="下载"
                      onClick={() => void transfer("download", file)}
                    >
                      <Download />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={`删除${directory(file) ? "目录" : "文件"} ${file.name}`}
                    title="删除"
                    onClick={() => setPrompt({ kind: "delete", file })}
                  >
                    <Trash2 />
                  </Button>
                  <Popover.Root
                    open={morePath === file.path}
                    onOpenChange={(open) =>
                      setMorePath(open ? file.path : null)
                    }
                  >
                    <Popover.Trigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="file-row-more-trigger"
                        disabled={busy}
                        aria-label={`更多 ${file.name}`}
                        title="更多"
                      >
                        <EllipsisVertical />
                      </Button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        className="file-row-more"
                        align="end"
                        side="bottom"
                        sideOffset={4}
                        collisionPadding={8}
                        style={{ zIndex: 80 }}
                        onOpenAutoFocus={(event) => event.preventDefault()}
                      >
                        {canEdit(file) ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setMorePath(null);
                              void openEdit(file);
                            }}
                          >
                            编辑
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setMorePath(null);
                            setPrompt({
                              kind: "rename",
                              file,
                              name: file.name,
                            });
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setMorePath(null);
                            setPrompt({
                              kind: "chmod",
                              file,
                              mode: file.permissions || "644",
                            });
                          }}
                        >
                          权限
                        </button>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </div>
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
        open={!!prompt}
        onOpenChange={(open) => {
          if (!open && !busy) setPrompt(null);
        }}
      >
        <DialogContent
          className={
            prompt?.kind === "edit"
              ? "file-edit-dialog sm:max-w-[680px]"
              : prompt?.kind === "rename" ||
                  prompt?.kind === "mkdir" ||
                  prompt?.kind === "chmod"
                ? "file-form-dialog gap-0 p-0 sm:max-w-[460px]"
                : undefined
          }
        >
          <DialogHeader>
            <DialogTitle>{promptTitle}</DialogTitle>
            {prompt?.kind === "delete" ? (
              <DialogDescription>
                {directory(prompt.file)
                  ? `将删除目录 ${prompt.file.path} 及其全部内容。此操作无法撤销。`
                  : `将永久删除 ${prompt.file.path}。此操作无法撤销。`}
              </DialogDescription>
            ) : prompt?.kind === "edit" ? (
              <DialogDescription className="sr-only">
                在线编辑远程文本文件
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                {promptTitle}
              </DialogDescription>
            )}
          </DialogHeader>
          {prompt?.kind === "mkdir" ? (
            <div className="file-form">
              <div className="file-form-row">
                <span>名称</span>
                <div className="file-form-field">
                  <Input
                    autoFocus
                    placeholder="请输入目录名称"
                    value={prompt.name}
                    onChange={(event) =>
                      setPrompt({ kind: "mkdir", name: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitPrompt();
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          ) : null}
          {prompt?.kind === "rename" ? (
            <div className="file-form">
              <div className="file-rename-info">
                <p>
                  将{directory(prompt.file) ? "目录" : "文件"}{" "}
                  <code>{prompt.file.name}</code> 重命名为：
                </p>
              </div>
              <Input
                autoFocus
                placeholder="请输入新名称"
                value={prompt.name}
                onChange={(event) =>
                  setPrompt({ ...prompt, name: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
              />
            </div>
          ) : null}
          {prompt?.kind === "chmod" ? (
            <div className="file-form">
              <div className="file-form-row">
                <span>路径</span>
                <span className="file-form-value" title={prompt.file.path}>
                  {prompt.file.name}
                </span>
              </div>
              <div className="file-form-row">
                <span>权限</span>
                <div className="file-form-field">
                  <Input
                    autoFocus
                    inputMode="numeric"
                    placeholder="八进制，例如 755"
                    value={prompt.mode}
                    onChange={(event) =>
                      setPrompt({ ...prompt, mode: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitPrompt();
                      }
                    }}
                  />
                  <p className="file-form-hint">使用八进制，例如 644 或 755</p>
                </div>
              </div>
            </div>
          ) : null}
          {prompt?.kind === "edit" ? (
            <FileCodeEditor
              fileName={prompt.file.name}
              original={prompt.original}
              value={prompt.content}
              onChange={(content) => setPrompt({ ...prompt, content })}
              onSave={() => void submitPrompt()}
            />
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPrompt(null)}
            >
              取消
            </Button>
            <Button
              variant={prompt?.kind === "delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void submitPrompt()}
            >
              {prompt?.kind === "delete"
                ? "确认删除"
                : prompt?.kind === "edit"
                  ? "保存"
                  : prompt?.kind === "rename"
                    ? "重命名"
                    : "确定"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
