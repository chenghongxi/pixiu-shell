import { command, type Target } from "@/lib/api";
import type { AiAction } from "@/lib/terminal-ai";

export interface AiHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  action?: AiAction;
  createdAt?: string;
}

export interface AiConversation {
  id: string;
  target: (Target & { historyScope?: string; hostAddress?: string }) | null;
  hostName: string;
  title: string;
  messages: AiHistoryMessage[];
  updatedAt: number;
}

let queue: Promise<unknown> = Promise.resolve();
const known = new Set<string>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; item: AiConversation; onError: (error: unknown) => void }>();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(task);
  queue = next;
  return next;
}

export async function listAiHistory(): Promise<[number, AiConversation[]]> {
  await Promise.all(flushPending());
  const result = await enqueue(() => command<[number, AiConversation[]]>("ai_history_list"));
  result[1].forEach((item) => known.add(item.id));
  return result;
}

function flushItem(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  const result = enqueue(async () => {
    if (!known.has(id)) {
      await command("ai_history_create", { item: entry.item });
      known.add(id);
    } else {
      const updated = await command<boolean>("ai_history_update", { item: entry.item });
      if (!updated) throw new Error("会话已删除或过期，请新建会话");
    }
  });
  void result.catch(entry.onError);
  return result;
}

function flushPending() {
  return [...pending.keys()].flatMap((id) => {
    const result = flushItem(id);
    return result ? [result] : [];
  });
}

export function scheduleAiHistory(item: AiConversation, onError: (error: unknown) => void) {
  const previous = pending.get(item.id);
  pending.set(item.id, {
    item,
    onError,
    timer: previous?.timer ?? setTimeout(() => { void flushItem(item.id)?.catch(() => {}); }, 600),
  });
}

export function deleteAiHistory(id: string) {
  const entry = pending.get(id);
  if (entry) clearTimeout(entry.timer);
  pending.delete(id);
  known.add(id);
  return enqueue(async () => {
    await command("ai_history_delete", { id });
    window.dispatchEvent(new CustomEvent("ai-history-deleted", { detail: id }));
  });
}

export async function setAiHistoryRetention(days: number) {
  await Promise.all(flushPending());
  return enqueue(() => command("ai_history_retention", { days }));
}
