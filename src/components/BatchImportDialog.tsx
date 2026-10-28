import { useEffect, useRef, useState } from "react";
import { LoaderCircle, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { command, errorMessage } from "@/lib/api";

type BatchImportPreview = {
  path: string;
  valid: BatchImportPreviewRow[];
  skipped: BatchImportUnavailableRow[];
  invalid: BatchImportUnavailableRow[];
};

type BatchImportPreviewRow = {
  row: number;
  name: string;
  address: string;
  username: string;
  port: number;
};

type BatchImportUnavailableRow = {
  row: number;
  name: string;
  address: string;
  reason: string;
};

/** 与主机管理页面一致的 Element Plus InfoFilled 图标。 */
function NoticeInfoIcon() {
  return (
    <svg
      className="batch-import-note__icon"
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M512 64a448 448 0 1 1 0 896.064A448 448 0 0 1 512 64m67.2 275.072c33.28 0 60.288-23.104 60.288-57.344s-27.072-57.344-60.288-57.344c-33.28 0-60.16 23.104-60.16 57.344s26.88 57.344 60.16 57.344M590.912 699.2c0-6.848 2.368-24.64 1.024-34.752l-52.608 60.544c-10.88 11.456-24.512 19.392-30.912 17.28a12.99 12.99 0 0 1-8.256-14.72l87.68-276.992c7.168-35.136-12.544-67.2-54.336-71.296-44.096 0-108.992 44.736-148.48 101.504 0 6.784-1.28 23.68.064 33.792l52.544-60.608c10.88-11.328 23.552-19.328 29.952-17.152a12.8 12.8 0 0 1 7.808 16.128L388.48 728.576c-10.048 32.256 8.96 63.872 55.04 71.04 67.84 0 107.904-43.648 147.456-100.416z"
      />
    </svg>
  );
}

/**
 * 批量导入：拖拽或通过系统文件选择器上传 Excel / YAML。
 * 版式对齐 pixiu-ui 的 host-batch-import 弹窗。
 */
export function BatchImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BatchImportPreview | null>(null);
  const busyRef = useRef(false);

  async function previewFile(path?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await command<BatchImportPreview | null>(
        "batch_hosts_preview",
        { path: path ?? null },
      );
      if (result) setPreview(result);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function runImport() {
    if (!preview || !preview.valid.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await command<{ count: number }>("batch_hosts_import", {
        path: preview.path,
      });
      await onImported();
      toast.success(`已导入 ${result.count} 台主机`);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) {
      setPreview(null);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const file = event.payload.paths.find((path) =>
            /\.(xlsx|xls|yaml|yml)$/i.test(path),
          );
          if (file) void previewFile(file);
          else if (event.payload.paths.length)
            toast.error("仅支持 .xlsx、.xls、.yaml 或 .yml 文件");
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        // 浏览器预览环境没有拖拽事件，忽略即可。
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
    // previewFile 只用到 ref 与 setState，无需进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function downloadTemplate(format: "excel" | "yaml") {
    try {
      const result = await command<{ cancelled: boolean }>(
        "batch_hosts_template_save",
        { format },
      );
      if (!result.cancelled)
        toast.success(`${format === "excel" ? "Excel" : "YAML"} 模板已保存`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="batch-import-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>批量导入</DialogTitle>
          <DialogDescription className="sr-only">
            支持 Excel 与 YAML 文件，密码仅写入系统凭据库。
          </DialogDescription>
        </DialogHeader>
        <div className="batch-import-body">
          <div className="batch-import-note">
            <NoticeInfoIcon />
            <span>
              请先下载模板，按模板格式填写后上传。仅支持密码认证方式，单次最多
              200 行。
            </span>
          </div>
          <button
            type="button"
            className="batch-import-drop"
            disabled={busy}
            onClick={() => void previewFile()}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <UploadCloud aria-hidden="true" />
            )}
            <span className="batch-import-drop__text">
              将文件拖到此处，或<em>点击上传</em>
            </span>
            <span className="batch-import-drop__hint">
              支持 .xlsx / .xls / .yaml / .yml 格式
            </span>
          </button>
          {preview?.valid.length ? (
            <div className="batch-import-preview">
              <table className="batch-import-table">
                <thead>
                  <tr>
                    <th>主机名称</th>
                    <th>IP 地址</th>
                    <th>用户名</th>
                    <th>端口</th>
                    <th>密码</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.valid.map((row) => (
                    <tr key={row.row}>
                      <td>{row.name}</td>
                      <td>{row.address}</td>
                      <td>{row.username}</td>
                      <td>{row.port}</td>
                      <td>****</td>
                      <td><span className="batch-import-status">待导入</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {preview && (preview.skipped.length || preview.invalid.length) ? (
            <div className="batch-import-unavailable">
              <p>
                {preview.invalid.length
                  ? `以下 ${preview.skipped.length + preview.invalid.length} 行不可导入：`
                  : `以下 ${preview.skipped.length} 行因 IP 重复已跳过：`}
              </p>
              <table className="batch-import-table">
                <thead>
                  <tr>
                    <th>行号</th>
                    <th>主机名称</th>
                    <th>IP 地址</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {[...preview.skipped, ...preview.invalid].map((row) => (
                    <tr key={`${row.row}-${row.reason}`}>
                      <td>{row.row}</td>
                      <td>{row.name || "-"}</td>
                      <td>{row.address || "-"}</td>
                      <td>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <DialogFooter className="batch-import-footer">
          <div className="batch-import-footer__left">
            <span>下载</span>
            <button
              type="button"
              className="host-link"
              disabled={busy}
              onClick={() => void downloadTemplate("excel")}
            >
              EXCEL 模板
            </button>
            <button
              type="button"
              className="host-link"
              disabled={busy}
              onClick={() => void downloadTemplate("yaml")}
            >
              YAML 模板
            </button>
          </div>
          <div className="batch-import-footer__right">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
            {preview ? (
              <Button
                disabled={busy || !preview.valid.length}
                onClick={() => void runImport()}
              >
                {busy ? "导入中..." : "导入"}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
