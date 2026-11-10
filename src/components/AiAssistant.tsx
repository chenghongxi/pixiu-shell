import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sparkles,
  ArrowUp,
  Square,
  TerminalSquare,
  X,
  LoaderCircle,
  Pencil,
  CircleAlert,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { AssistantIcon } from "@/components/MonitorIcon";
import { Choice } from "@/components/Choice";
import { Textarea } from "@/components/ui/textarea";
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
import { isAutomaticReadOnly, parseDecision, readOnlyCommandPolicy } from "@/lib/diagnosis";
import { command, errorMessage, type Host, type Preferences, type Target } from "@/lib/api";
import { scheduleAiHistory, type AiConversation, type AiHistoryMessage } from "@/lib/ai-history";
import {
  redactContext,
  suggestedCommand,
  recentDialogue,
  scopeTerminalContext,
  type AiAction,
  type AgentEvent,
  type ContextScope,
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

type ChatMessage = AiHistoryMessage;
const actions: { value: AiAction; label: string }[] = [
  { value: "chat", label: "独立问答" },
  { value: "custom", label: "终端问答" },
  { value: "diagnose", label: "自动排查" },
];
const contextScopes: { value: ContextScope; label: string }[] = [
  { value: "selection", label: "选区" },
  { value: "recent", label: "最近输出" },
  { value: "none", label: "不带终端" },
];
function diagnosisContext(context: TerminalContext): TerminalContext {
  return { ...context, selectedText: "", currentCommand: "" };
}
function FollowNewQuestion({ questionId, error }: { questionId?: string; error: string }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (questionId) scrollToEnd({ behavior: "auto" });
  }, [questionId, scrollToEnd]);
  useEffect(() => {
    if (error) scrollToEnd({ behavior: "auto" });
  }, [error, scrollToEnd]);
  return null;
}
function SuggestedCommands({
  content,
  disabled,
  onInsert,
  onRun,
}: {
  content: string;
  disabled: boolean;
  onInsert: (command: string) => void;
  onRun: (command: string) => void;
}) {
  const commandText = suggestedCommand(content);
  if (!commandText) return null;
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={disabled}
        title="填入第一条命令"
        onClick={() => onInsert(commandText)}
      >
        <TerminalSquare data-icon="inline-start" />
        填入
      </Button>
      {isAutomaticReadOnly(commandText) ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          title="审批后执行第一条只读命令"
          onClick={() => onRun(commandText)}
        >
          审批执行
        </Button>
      ) : null}
    </>
  );
}
export function AiAssistant({
  host,
  target,
  visible,
  getTerminal,
  onClose,
  preferences,
  onSelectModel,
  resume,
  historyScope,
}: {
  host?: Host;
  target?: Target;
  visible: boolean;
  getTerminal: () => TerminalHandle | undefined;
  onClose: () => void;
  preferences: Preferences;
  onSelectModel: (gatewayId: string, model: string) => Promise<void>;
  resume?: AiConversation | null;
  historyScope: string;
}) {
  const [mode, setMode] = useState<AiAction>(host ? "custom" : "chat");
  const [contextScope, setContextScope] = useState<ContextScope>("selection");
  const chatId = useRef<string>(crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const savedMessages = useRef("[]");
  const applyingResume = useRef(false);
  const handledResume = useRef<AiConversation | null>(null);
  const [prompt, setPrompt] = useState("");
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const approvalRun = useRef<HTMLButtonElement>(null);
  const [composerHeight, setComposerHeight] = useState(150);
  const panelRef = useRef<HTMLElement>(null);
  const composerDrag = useRef<{ y: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<TerminalContext | null>(null);
  const [previewError, setPreviewError] = useState("");
  const previewDetails = useRef<HTMLDetailsElement>(null);
  const [approval, setApproval] = useState<{
    command: string;
    detail: string;
    finish: (approved: boolean) => void;
  } | null>(null);
  const diagnosis = useRef<AbortController | null>(null);
  const suggestion = useRef<AbortController | null>(null);
  const activeRequest = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!resume || handledResume.current === resume) return;
    handledResume.current = resume;
    if (busy || activeRequest.current || diagnosis.current) {
      toast.error("当前 AI 任务正在运行，请先停止后再切换会话");
      return;
    }
    chatId.current = resume.id;
    savedMessages.current = JSON.stringify(resume.messages);
    applyingResume.current = true;
    setMessages(resume.messages);
    setMode(host ? resume.messages.at(-1)?.action ?? "custom" : "chat");
    setError("");
    setStatus("");
  }, [resume, busy, host]);
  useEffect(() => {
    if (applyingResume.current) {
      applyingResume.current = false;
      return;
    }
    const serialized = JSON.stringify(messages);
    if (!messages.length || serialized === savedMessages.current) return;
    savedMessages.current = serialized;
    const conversationId = chatId.current;
    const title = messages.find((message) => message.role === "user")?.content.trim().slice(0, 120) || "AI 对话";
    scheduleAiHistory({
      id: conversationId,
      target: target ? { ...target, historyScope, hostAddress: host?.address } : null,
      hostName: host?.name ?? "",
      title,
      messages,
      updatedAt: 0,
    }, (error) => {
      if (chatId.current === conversationId) savedMessages.current = "";
      toast.error(`保存 AI 会话失败：${errorMessage(error)}`);
    });
  }, [messages, host, target, historyScope]);
  useEffect(() => {
    const onDeleted = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== chatId.current) return;
      diagnosis.current?.abort();
      diagnosis.current = null;
      suggestion.current?.abort();
      const requestId = activeRequest.current;
      activeRequest.current = null;
      if (requestId) void command("ai_cancel", { requestId }).catch(() => {});
      setBusy(false);
      chatId.current = crypto.randomUUID();
      savedMessages.current = "[]";
      setMessages([]);
      setError("");
    };
    window.addEventListener("ai-history-deleted", onDeleted);
    return () => window.removeEventListener("ai-history-deleted", onDeleted);
  }, []);
  function newConversation() {
    if (busy || activeRequest.current || diagnosis.current) return;
    chatId.current = crypto.randomUUID();
    savedMessages.current = "[]";
    setMessages([]);
    setPrompt("");
    setError("");
    setStatus("");
  }
  function resizeComposer(height: number) {
    const limit = Math.max(150, Math.floor((panelRef.current?.clientHeight ?? 600) * 0.6));
    setComposerHeight(Math.max(150, Math.min(limit, height)));
  }
  const gateway = preferences.aiGateways.find(
    (item) => item.id === preferences.activeAiGatewayId,
  );
  const gatewayId = gateway?.id;
  const gatewayUrl = gateway?.baseUrl;
  useEffect(() => {
    let cancelled = false;
    setAvailableModels([]);
    if (!visible || !gatewayId || !gatewayUrl) {
      setLoadingModels(false);
      return;
    }
    setLoadingModels(true);
    void command<string[]>("ai_models", {
      baseUrl: gatewayUrl,
      apiKey: "",
      gatewayId,
    }).then((models) => {
      if (!cancelled) setAvailableModels(models);
    }).catch((error) => {
      if (!cancelled) setError(errorMessage(error));
    }).finally(() => {
      if (!cancelled) setLoadingModels(false);
    });
    return () => { cancelled = true; };
  }, [visible, gatewayId, gatewayUrl]);
  async function selectModel(model: string) {
    if (!gateway || !model.trim() || model === gateway.model || switchingModel) return;
    setSwitchingModel(true);
    try {
      await onSelectModel(gateway.id, model);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      if (mounted.current) setSwitchingModel(false);
    }
  }
  function capture() {
    const context = getTerminal()?.context();
    if (!context) throw new Error("终端正在加载，请连接后重试");
    return context;
  }
  function refreshPreview(scope = contextScope) {
    try {
      const context = capture();
      setPreview(
        mode === "custom"
          ? scopeTerminalContext(context, scope)
          : diagnosisContext(context),
      );
      setPreviewError("");
    } catch (error) {
      setPreview(null);
      setPreviewError(errorMessage(error));
    }
  }
  function confirmCommand(
    line: string,
    signal: AbortSignal,
    detail = "确认后会立即在该会话运行。拒绝则停止本轮排查，不会写入终端。",
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (mounted.current) setApproval(null);
        resolve(approved);
      };
      const cancel = () => finish(false);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else setApproval({ command: line, detail, finish });
    });
  }
  function chooseScope(scope: ContextScope) {
    setContextScope(scope);
    if (previewDetails.current?.open && mode === "custom") refreshPreview(scope);
  }
  async function stop() {
    diagnosis.current?.abort();
    suggestion.current?.abort();
    const requestId = activeRequest.current;
    if (!requestId) return;
    setStatus("正在停止 AI…");
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
      suggestion.current?.abort();
      const requestId = activeRequest.current;
      if (requestId) void command("ai_cancel", { requestId }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!visible) {
      diagnosis.current?.abort();
      suggestion.current?.abort();
      const requestId = activeRequest.current;
      if (requestId) void command("ai_cancel", { requestId }).catch(() => {});
    }
  }, [visible]);
  useEffect(() => {
    if (approval) approvalRun.current?.focus();
  }, [approval]);
  async function send(action: AiAction, event?: FormEvent) {
    event?.preventDefault();
    if (switchingModel) return;
    if (action === "diagnose") {
      await diagnose();
      return;
    }
    if (busy || activeRequest.current || !visible)
      return;
    if (
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
          : scopeTerminalContext(capture(), contextScope);
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    const history = recentDialogue(messages, action);
    const requestId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    activeRequest.current = requestId;
    setBusy(true);
    setError("");
    setStatus("正在准备主机上下文…");
    if (previewDetails.current?.open) {
      setPreview(context);
      setPreviewError("");
    }
    const question = redactContext(prompt.trim());
    const createdAt = new Date().toISOString();
    setPrompt("");
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        action,
        createdAt,
        content:
          question ||
          actions.find((item) => item.value === action)?.label ||
          "分析终端",
      },
      { id: assistantId, role: "assistant", content: "", action },
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
          history,
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
        if (!received)
          setMessages((current) =>
            current.filter((message) => message.id !== assistantId),
          );
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
      context = diagnosisContext(capture());
    } catch (error) {
      setError(errorMessage(error));
      return;
    }
    if (previewDetails.current?.open) {
      setPreview(context);
      setPreviewError("");
    }
    const controller = new AbortController();
    diagnosis.current = controller;
    const conversationId = chatId.current;
    const goal = redactContext(prompt.trim()),
      assistantId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    setPrompt("");
    setBusy(true);
    setError("");
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: goal, action: "diagnose", createdAt },
      { id: assistantId, role: "assistant", content: "", action: "diagnose" },
    ]);
    const append = (text: string) => {
      if (mounted.current && chatId.current === conversationId)
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
            prompt: `${goal}\n只读策略：${readOnlyCommandPolicy}\n已执行步骤：${JSON.stringify(history).slice(-10000)}`,
            recentOutput: context.recentOutput,
            selectedText: context.selectedText,
            currentCommand: context.currentCommand,
            cwd: context.cwd,
          },
          channel,
        });
        if (chatId.current !== conversationId) return;
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
          if (!isAutomaticReadOnly(line))
            throw new Error(`排查命令不符合安全规则，请人工检查：${line}`);
          setStatus("等待确认排查命令");
          if (!await confirmCommand(line, controller.signal)) {
            controller.abort();
            controller.signal.throwIfAborted();
          }
          controller.signal.throwIfAborted();
          append(`\n\n\`\`\`sh\n${line}\n\`\`\`\n`);
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
      if (mounted.current && chatId.current === conversationId) {
        setStatus(controller.signal.aborted ? "已停止" : "排查结束");
        if (controller.signal.aborted) append("\n\n排查已停止。");
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
    } finally {
      if (diagnosis.current === controller) {
        activeRequest.current = null;
        diagnosis.current = null;
        if (mounted.current) setBusy(false);
      }
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
  async function runSuggested(value: string) {
    if (!visible || busy || approval || suggestion.current || !host) return;
    if (!isAutomaticReadOnly(value)) {
      toast.error("该命令不能代为执行，只能填入终端后自行确认");
      return;
    }
    const controller = new AbortController();
    suggestion.current = controller;
    try {
      const approved = await confirmCommand(
        value,
        controller.signal,
        "确认后会立即在当前 SSH 会话运行这条只读命令。拒绝则不执行，也不会写入终端。",
      );
      if (!approved || !mounted.current) return;
      if (!isAutomaticReadOnly(value)) {
        toast.error("该命令不能代为执行，只能填入终端后自行确认");
        return;
      }
      const terminal = getTerminal();
      if (!terminal) throw new Error("终端已关闭");
      await terminal.executeAndCapture(value, controller.signal);
      if (mounted.current) toast.success("命令已在当前终端执行");
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) toast.error(errorMessage(error));
    } finally {
      if (suggestion.current === controller) suggestion.current = null;
    }
  }
  return (
    <aside
      ref={panelRef}
      className="ai-panel"
      hidden={!visible}
      aria-label={`主机 AI · ${host?.name ?? "Chat"}`}
    >
      <header>
        <div>
          <AssistantIcon />
          <strong>主机 AI</strong>
          <span>{host?.name ?? "Chat"}</span>
        </div>
        <div className="ai-panel__actions">
          <Button variant="ghost" size="icon-xs" aria-label="新建 AI 会话"
            title="新建会话" disabled={busy} onClick={newConversation}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="关闭 AI 面板" onClick={onClose}>
            <X />
          </Button>
        </div>
      </header>
      {mode !== "chat" ? (
        <details
          className="ai-context-preview"
          ref={previewDetails}
          onToggle={(event) => {
            if (event.currentTarget.open) refreshPreview();
            else {
              setPreview(null);
              setPreviewError("");
            }
          }}
        >
          <summary>
            上下文预览 · {mode === "custom" && contextScope === "none"
              ? "不带终端"
              : "当前快照"}
          </summary>
          <p>
            {mode === "custom" && contextScope === "none"
              ? "发送时不附带终端内容。"
              : "发送时会重新采集终端内容。"}
          </p>
          {previewError ? <p role="alert">{previewError}</p> : preview && !(mode === "custom" && contextScope === "none") ? (
            <pre>
              {preview.cwd ? `当前目录：${preview.cwd}\n\n` : ""}
              {preview.currentCommand ? `当前命令：${preview.currentCommand}\n\n` : ""}
              {preview.selectedText ? `选中文本：\n${preview.selectedText}\n\n` : ""}
              {preview.recentOutput ? `最近输出：\n${preview.recentOutput}` : ""}
              {!preview.selectedText && !preview.recentOutput && !preview.currentCommand && !preview.cwd
                ? "暂无终端输出"
                : ""}
            </pre>
          ) : null}
        </details>
      ) : null}
      <div className="ai-conversation">
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller>
            <MessageScrollerViewport aria-label="AI 对话记录" hideScrollbarWhileScrolling={false}>
              <MessageScrollerContent className="gap-5 p-4">
                {!messages.length ? (
                  <MessageScrollerItem messageId="welcome">
                    <Empty className="ai-welcome px-2 py-9">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <Sparkles />
                        </EmptyMedia>
                        <EmptyTitle>
                          {mode === "chat"
                            ? "独立问答"
                            : "结合当前主机分析"}
                        </EmptyTitle>
                        <EmptyDescription>
                          {mode === "chat"
                            ? "直接提问，无需连接 SSH，也不会读取终端内容。"
                            : "结合终端内容提问，或使用自动排查采集主机证据。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                {messages.map((message) => (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <Message align={message.role === "user" ? "end" : "start"} className={message.role === "user" ? "ai-user-message" : undefined}>
                      <MessageContent>
                        {message.role === "assistant" ? <MessageHeader>AI</MessageHeader> : null}
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
                        {message.role === "user" ? (
                          <MessageFooter className="ai-user-actions">
                            {message.createdAt ? (
                              <time dateTime={message.createdAt}>
                                {new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
                              </time>
                            ) : <span className="ai-user-time-unknown">时间未记录</span>}
                            <CopyButton label="复制问题" value={message.content} />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="编辑问题"
                              title="编辑问题"
                              disabled={busy}
                              onClick={() => {
                                setPrompt(message.content);
                                if (message.action) setMode(message.action);
                                setError("");
                                requestAnimationFrame(() => promptInput.current?.focus());
                              }}
                            >
                              <Pencil />
                            </Button>
                          </MessageFooter>
                        ) : null}
                        {message.role === "assistant" && message.content ? (
                          <MessageFooter className="ai-command-actions">
                            <CopyButton label="复制 AI 回复" value={message.content} />
                            {message.action === "custom" && host ? (
                              <SuggestedCommands
                                content={message.content}
                                disabled={busy || !!approval}
                                onInsert={(commandText) => void insert(commandText)}
                                onRun={(commandText) => void runSuggested(commandText)}
                              />
                            ) : null}
                          </MessageFooter>
                        ) : null}
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
                {error ? (
                  <MessageScrollerItem messageId="ai-error">
                    <div className="ai-error" role="alert">
                      <CircleAlert aria-hidden="true" />
                      <span>{error}</span>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label="关闭提示" title="关闭提示" onClick={() => setError("")}>
                        <X />
                      </Button>
                    </div>
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <FollowNewQuestion
              error={error}
              questionId={
                messages.findLast((message) => message.role === "user")?.id
              }
            />
            <MessageScrollerButton aria-label="回到最新回复" />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      <form
        className="ai-composer"
        onSubmit={(event) => {
          if (approval) {
            event.preventDefault();
            return;
          }
          void send(mode, event);
        }}
      >
        {approval ? (
          <div
            className="ai-approval"
            role="region"
            aria-label="确认执行命令"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                approval.finish(false);
                return;
              }
              if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) return;
              if ((event.target as HTMLElement).closest("button")) return;
              event.preventDefault();
              approval.finish(true);
            }}
          >
            <div className="ai-approval-head">
              <TerminalSquare aria-hidden="true" />
              <strong>确认执行</strong>
              <span>{host ? `当前 SSH 终端 · ${host.name}` : "当前 SSH 终端"}</span>
            </div>
            <p>{approval.detail}</p>
            <div className="ai-approval-command">
              <span className="ai-approval-prompt" aria-hidden="true">$</span>
              <textarea
                readOnly
                rows={1}
                aria-label="待确认命令"
                value={approval.command}
              />
              <CopyButton value={approval.command} label="复制命令" />
            </div>
            <div className="ai-approval-actions">
              <span>Esc 拒绝 · Enter 执行</span>
              <div className="ai-approval-buttons">
                <Button type="button" variant="outline" size="sm" onClick={() => approval.finish(false)}>
                  拒绝
                </Button>
                <Button
                  ref={approvalRun}
                  type="button"
                  size="sm"
                  onClick={() => approval.finish(true)}
                >
                  确认执行
                </Button>
              </div>
            </div>
          </div>
        ) : (
        <>
        {mode === "custom" ? (
          <div className="ai-context-scope" role="radiogroup" aria-label="终端上下文">
            {contextScopes.map((scope) => (
              <button
                key={scope.value}
                type="button"
                role="radio"
                aria-checked={contextScope === scope.value}
                disabled={busy}
                onClick={() => chooseScope(scope.value)}
              >
                {scope.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="ai-input-shell">
          <div
            className="ai-composer-resize"
            role="separator"
            aria-label="调整输入框高度"
            aria-orientation="horizontal"
            aria-valuemin={150}
            aria-valuenow={composerHeight}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              composerDrag.current = { y: event.clientY, height: composerHeight };
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (composerDrag.current) {
                resizeComposer(composerDrag.current.height + composerDrag.current.y - event.clientY);
              }
            }}
            onPointerUp={() => { composerDrag.current = null; }}
            onPointerCancel={() => { composerDrag.current = null; }}
            onLostPointerCapture={() => { composerDrag.current = null; }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                resizeComposer(composerHeight + (event.key === "ArrowUp" ? 16 : -16));
              }
            }}
          />
          <Textarea
            ref={promptInput}
            aria-label="向主机 AI 提问"
            style={{ height: composerHeight }}
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
                label="AI 操作"
                value={mode}
                onChange={(value) => {
                  if (actions.some((action) => action.value === value)) {
                    if (previewDetails.current) previewDetails.current.open = false;
                    setMode(value as AiAction);
                    setPreview(null);
                    setPreviewError("");
                  }
                }}
                options={actions.filter((action) => host || action.value === "chat")}
                disabled={busy}
                contentClassName="ai-mode-options"
                contentPosition="popper"
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
            <div className="ai-model-picker">
              <Choice
                label="选择模型"
                value={gateway?.model ?? ""}
                displayValue={gateway?.model}
                onChange={(model) => void selectModel(model)}
                options={[...new Set([...(gateway?.model ? [gateway.model] : []), ...availableModels])].map((model) => ({
                  value: model,
                  label: model,
                }))}
                placeholder={!gateway ? "请先选择网关" : loadingModels ? "正在获取模型…" : availableModels.length ? "请选择模型" : "暂无可用模型"}
                disabled={busy || switchingModel || (!gateway?.model && !availableModels.length)}
                contentClassName="ai-mode-options"
                contentPosition="popper"
              />
            </div>
            <div className="ai-composer-buttons">
              {busy ? (
                <Button
                  type="button"
                  size="icon-sm"
                  className="ai-submit-button"
                  aria-label="停止生成"
                  title="停止生成"
                  onClick={() => void stop()}
                >
                  <Square className="ai-stop-icon" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon-sm"
                  className="ai-submit-button"
                  aria-label="发送"
                  title="发送"
                  disabled={switchingModel || !prompt.trim()}
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
        </div>
        </>
        )}
        <p className="ai-composer-hint">
          ⌘ / Ctrl + Enter 发送 · 常见凭据字段自动遮蔽
        </p>
      </form>
    </aside>
  );
}
