import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sparkles,
  Send,
  Square,
  Copy,
  TerminalSquare,
  X,
  RefreshCw,
  LoaderCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Choice } from "@/components/Choice";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { isAutomaticReadOnly, parseDecision } from "@/lib/diagnosis";
import { command, errorMessage, type Host, type Target } from "@/lib/api";
import {
  redactContext,
  suggestedCommand,
  type AiAction,
  type AgentEvent,
  type TerminalContext,
  type TerminalHandle,
} from "@/lib/terminal-ai";
// Stable component identities preserve table scroll position while tokens stream in.
const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
  table: ({ children }) => (
    <div
      className="ai-markdown-table"
      role="region"
      aria-label="Markdown 表格"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
};

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  action?: AiAction;
}
const actions: { value: AiAction; label: string }[] = [
  { value: "chat", label: "Chat · 独立问答" },
  { value: "diagnose", label: "自动排查" },
  { value: "recent_output", label: "分析输出" },
  { value: "diagnose_error", label: "诊断报错" },
  { value: "current_command", label: "解释命令" },
  { value: "generate_command", label: "生成命令" },
  { value: "analyze_selection", label: "分析选区" },
];
function FollowNewQuestion({ questionId }: { questionId?: string }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (questionId) scrollToEnd({ behavior: "auto" });
  }, [questionId, scrollToEnd]);
  return null;
}
export function AiAssistant({
  host,
  target,
  visible,
  getTerminal,
  onClose,
}: {
  host?: Host;
  target?: Target;
  visible: boolean;
  getTerminal: () => TerminalHandle | undefined;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<AiAction>(host ? "recent_output" : "chat");
  const platformHost = host?.mode === "platform";
  const chatId = useRef(crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<TerminalContext | null>(null);
  const diagnosis = useRef<AbortController | null>(null);
  const activeRequest = useRef<string | null>(null);
  const mounted = useRef(false);
  function capture() {
    const context = getTerminal()?.context();
    if (!context) throw new Error("终端正在加载，请连接后重试");
    return context;
  }
  function refreshPreview() {
    try {
      setPreview(capture());
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function stop() {
    diagnosis.current?.abort();
    const requestId = activeRequest.current;
    if (!requestId) return;
    setStatus("正在停止平台 AI…");
    try {
      await command("ai_cancel", { requestId });
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      diagnosis.current?.abort();
      const requestId = activeRequest.current;
      if (requestId) void command("ai_cancel", { requestId }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!visible) {
      diagnosis.current?.abort();
      const requestId = activeRequest.current;
      if (requestId) void command("ai_cancel", { requestId }).catch(() => {});
    }
  }, [visible]);
  async function send(action: AiAction, event?: FormEvent) {
    event?.preventDefault();
    if (action === "diagnose") {
      await diagnose();
      return;
    }
    if (activeRequest.current || !visible)
      return;
    if (
      ["custom", "generate_command", "chat", "diagnose"].includes(action) &&
      !prompt.trim()
    ) {
      setError("请先输入问题或希望生成的命令目标");
      return;
    }
    let context: TerminalContext;
    try {
      context =
        action === "chat"
          ? {
              terminalId: chatId.current,
              recentOutput: "",
              selectedText: "",
              currentCommand: "",
              cwd: "",
            }
          : capture();
      if (action === "analyze_selection" && !context.selectedText.trim())
        throw new Error("请先用鼠标在终端中选择要分析的文本");
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    const requestId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    activeRequest.current = requestId;
    setBusy(true);
    setError("");
    setStatus("正在准备主机上下文…");
    setPreview(context);
    const question = redactContext(prompt.trim());
    setPrompt("");
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content:
          question ||
          actions.find((item) => item.value === action)?.label ||
          "分析终端",
      },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    const channel = new Channel<AgentEvent>();
    let received = false;
    let completed = false;
    channel.onmessage = (event) => {
      if (!mounted.current || activeRequest.current !== requestId) return;
      if (
        event.eventType === "assistant_delta" ||
        event.eventType === "assistant_message"
      ) {
        const text = event.payload?.content ?? "";
        received = received || !!text;
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: (event.eventType === "assistant_delta"
                    ? message.content + text
                    : text
                  ).slice(-120000),
                }
              : message,
          ),
        );
      } else if (event.eventType === "status") {
        setStatus(event.payload?.message || "正在分析…");
      } else if (event.eventType === "run_finished") {
        completed = true;
        if (["failed", "cancelled"].includes(event.payload?.status || ""))
          setError(event.payload?.errorMessage || "AI 任务已停止或失败");
        setStatus("分析完成");
      } else if (event.eventType === "error") {
        setError(event.payload?.message || "AI 请求失败");
      }
    };
    try {
      await command("ai_chat", {
        request: {
          requestId,
          terminalId: context.terminalId,
          action,
          hostName: action === "chat" ? "Chat" : (host?.name ?? ""),
          hostIp: action === "chat" ? "" : (host?.address ?? ""),
          prompt: question,
          recentOutput: context.recentOutput,
          selectedText: context.selectedText,
          currentCommand: context.currentCommand,
          cwd: context.cwd,
        },
        channel,
      });
      if (mounted.current && activeRequest.current === requestId) {
        setStatus(completed ? "分析完成" : "已停止");
        if (!received)
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    content: completed
                      ? "AI 未返回可展示的分析内容。"
                      : "分析已停止。",
                  }
                : message,
            ),
          );
      }
    } catch (error) {
      if (mounted.current && activeRequest.current === requestId) {
        setError(errorMessage(error));
        setStatus("请求失败");
      }
    } finally {
      if (activeRequest.current === requestId) {
        activeRequest.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  async function diagnose() {
    if (busy || !visible || !host || !target || !prompt.trim()) return;
    let context: TerminalContext;
    try {
      context = capture();
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    const controller = new AbortController();
    diagnosis.current = controller;
    const goal = redactContext(prompt.trim()),
      assistantId = crypto.randomUUID();
    setPrompt("");
    setBusy(true);
    setError("");
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: `自动排查：${goal}` },
      { id: assistantId, role: "assistant", content: "", action: "diagnose" },
    ]);
    const append = (text: string) => {
      if (mounted.current)
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + text }
              : message,
          ),
        );
    };
    const history: { command: string; output: string }[] = [],
      seen = new Set<string>();
    try {
      for (let step = 0; step < 12; step++) {
        controller.signal.throwIfAborted();
        setStatus(`自动排查 · 第 ${step + 1} 步`);
        const requestId = crypto.randomUUID();
        activeRequest.current = requestId;
        let raw = "";
        const channel = new Channel<AgentEvent>();
        channel.onmessage = (event) => {
          if (event.eventType === "assistant_delta")
            raw += event.payload?.content ?? "";
          if (event.eventType === "assistant_message")
            raw = event.payload?.content ?? "";
        };
        await command("ai_chat", {
          request: {
            requestId,
            terminalId: context.terminalId,
            action: "diagnose",
            hostName: host.name,
            hostIp: host.address,
            prompt: `${goal}\n已执行步骤：${JSON.stringify(history).slice(-10000)}`,
            recentOutput: context.recentOutput,
            selectedText: "",
            currentCommand: "",
            cwd: context.cwd,
          },
          channel,
        });
        activeRequest.current = null;
        controller.signal.throwIfAborted();
        const decision = parseDecision(raw);
        append(`\n\n**第 ${step + 1} 步** ${decision.reason ?? ""}\n`);
        if (decision.done) {
          append(`\n${decision.conclusion}`);
          setStatus("排查完成");
          return;
        }
        if (!decision.commands.length)
          throw new Error("AI 未返回下一步命令，排查结束");
        for (const line of decision.commands) {
          if (seen.has(line)) throw new Error("检测到重复采集，已停止排查");
          seen.add(line);
          append(`\n\n\`\`\`sh\n${line}\n\`\`\`\n`);
          if (!isAutomaticReadOnly(line))
            throw new Error(`该命令需要人工检查，请在终端手动执行：${line}`);
          const terminal = getTerminal();
          if (!terminal?.executeAndCapture)
            throw new Error("当前终端不支持自动排查执行");
          if (terminal.context().terminalId !== context.terminalId)
            throw new Error("排查终端已变更，请在当前连接重新开始排查");
          const output = redactContext(
            await terminal.executeAndCapture(line, controller.signal),
          );
          append(
            `\n\n\`\`\`text\n${output.replaceAll("```", "ʼʼʼ")}\n\`\`\`\n`,
          );
          history.push({ command: line, output: output.slice(-2000) });
          if (history.length >= 12)
            throw new Error("已达到 12 条命令上限，排查结束");
        }
      }
    } catch (error) {
      if (mounted.current) {
        setStatus(controller.signal.aborted ? "已停止" : "排查结束");
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
    } finally {
      activeRequest.current = null;
      diagnosis.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  async function insert(value: string) {
    try {
      const terminal = getTerminal();
      if (!terminal) throw new Error("终端已关闭");
      await terminal.insert(value);
      toast.success("命令已填入终端，请检查后按回车执行");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <aside
      className="ai-panel"
      hidden={!visible}
      aria-label={`主机 AI · ${host?.name ?? "Chat"}`}
    >
      <header>
        <div>
          <Sparkles />
          <strong>主机 AI</strong>
          <span>{host?.name ?? "Chat"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="关闭 AI 面板"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="ai-context">
        <span>
          {mode === "chat"
            ? "独立问答 · 不读取终端"
            : `当前平台终端 · ${host?.address ?? "未连接"}`}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          title="预览本次上下文"
          aria-label="预览 AI 上下文"
          disabled={mode === "chat"}
          onClick={refreshPreview}
        >
          <RefreshCw />
        </Button>
      </div>
      {preview && mode !== "chat" ? (
        <details className="ai-context-preview">
          <summary>
            上下文预览 · {preview.selectedText ? "包含选区" : "最近输出"}
          </summary>
          <pre>
            {preview.currentCommand
              ? `当前命令：${preview.currentCommand}\n\n`
              : ""}
            {preview.selectedText || preview.recentOutput || "暂无终端输出"}
          </pre>
        </details>
      ) : null}
      <div className="ai-conversation">
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller>
            <MessageScrollerViewport aria-label="AI 对话记录">
              <MessageScrollerContent className="gap-5 p-4">
                {!messages.length ? (
                  <MessageScrollerItem messageId="welcome">
                    <Empty className="px-2 py-9">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Sparkles />
                        </EmptyMedia>
                        <EmptyTitle>
                          {mode === "chat"
                            ? "Chat · 独立问答"
                            : "结合当前主机分析"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {mode === "chat"
                            ? "直接提问，无需连接 SSH，也不会读取终端内容。"
                            : "在输入框选择分析模式后提问，或选择自动排查采集主机证据。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                {messages.map((message) => (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <Message align={message.role === "user" ? "end" : "start"}>
                      <MessageContent>
                        <MessageHeader>
                          {message.role === "user" ? "你" : "平台 AI"}
                        </MessageHeader>
                        <Bubble
                          variant={
                            message.role === "user" ? "secondary" : "ghost"
                          }
                        >
                          <BubbleContent>
                            <div className="ai-markdown">
                              {message.content ? (
                                <Markdown
                                  skipHtml
                                  remarkPlugins={markdownPlugins}
                                  components={markdownComponents}
                                >
                                  {message.content}
                                </Markdown>
                              ) : (
                                <span className="ai-thinking">正在分析…</span>
                              )}
                            </div>
                          </BubbleContent>
                        </Bubble>
                        {message.role === "assistant" && message.content ? (
                          <MessageFooter>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="复制 AI 回复"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(message.content)
                                  .then(() => toast.success("已复制"))
                                  .catch((error) =>
                                    toast.error(errorMessage(error)),
                                  )
                              }
                            >
                              <Copy />
                            </Button>
                            {mode !== "chat" &&
                            host &&
                            message.action !== "diagnose" &&
                            suggestedCommand(message.content) ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void insert(suggestedCommand(message.content))
                                }
                              >
                                <TerminalSquare data-icon="inline-start" />
                                填入第一条命令
                              </Button>
                            ) : null}
                          </MessageFooter>
                        ) : null}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <FollowNewQuestion
              questionId={
                messages.findLast((message) => message.role === "user")?.id
              }
            />
            <MessageScrollerButton aria-label="回到最新回复" />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      {error ? (
        <Alert variant="destructive" className="ai-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <form
        className="ai-composer"
        onSubmit={(event) => void send(mode, event)}
      >
        <div className="ai-input-shell">
          <Textarea
            aria-label="向主机 AI 提问"
            placeholder="描述问题或输入命令目标…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={4000}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send(mode);
              }
            }}
          />
          <div className="ai-composer-toolbar">
            <div className="ai-mode-picker">
              <Choice
                label="AI 模式"
                value={mode}
                onChange={(value) => setMode(value as AiAction)}
                options={actions.filter(
                  (action) =>
                    (host || action.value === "chat") &&
                    (platformHost || action.value !== "diagnose"),
                )}
                disabled={busy}
              />
            </div>
            <span
              className="ai-composer-status"
              aria-live="polite"
              title={status || "发送时附带终端上下文"}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              <span>{status || "就绪"}</span>
            </span>
            <div className="ai-composer-buttons">
              {busy ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="停止"
                  onClick={() => void stop()}
                >
                  <Square data-icon="inline-start" />
                  停止
                </Button>
              ) : (
                <Button type="submit" size="sm" disabled={!prompt.trim()}>
                  <Send data-icon="inline-start" />
                  发送
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="ai-composer-hint">
          ⌘ / Ctrl + Enter 发送 · 常见凭据字段自动遮蔽
        </p>
      </form>
    </aside>
  );
}
