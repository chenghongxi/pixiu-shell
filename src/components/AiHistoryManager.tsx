import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, FileText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Choice } from "@/components/Choice";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { deleteAiHistory, listAiHistory, setAiHistoryRetention, type AiConversation } from "@/lib/ai-history";

const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
  table: ({ children }) => <div className="ai-markdown-table" role="region" aria-label="Markdown 表格" tabIndex={0}><table>{children}</table></div>,
};

export function AiHistoryManager({ onContinue, toolbar }: { onContinue: (item: AiConversation) => void; toolbar?: HTMLElement | null }) {
  const [items, setItems] = useState<AiConversation[]>([]);
  const [days, setDays] = useState(30);
  const [pendingDays, setPendingDays] = useState<number | null>(null);
  const [preview, setPreview] = useState<AiConversation | null>(null);
  const [removing, setRemoving] = useState<AiConversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [retention, conversations] = await listAiHistory();
      setDays(retention);
      setItems(conversations);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function changeRetention(value: number) {
    setBusy(true);
    try {
      await setAiHistoryRetention(value);
      setPendingDays(null);
      await refresh();
      toast.success("会话保留期限已更新");
    } catch (value) {
      toast.error(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await deleteAiHistory(removing.id);
      setRemoving(null);
      if (preview?.id === removing.id) setPreview(null);
      await refresh();
      toast.success("AI 会话已删除");
    } catch (value) {
      toast.error(errorMessage(value));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ai-history-manager">
      {toolbar ? createPortal(
        <div className="ai-history-retention ai-history-retention--bar">
          <Choice label="会话保留期限" value={String(days)} disabled={busy}
            displayValue={`保留 ${days} 天`}
            triggerClassName="host-pagination__size ai-history-retention__choice"
            contentClassName="host-pagination__size-content"
            contentPosition="popper"
            options={[7, 30, 90, 180, 365].map((value) => ({ value: String(value), label: `${value} 天` }))}
            onChange={(value) => {
              const next = Number(value);
              if (next < days) setPendingDays(next);
              else void changeRetention(next);
            }} />
        </div>,
        toolbar,
      ) : null}
      {error ? <p role="alert" className="ai-history-error">{error}</p> : null}
      <div className="identity-list">
        {items.map((item) => (
          <div className="identity-list__row ai-history-row" key={item.id}>
            <div className="identity-list__detail">
              <strong title={item.title}>{item.title}</strong>
              <span>{item.target ? `主机 AI · ${item.hostName}` : "独立问答"} · {new Date(item.updatedAt * 1000).toLocaleString()}</span>
            </div>
            <div className="identity-list__actions">
              <Button variant="ghost" size="icon-sm" className="ai-history-action" aria-label={`查看 ${item.title}`} title="查看" onClick={() => setPreview(item)}><FileText /></Button>
              <Button variant="ghost" size="icon-sm" className="ai-history-action" aria-label={`删除 ${item.title}`} title="删除" onClick={() => setRemoving(item)}><Trash2 /></Button>
            </div>
          </div>
        ))}
        {!items.length && !error ? <p className="identity-list__empty">{loading ? "正在加载会话…" : "暂无 AI 会话记录"}</p> : null}
      </div>
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="ai-history-dialog">
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            <DialogDescription>{preview?.target ? `主机 AI · ${preview.hostName}` : "独立问答"}</DialogDescription>
          </DialogHeader>
          <div className="ai-history-dialog__messages">
            {preview?.messages.map((message) => (
              <div className="ai-history-dialog__message" key={message.id}>
                <strong>{message.role === "user" ? "我" : <><Bot /> AI</>}</strong>
                <div className="ai-markdown">
                  <Markdown skipHtml remarkPlugins={markdownPlugins} components={markdownComponents}>
                    {message.content || "（无内容）"}
                  </Markdown>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setPreview(null)}>关闭</Button>
            <Button onClick={() => { if (preview) { onContinue(preview); setPreview(null); } }}>继续对话</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteConfirmDialog open={!!removing} label={`确定删除会话 ${removing?.title ?? ""} 吗？`}
        hint="删除后无法恢复。" loading={busy} onOpenChange={(open) => { if (!open) setRemoving(null); }} onConfirm={() => void remove()}>
        确定删除会话“<strong>{removing?.title}</strong>”吗？
      </DeleteConfirmDialog>
      <DeleteConfirmDialog open={pendingDays !== null} title="修改保留期限"
        label={`将保留期限更改为 ${pendingDays} 天？`} hint="超过新期限的会话将立即删除，且无法恢复。"
        confirmText="确认修改" loading={busy} onOpenChange={(open) => { if (!open) setPendingDays(null); }}
        onConfirm={() => { if (pendingDays !== null) void changeRetention(pendingDays); }}>
        确定将会话保留期限改为 <strong>{pendingDays} 天</strong>吗？
      </DeleteConfirmDialog>
    </div>
  );
}
