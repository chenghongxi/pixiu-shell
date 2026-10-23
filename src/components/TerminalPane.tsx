import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { isAutomaticReadOnly, cleanDiagnosticOutput } from "@/lib/diagnosis";
import {
  cleanTerminalTitle,
  visibleShellCommand,
  visibleShellPrompt,
} from "@/lib/terminal-command";
import { transferCommand } from "@/lib/transfer-command";
import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useImperativeHandle,
  type Ref,
  type CSSProperties,
  type ButtonHTMLAttributes,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  PlugZap,
  Unplug,
  X,
  GripVertical,
  Copy,
  Search,
  ChevronUp,
  ChevronDown,
  Maximize2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

import {
  cancelCommandApproval,
  command,
  createCommandApproval,
  errorMessage,
  getCommandApproval,
  openTerminal,
  type CommandApproval,
  type Target,
  type Preferences,
} from "@/lib/api";
import "@xterm/xterm/css/xterm.css";
import {
  redactContext,
  hasControlCharacters,
  type TerminalHandle,
} from "@/lib/terminal-ai";
import { terminalThemes } from "@/lib/themes";
import { shortcutMatches } from "@/lib/shortcuts";
import Guacamole, { type Client as GuacamoleClient } from "guacamole-common-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "@/lib/api";

const terminalSearchDecorations = {
  "pixiu-shell": {
    matchBackground: "#334b5d",
    matchBorder: "#6fa9c7",
    matchOverviewRuler: "#6fa9c7",
    activeMatchBackground: "#9b712b",
    activeMatchBorder: "#f0c36a",
    activeMatchColorOverviewRuler: "#f0c36a",
  },
  windterm: {
    matchBackground: "#245464",
    matchBorder: "#53bfd5",
    matchOverviewRuler: "#53bfd5",
    activeMatchBackground: "#a8751e",
    activeMatchBorder: "#f3c75f",
    activeMatchColorOverviewRuler: "#f3c75f",
  },
  catppuccin: {
    matchBackground: "#414d6b",
    matchBorder: "#89b4fa",
    matchOverviewRuler: "#89b4fa",
    activeMatchBackground: "#a87932",
    activeMatchBorder: "#f9e2af",
    activeMatchColorOverviewRuler: "#f9e2af",
  },
  dracula: {
    matchBackground: "#4a4070",
    matchBorder: "#bd93f9",
    matchOverviewRuler: "#bd93f9",
    activeMatchBackground: "#a96132",
    activeMatchBorder: "#f1fa8c",
    activeMatchColorOverviewRuler: "#f1fa8c",
  },
  nord: {
    matchBackground: "#3b586d",
    matchBorder: "#88c0d0",
    matchOverviewRuler: "#88c0d0",
    activeMatchBackground: "#a8792b",
    activeMatchBorder: "#ebcb8b",
    activeMatchColorOverviewRuler: "#ebcb8b",
  },
  solarized: {
    matchBackground: "#1c5861",
    matchBorder: "#2aa198",
    matchOverviewRuler: "#2aa198",
    activeMatchBackground: "#8d6e24",
    activeMatchBorder: "#b58900",
    activeMatchColorOverviewRuler: "#b58900",
  },
  paper: {
    matchBackground: "#c7dbe6",
    matchBorder: "#3868b2",
    matchOverviewRuler: "#3868b2",
    activeMatchBackground: "#e6c36a",
    activeMatchBorder: "#866116",
    activeMatchColorOverviewRuler: "#866116",
  },
} as const;

function rdpErrorMessage(value: string): string {
  if (
    /guacd.*(?:127\.0\.0\.1|localhost).*4822|Connection refused/i.test(value)
  ) {
    return "平台 RDP 网关不可用：运维平台服务端仍指向本机 127.0.0.1:4822。请在远程 ops-gateway 配置 RDP_GUACD_HOST（或使用 config-pro.toml 的 guacd 服务名）；Pixiu Shell 不需要本地 guacd。";
  }
  return value || "RDP 连接失败";
}

export function TerminalPane({
  target,
  address,
  active,
  preferences,
  ref,
  title,
  baseTitle,
  terminalTitle,
  onTitleUpdate,
  onClose,
  dragHandleProps,
}: {
  target: Target;
  address: string;
  active: boolean;
  preferences: Preferences;
  ref?: Ref<TerminalHandle>;
  title?: string;
  baseTitle: string;
  terminalTitle?: string;
  onTitleUpdate?: (title: string | null) => void;
  onClose?: () => void;
  dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const isRdp = target.mode === "platform" && target.protocol === "rdp";
  const container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTextRef = useRef("");
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const searchAddon = useRef<SearchAddon | null>(null);
  const id = useRef<string | null>(null);
  const titleUpdateRef = useRef(onTitleUpdate);
  const shellTitleRef = useRef<string | null>(null);
  const shellTitleRevision = useRef(0);
  const commandTitleRevision = useRef(0);
  const commandTitleActive = useRef(false);
  const activeRef = useRef(active);
  const rdpClient = useRef<GuacamoleClient | null>(null);
  const rdpDisplay = useRef<HTMLElement | null>(null);
  const rdpInputHandlers = useRef<Array<() => void>>([]);
  const commandCapture = useRef<{
    text: string;
    decoder: TextDecoder;
    updatedAt: number;
    failure?: string;
  } | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    titleUpdateRef.current = onTitleUpdate;
  }, [onTitleUpdate]);
  const preferencesRef = useRef(preferences);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);
  const transferBusy = useRef(false);
  const [transferPath, setTransferPath] = useState<{
    direction: "upload" | "download";
    path: string;
  } | null>(null);
  const performTransfer = useCallback(
    async (transfer: { direction: "upload" | "download"; path: string }) => {
      if (transferBusy.current) {
        toast.error("文件传输仍在进行中");
        return;
      }
      transferBusy.current = true;
      try {
        const result = await command<{ cancelled: boolean }>(
          `file_${transfer.direction}`,
          {
            target,
            ...(transfer.direction === "upload"
              ? { directory: transfer.path }
              : { path: transfer.path }),
          },
        );
        if (!result.cancelled)
          toast.success(
            transfer.direction === "upload" ? "上传完成" : "下载完成",
          );
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        transferBusy.current = false;
      }
    },
    [target],
  );

  const inputBuffer = useRef("");
  const inputNeedsSnapshot = useRef(false);
  const lastCommand = useRef("");
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "closed" | "error"
  >("connecting");
  const statusRef = useRef(status);
  const readyWaiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    statusRef.current = status;
    if (status === "connected")
      readyWaiters.current.splice(0).forEach((resolve) => resolve());
  }, [status]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchResult, setSearchResult] = useState<{
    index: number;
    count: number;
  } | null>(null);
  const [commandApprovalBusy, setCommandApprovalBusy] = useState(false);
  const [pendingCommandApproval, setPendingCommandApproval] = useState<{
    command: string;
    message: string;
    riskLevel?: string;
    approval?: CommandApproval;
    remainingSeconds?: number;
  } | null>(null);
  const commandApprovalTimer = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const commandApprovalCountdownTimer = useRef<ReturnType<
    typeof setInterval
  > | null>(null);
  const [rdpFullscreen, setRdpFullscreen] = useState(false);
  const rdpCleanup = useCallback(() => {
    rdpInputHandlers.current.splice(0).forEach((dispose) => dispose());
    rdpClient.current?.disconnect();
    rdpClient.current = null;
    rdpDisplay.current?.remove();
    rdpDisplay.current = null;
    setRdpFullscreen(false);
  }, []);
  const toggleRdpFullscreen = useCallback(async () => {
    const element = container.current;
    if (!element) return;
    try {
      if (desktop) {
        const window = getCurrentWindow();
        const next = !(await window.isFullscreen());
        await window.setFullscreen(next);
        setRdpFullscreen(next);
      } else if (typeof element.requestFullscreen === "function") {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await element.requestFullscreen();
      } else {
        toast.info("当前窗口不支持网页全屏，请使用 Command/Ctrl + Enter");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);

  useImperativeHandle(ref, () => ({
    focus() {
      terminal.current?.focus();
    },
    context() {
      const instance = terminal.current;
      if (!instance || !id.current) throw new Error("请先建立 SSH 连接");
      const buffer = instance.buffer.active;
      const lines: string[] = [];
      for (
        let index = Math.max(0, buffer.length - 300);
        index < buffer.length;
        index++
      )
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
      const cursor =
        buffer
          .getLine(buffer.baseY + buffer.cursorY)
          ?.translateToString(true) ?? "";
      const prompt = cursor.match(/^[\w.-]+@[\w.-]+:(.*?)\s*[$#]\s?(.*)$/);
      return {
        terminalId: id.current,
        recentOutput: redactContext(lines.join("\n")).trim().slice(-12000),
        selectedText: redactContext(instance.getSelection()).slice(0, 8000),
        currentCommand: redactContext(
          prompt?.[2] || inputBuffer.current || lastCommand.current,
        ).slice(0, 4000),
        cwd: prompt?.[1] ?? "",
      };
    },
    async execute(commandText) {
      if (!id.current || status !== "connected") throw new Error("SSH 未连接");
      if (
        !commandText.trim() ||
        commandText.length > 4000 ||
        hasControlCharacters(commandText)
      )
        throw new Error("请输入不含控制符的单行命令");
      if (inputBuffer.current.trim())
        throw new Error("终端存在未提交的输入，请先清空");
      if (terminal.current?.buffer.active.type !== "normal")
        throw new Error("请退出交互式程序后再批量执行");
      commandTitleActive.current = true;
      commandTitleRevision.current = shellTitleRevision.current;
      titleUpdateRef.current?.(cleanTerminalTitle(commandText));
      await command("terminal_input", {
        id: id.current,
        input: {
          type: "input",
          data: commandText + "\r",
          command: commandText,
        },
      });
      lastCommand.current = commandText;
    },
    async executeAndCapture(commandText, signal) {
      if (target.mode !== "platform")
        throw new Error("自动排查需要已连接的平台 SSH 终端");
      if (!id.current || statusRef.current !== "connected") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("平台 SSH 终端仍在连接，请稍后重试")),
            5000,
          );
          readyWaiters.current.push(() => {
            clearTimeout(timer);
            resolve();
          });
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      const sessionId = id.current;
      if (!sessionId || statusRef.current !== "connected")
        throw new Error("自动排查需要已连接的平台 SSH 终端");
      if (!isAutomaticReadOnly(commandText))
        throw new Error("该命令不符合自动排查的只读规则");
      if (inputBuffer.current.trim() || commandCapture.current)
        throw new Error("终端存在未完成的输入或排查命令，请等待完成");
      if (terminal.current?.buffer.active.type !== "normal")
        throw new Error("请退出交互式程序后再自动排查");
      signal?.throwIfAborted();
      const capture = {
        text: "",
        decoder: new TextDecoder(),
        updatedAt: 0,
        failure: undefined as string | undefined,
      };
      commandCapture.current = capture;
      commandTitleActive.current = true;
      commandTitleRevision.current = shellTitleRevision.current;
      titleUpdateRef.current?.(cleanTerminalTitle(commandText));
      const started = Date.now();
      let sent = false;
      try {
        await command("terminal_input", {
          id: sessionId,
          input: {
            type: "input",
            data: commandText + "\r",
            command: commandText,
          },
        });
        sent = true;
        lastCommand.current = commandText;
        while (Date.now() - started < 30_000) {
          signal?.throwIfAborted();
          if (id.current !== sessionId || statusRef.current !== "connected")
            throw new Error("排查终端已断开或重连");
          if (capture.failure) throw new Error(capture.failure);
          // Match Web's bounded output-stability capture, using only new stream data.
          if (
            capture.text &&
            Date.now() - started >= 1200 &&
            Date.now() - capture.updatedAt >= 900
          )
            return cleanDiagnosticOutput(
              capture.text + capture.decoder.decode(),
              commandText,
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("排查命令输出等待超时，已停止继续采集");
      } catch (error) {
        if (
          sent &&
          id.current === sessionId &&
          statusRef.current === "connected" &&
          !capture.failure
        )
          await command("terminal_input", {
            id: sessionId,
            input: { type: "input", data: "\u0003" },
          }).catch(() => {});
        throw error;
      } finally {
        if (commandCapture.current === capture) commandCapture.current = null;
      }
    },
    async insert(commandText) {
      if (!id.current || status !== "connected")
        throw new Error("终端未连接，无法填入命令");
      if (
        !commandText ||
        commandText.length > 4000 ||
        hasControlCharacters(commandText)
      )
        throw new Error("仅支持填入不含控制符的单行命令");
      const buffer = terminal.current?.buffer.active;
      const line =
        buffer
          ?.getLine(buffer.baseY + buffer.cursorY)
          ?.translateToString(true) ?? "";
      const visibleCommand =
        line.match(/^[\w.-]+@[\w.-]+:.*?\s*[$#]\s?(.*)$/)?.[1] ?? "";
      if (inputBuffer.current.trim() || visibleCommand.trim())
        throw new Error("请先清空终端中正在输入的命令");
      await command("terminal_input", {
        id: id.current,
        input: { type: "input", data: commandText },
      });
      inputBuffer.current = commandText;
      terminal.current?.focus();
    },
  }));
  useEffect(() => {
    if (!container.current) return;
    if (isRdp) {
      let disposed = false;
      let closed = false;
      let clientReady = false;
      let displayConnected = false;
      let lastSize = "";
      const displaySize = () => ({
        width: Math.max(640, container.current?.clientWidth ?? 1280),
        height: Math.max(480, container.current?.clientHeight ?? 720),
      });
      const fitDisplay = () => {
        const surface = container.current;
        const remote = rdpClient.current?.getDisplay();
        if (
          !surface?.clientWidth ||
          !surface.clientHeight ||
          !remote?.getWidth() ||
          !remote.getHeight()
        )
          return;
        remote.scale(
          Math.min(
            surface.clientWidth / remote.getWidth(),
            surface.clientHeight / remote.getHeight(),
          ),
        );
      };
      const resizeDisplay = () => {
        fitDisplay();
        if (
          !displayConnected ||
          !container.current?.clientWidth ||
          !container.current.clientHeight
        )
          return;
        const next = displaySize();
        const key = `${next.width}x${next.height}`;
        if (key === lastSize) return;
        lastSize = key;
        rdpClient.current?.sendSize(next.width, next.height);
      };
      const resizeObserver = new ResizeObserver(resizeDisplay);
      resizeObserver.observe(container.current);
      const onFullscreenChange = () =>
        setRdpFullscreen(document.fullscreenElement === container.current);
      document.addEventListener("fullscreenchange", onFullscreenChange);
      const tunnel = new Guacamole.Tunnel();
      const parser = new Guacamole.Parser();
      const pendingMessages: string[] = [];
      let writes: Promise<unknown> = Promise.resolve();
      const sendMessage = (message: string) => {
        if (disposed || closed) return;
        if (id.current && clientReady) {
          const sessionId = id.current;
          writes = writes
            .then(() =>
              disposed || closed
                ? undefined
                : command("rdp_input", { id: sessionId, data: message }),
            )
            .catch((error) => {
              if (!disposed) {
                setStatus("error");
                toast.error(errorMessage(error));
              }
            });
        } else pendingMessages.push(message);
      };
      tunnel.connect = () => {
        // Authentication and the guacd handshake stay on the platform. This
        // client only receives display instructions and acknowledges them.
        tunnel.setState(0);
      };
      tunnel.disconnect = () => {
        closed = true;
        displayConnected = false;
        const current = id.current;
        id.current = null;
        if (current)
          void command("terminal_close", { id: current }).catch((error) => {
            if (!disposed) toast.error(errorMessage(error));
          });
      };
      tunnel.sendMessage = (...elements: unknown[]) => {
        if (!elements.length) return;
        const message = `${elements
          .map((element) => {
            const value = String(element);
            return `${value.length}.${value}`;
          })
          .join(",")};`;
        sendMessage(message);
      };
      parser.oninstruction = (opcode, args) => {
        // Like WebSocketTunnel, open on the first complete instruction. Empty
        // opcodes carry tunnel metadata, not display instructions.
        if (!clientReady) {
          clientReady = true;
          tunnel.setState(1);
          if (id.current) pendingMessages.splice(0).forEach(sendMessage);
        }
        if (opcode !== "") tunnel.oninstruction?.(opcode, args);
      };
      const client = new Guacamole.Client(tunnel);
      rdpClient.current = client;
      const display = client.getDisplay().getElement() as HTMLElement;
      display.classList.add("rdp-display");
      display.tabIndex = 0;
      client.getDisplay().onresize = fitDisplay;
      rdpDisplay.current = display;
      container.current.replaceChildren(display);
      const keyboard = new Guacamole.Keyboard(display);
      keyboard.onkeydown = (keysym: number) => {
        client.sendKeyEvent(1, keysym);
        return false;
      };
      keyboard.onkeyup = (keysym: number) => {
        client.sendKeyEvent(0, keysym);
        return false;
      };
      const mouse = new Guacamole.Mouse(display);
      mouse.onmousedown =
        mouse.onmouseup =
        mouse.onmousemove =
          (state) => client.sendMouseState(state, true);
      const focusDisplay = () => display.focus();
      display.addEventListener("mousedown", focusDisplay);
      rdpInputHandlers.current.push(() => {
        display.removeEventListener("mousedown", focusDisplay);
        client.getDisplay().onresize = null;
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        mouse.onmousedown = null;
        mouse.onmouseup = null;
        mouse.onmousemove = null;
      });
      const size = displaySize();
      client.onstatechange = (state: number) => {
        if (disposed) return;
        if (state === 3) {
          setStatus("connected");
          displayConnected = true;
          resizeDisplay();
        }
      };
      client.onerror = (error: { message?: string }) => {
        if (!disposed) {
          setStatus("error");
          toast.error(rdpErrorMessage(error.message || "RDP 连接失败"));
        }
      };
      // Start the Guacamole client before opening the native relay. The
      // gateway may deliver the UUID frame before terminal_open resolves.
      client.connect(`width=${size.width}&height=${size.height}&dpi=96`);
      queueMicrotask(() => {
        if (disposed) return;
        const opening = openTerminal(target, 1, 1, (event) => {
          if (disposed) return;
          if (event.type === "rdp") {
            parser.receive(event.data);
          } else if (event.type === "error") {
            setStatus("error");
            toast.error(rdpErrorMessage(event.data));
          } else if (event.type === "closed") {
            closed = true;
            displayConnected = false;
            id.current = null;
            client.disconnect();
            setStatus((current) => (current === "error" ? current : "closed"));
          }
        });
        void opening
          .then((sessionId) => {
            if (disposed || closed) {
              void command("terminal_close", { id: sessionId }).catch(() => {});
              return;
            }
            id.current = sessionId;
            if (clientReady) pendingMessages.splice(0).forEach(sendMessage);
          })
          .catch((error) => {
            if (!disposed) {
              setStatus("error");
              toast.error(errorMessage(error));
            }
          });
      });
      return () => {
        disposed = true;
        resizeObserver.disconnect();
        document.removeEventListener("fullscreenchange", onFullscreenChange);
        rdpCleanup();
        id.current = null;
      };
    }
    let disposed = false;
    let closed = false;
    inputBuffer.current = "";
    lastCommand.current = "";
    const instance = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      overviewRuler: { width: 6 },
      theme: terminalThemes["pixiu-shell"].theme,
      // SearchAddon uses xterm's decoration API to highlight and scroll to matches.
      allowProposedApi: true,
    });
    const addon = new FitAddon();
    const search = new SearchAddon();
    instance.loadAddon(addon);
    instance.loadAddon(search);
    instance.open(container.current);
    addon.fit();
    terminal.current = instance;
    fit.current = addon;
    searchAddon.current = search;
    const onSearchResults = search.onDidChangeResults((result) => {
      setSearchResult({ index: result.resultIndex, count: result.resultCount });
    });
    shellTitleRef.current = null;
    shellTitleRevision.current = 0;
    commandTitleRevision.current = 0;
    commandTitleActive.current = false;
    const onTerminalTitle = instance.onTitleChange((title) => {
      const clean = cleanTerminalTitle(title);
      shellTitleRevision.current++;
      shellTitleRef.current = clean || null;
      titleUpdateRef.current?.(clean || null);
    });
    const onWriteParsed = instance.onWriteParsed(() => {
      if (!commandTitleActive.current) return;
      const prompt = visibleShellPrompt(instance);
      if (!prompt) return;
      commandTitleActive.current = false;
      const title =
        shellTitleRevision.current > commandTitleRevision.current
          ? shellTitleRef.current
          : target.mode === "shell"
            ? `${baseTitle} · ${prompt}`
            : `${prompt} (SSH)`;
      titleUpdateRef.current?.(title);
    });

    // Reconnect generation starts a fresh native session.
    // oxlint-disable-next-line react/set-state-in-effect
    setStatus("connecting");
    instance.writeln(
      `\x1b[38;5;108mPixiu Shell\x1b[0m · ${target.mode === "shell" ? "正在启动本机终端…" : "正在建立连接…"}`,
    );
    // Serialize writes so separate IPC tasks cannot reorder keystrokes or resize events.
    let writes: Promise<unknown> = Promise.resolve();
    function send(input: Record<string, unknown>) {
      const current = id.current;
      if (!current || disposed) return;
      writes = writes
        .then(() => command("terminal_input", { id: current, input }))
        .catch((error) => {
          if (!disposed) {
            setStatus("error");
            toast.error(errorMessage(error), { id: "terminal-input" });
          }
        });
    }
    const onData = instance.onData((data) => {
      if (
        target.mode !== "shell" &&
        data === "\r" &&
        instance.buffer.active.type === "normal"
      ) {
        try {
          const transfer = transferCommand(
            inputBuffer.current,
            preferencesRef.current.uploadCommand ?? "cl-u",
            preferencesRef.current.downloadCommand ?? "cl-d",
          );
          if (transfer) {
            send({ type: "input", data: "\u0015" });
            inputBuffer.current = "";
            if (!transfer.path.startsWith("/")) {
              const line =
                instance.buffer.active
                  .getLine(
                    instance.buffer.active.baseY +
                      instance.buffer.active.cursorY,
                  )
                  ?.translateToString(true) ?? "";
              const cwd = line.match(/^[\w.-]+@[\w.-]+:(\/.*?)\s*[$#]/)?.[1];
              setTransferPath({
                ...transfer,
                path: cwd
                  ? `${cwd.replace(/\/$/, "")}/${transfer.path === "." ? "" : transfer.path}`
                  : transfer.path === "."
                    ? "/"
                    : transfer.path,
              });
            } else void performTransfer(transfer);
            return;
          }
        } catch (error) {
          send({ type: "input", data: "\u0015" });
          inputBuffer.current = "";
          toast.error(errorMessage(error));
          return;
        }
      }

      const visible =
        data === "\r" && inputNeedsSnapshot.current
          ? visibleShellCommand(instance)
          : "";
      if (data.includes("\r") || data.includes("\n")) {
        const submitted = visible || inputBuffer.current.trim();
        if (submitted) {
          commandTitleActive.current = true;
          commandTitleRevision.current = shellTitleRevision.current;
          titleUpdateRef.current?.(cleanTerminalTitle(submitted));
        }
      }
      if (data.includes("\x1b") || data.includes("\t"))
        inputNeedsSnapshot.current = true;
      let pending = "";
      // oxlint-disable-next-line eslint/no-control-regex
      const clean = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (!data.includes("\x1b")) {
        for (const char of clean) {
          pending += char;
          if (char === "\r" || char === "\n") {
            const snapshot = visible || inputBuffer.current.trim();
            if (snapshot) lastCommand.current = snapshot;
            inputBuffer.current = "";
            inputNeedsSnapshot.current = false;
            send({
              type: "input",
              data: pending,
              ...(snapshot ? { command: snapshot } : {}),
            });
            pending = "";
          } else if (char === "\u007f" || char === "\b")
            inputBuffer.current = inputBuffer.current.slice(0, -1);
          else if (char === "\u0015" || char === "\u0003")
            inputBuffer.current = "";
          else if (char >= " ") inputBuffer.current += char;
        }
      } else {
        pending = data;
      }
      for (const chunk of pending.match(/.{1,8192}/gsu) ?? [])
        send({ type: "input", data: chunk });
    });
    const onResize = instance.onResize(({ cols, rows }) =>
      send({ type: "resize", cols, rows }),
    );
    const observer = new ResizeObserver(() => {
      if (container.current?.clientWidth && container.current.clientHeight)
        addon.fit();
    });
    observer.observe(container.current);
    // React development replay must not create two native SSH sessions.
    queueMicrotask(() => {
      if (disposed) return;
      void openTerminal(target, instance.cols, instance.rows, (event) => {
        if (disposed) return;
        if (event.type === "output") {
          const capture = commandCapture.current;
          if (capture) {
            capture.text = (
              capture.text +
              capture.decoder.decode(new Uint8Array(event.data), {
                stream: true,
              })
            ).slice(-64000);
            capture.updatedAt = Date.now();
          }
          instance.write(new Uint8Array(event.data));
        } else if (event.type === "closed") {
          closed = true;
          id.current = null;
          setStatus("closed");
          instance.writeln("\r\n\x1b[90m连接已关闭。\x1b[0m");
        } else if (event.type === "command_guard") {
          const guard = event.data;
          const color = guard.blocked ? "\x1b[31m" : "\x1b[33m";
          instance.writeln(
            `${color}[guard] ${guard.message}${guard.command ? ` · ${guard.command}` : ""}\x1b[0m`,
          );
          if (
            guard.blocked &&
            guard.action === "require_approval" &&
            guard.command
          ) {
            openCommandApproval({
              command: guard.command,
              message: guard.message,
              riskLevel: guard.riskLevel,
            });
          }
          if (commandCapture.current && guard.blocked)
            commandCapture.current.failure = guard.message;
        } else {
          if (
            commandCapture.current &&
            (event.type === "error" ||
              /命令策略 · (?:block|require_approval) ·/.test(event.data))
          )
            commandCapture.current.failure = event.data;
          // Connection lifecycle messages are already line-oriented. Do not
          // prepend another CRLF: xterm would render an empty row between each
          // handshake state and the remote login banner.
          instance.writeln(
            `${event.type === "error" ? "\x1b[31m" : "\x1b[90m"}${event.data}\x1b[0m`,
          );
          if (event.type === "error") setStatus("error");
          else if (
            event.data.includes("ssh session connected") ||
            event.data.includes("local shell connected")
          )
            setStatus("connected");
        }
      })
        .then((sessionId) => {
          if (disposed || closed) {
            void command("terminal_close", { id: sessionId }).catch(() => {});
            return;
          }
          id.current = sessionId;
          if (target.mode !== "platform") setStatus("connected");
          if (activeRef.current) instance.focus();
        })
        .catch((error) => {
          if (!disposed) {
            setStatus("error");
            instance.writeln(`\r\n\x1b[31m${errorMessage(error)}\x1b[0m`);
          }
        });
    });
    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
      onResize.dispose();
      onSearchResults.dispose();
      onTerminalTitle.dispose();
      onWriteParsed.dispose();
      const current = id.current;
      id.current = null;
      if (current)
        void command("terminal_close", { id: current }).catch((error) =>
          toast.error(errorMessage(error)),
        );
      instance.dispose();
      terminal.current = null;
      fit.current = null;
      searchAddon.current = null;
    };
  }, [target, generation, performTransfer, isRdp, rdpCleanup, baseTitle]);

  useEffect(() => {
    if (searchOpen) {
      const frame = requestAnimationFrame(() => searchInput.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [searchOpen]);
  function closeSearch() {
    searchTextRef.current = "";
    setSearchText("");
    setSearchResult(null);
    setSearchOpen(false);
    searchAddon.current?.clearDecorations();
    terminal.current?.focus();
  }
  function updateSearch(
    value: string,
    direction: "next" | "previous" = "next",
  ) {
    searchTextRef.current = value;
    setSearchText(value);
    if (!value) {
      searchAddon.current?.clearDecorations();
      setSearchResult(null);
      return;
    }
    const options = {
      decorations:
        terminalSearchDecorations[
          preferences.terminalTheme as keyof typeof terminalSearchDecorations
        ] ?? terminalSearchDecorations["pixiu-shell"],
    } as const;
    const found =
      direction === "previous"
        ? searchAddon.current?.findPrevious(value, options)
        : searchAddon.current?.findNext(value, options);
    if (found === false) setSearchResult({ index: -1, count: 0 });
  }

  const clearCommandApprovalTimer = useCallback(() => {
    if (commandApprovalTimer.current) {
      clearInterval(commandApprovalTimer.current);
      commandApprovalTimer.current = null;
    }
    if (commandApprovalCountdownTimer.current) {
      clearInterval(commandApprovalCountdownTimer.current);
      commandApprovalCountdownTimer.current = null;
    }
  }, []);

  const startCommandApprovalCountdown = useCallback(
    (expiresAt: string) => {
      if (commandApprovalCountdownTimer.current)
        clearInterval(commandApprovalCountdownTimer.current);
      const update = () => {
        const remaining = Math.max(
          0,
          Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000),
        );
        setPendingCommandApproval((current) =>
          current
            ? {
                ...current,
                remainingSeconds: remaining,
                approval:
                  remaining === 0 && current.approval?.status === "pending"
                    ? { ...current.approval, status: "expired" }
                    : current.approval,
              }
            : current,
        );
        if (remaining === 0) clearCommandApprovalTimer();
      };
      commandApprovalCountdownTimer.current = setInterval(update, 1000);
      update();
    },
    [clearCommandApprovalTimer],
  );

  function formatCommandApprovalCountdown(seconds?: number) {
    if (seconds === undefined) return "提交后等待 5 分钟";
    const safe = Math.max(0, seconds);
    return `审批剩余 ${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
  }

  const openCommandApproval = useCallback(
    (guard: { command: string; message: string; riskLevel?: string }) => {
      setPendingCommandApproval(guard);
    },
    [],
  );

  const submitCommandApproval = useCallback(
    async (decision: "submit" | "ignore") => {
      if (
        !pendingCommandApproval ||
        commandApprovalBusy ||
        target.mode !== "platform"
      )
        return;
      setCommandApprovalBusy(true);
      try {
        const approval = await createCommandApproval({
          hostId: target.id,
          accountId: target.accountId,
          accessPathId: target.accessPathId,
          command: pendingCommandApproval.command,
          decision,
          clientKind: "pixiu-shell",
        });
        setPendingCommandApproval((current) =>
          current ? { ...current, approval } : current,
        );
        if (decision === "ignore") {
          toast.info("已忽略本次命令审批申请");
          setPendingCommandApproval(null);
          return;
        }
        clearCommandApprovalTimer();
        const startedAt = Date.now();
        commandApprovalTimer.current = setInterval(async () => {
          if (Date.now() - startedAt >= 5 * 60 * 1000) {
            clearCommandApprovalTimer();
            toast.error("审批等待已超过 5 分钟，本次申请已失效");
            return;
          }
          try {
            const current = await getCommandApproval(approval.id);
            setPendingCommandApproval((value) =>
              value
                ? {
                    ...value,
                    approval:
                      value.approval?.status === "cancelled"
                        ? value.approval
                        : current,
                    remainingSeconds:
                      value.approval?.status === "cancelled"
                        ? 0
                        : current.status === "pending"
                          ? Math.max(
                              0,
                              Math.ceil(
                                (new Date(current.expiresAt).getTime() -
                                  Date.now()) /
                                  1000,
                              ),
                            )
                          : 0,
                  }
                : value,
            );
            if (current.status !== "pending") {
              clearCommandApprovalTimer();
              if (current.status === "approved")
                toast.success("管理员已通过命令审批");
            }
          } catch {
            // Retry transient platform failures until the fixed five-minute deadline.
          }
        }, 2000);
        startCommandApprovalCountdown(approval.expiresAt);
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setCommandApprovalBusy(false);
      }
    },
    [
      clearCommandApprovalTimer,
      commandApprovalBusy,
      pendingCommandApproval,
      startCommandApprovalCountdown,
      target,
    ],
  );

  const executeApprovedCommand = useCallback(async () => {
    const pending = pendingCommandApproval;
    const sessionId = id.current;
    if (!pending || pending.approval?.status !== "approved" || !sessionId)
      return;
    try {
      await command("terminal_input", {
        id: sessionId,
        input: { type: "input", data: `${pending.command}\r` },
      });
      setPendingCommandApproval(null);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, [pendingCommandApproval]);

  const cancelPendingCommandApproval = useCallback(async () => {
    const pending = pendingCommandApproval;
    if (
      !pending?.approval ||
      pending.approval.status !== "pending" ||
      commandApprovalBusy
    )
      return;
    setCommandApprovalBusy(true);
    try {
      const approval = await cancelCommandApproval(pending.approval.id);
      clearCommandApprovalTimer();
      setPendingCommandApproval((current) =>
        current ? { ...current, approval, remainingSeconds: 0 } : current,
      );
      toast.info("已取消本次命令审批申请");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCommandApprovalBusy(false);
    }
  }, [clearCommandApprovalTimer, commandApprovalBusy, pendingCommandApproval]);

  useEffect(() => clearCommandApprovalTimer, [clearCommandApprovalTimer]);

  useEffect(() => {
    if (terminal.current) {
      const theme = (
        terminalThemes[preferences.terminalTheme] ?? terminalThemes["pixiu-shell"]
      ).theme;
      // The window itself is blended once from preferences, so the theme keeps
      // its opaque background here.
      terminal.current.options.theme = theme;
      terminal.current.options.fontSize = preferences.fontSize;
      terminal.current.options.scrollback = preferences.scrollback;
      if (active) fit.current?.fit();
    }
  }, [
    preferences.terminalTheme,
    preferences.fontSize,
    preferences.scrollback,
    generation,
    active,
  ]);

  useEffect(() => {
    if (active) {
      fit.current?.fit();
      if (!document.activeElement?.closest(".terminal-search-bar"))
        terminal.current?.focus();
    }
  }, [active]);
  async function disconnect() {
    const current = id.current;
    if (current) {
      try {
        await command("terminal_close", { id: current });
        id.current = null;
        setStatus("closed");
      } catch (error) {
        toast.error(errorMessage(error));
      }
    }
  }
  const statusLabel =
    status === "connected"
      ? target.mode === "shell"
        ? "本机 Shell"
        : target.mode === "local"
          ? "SSH 进程已启动"
          : "已连接"
      : status === "connecting"
        ? "连接中"
        : status === "error"
          ? "连接异常"
          : "已断开";
  return (
    <div
      className="terminal-pane"
      onKeyDownCapture={(event) => {
        if (
          !event.nativeEvent.isComposing &&
          shortcutMatches(event.nativeEvent, "Mod+F")
        ) {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
          // Repeated Find must focus an already-open input after shell input.
          searchInput.current?.focus();
        }
      }}
      data-font-size={preferences.fontSize}
      data-terminal-search-match={searchResult?.count ? "true" : "false"}
      style={
        {
          "--terminal-background": (
            terminalThemes[preferences.terminalTheme] ??
            terminalThemes["pixiu-shell"]
          ).theme.background,
          background: "var(--terminal-background)",
        } as CSSProperties
      }
    >
      {searchOpen ? (
        <div
          className="terminal-search-bar"
          role="search"
          aria-label="搜索终端文本"
        >
          <Search />
          <input
            data-terminal-search="true"
            ref={searchInput}
            aria-label="搜索终端文本"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="搜索终端文本"
            value={searchText}
            onChange={(event) => updateSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape" || event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") closeSearch();
                else
                  updateSearch(
                    searchText,
                    event.shiftKey ? "previous" : "next",
                  );
              }
            }}
          />
          <span className="terminal-search-count" aria-live="polite">
            {searchText
              ? searchResult?.count
                ? `${searchResult.index + 1}/${searchResult.count}`
                : "未找到"
              : ""}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="上一个匹配"
            onClick={() => updateSearch(searchText, "previous")}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="下一个匹配"
            onClick={() => updateSearch(searchText)}
          >
            <ChevronDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="关闭终端搜索"
            onClick={closeSearch}
          >
            <X />
          </Button>
        </div>
      ) : null}
      <div
        className="terminal-meta"
        title="10 分钟无终端输入后自动断开；心跳和终端输出不延长空闲时间"
      >
        {title ? (
          <button
            type="button"
            className="pane-drag-bar"
            aria-label={`拖动窗格 ${title}`}
            title="双击标题栏最大化 / 恢复；拖动边缘重排、中心交换；Alt 拖动终端区域"
            {...dragHandleProps}
          >
            <GripVertical className="pane-grip" />
            <span className={`connection-dot ${status}`} />
            <strong className="pane-title">{title}</strong>
            {terminalTitle ? (
              <span className="pane-host-label">{baseTitle}</span>
            ) : null}
            <span className="pane-connection-label">{statusLabel}</span>
          </button>
        ) : (
          <span className="terminal-status">
            <span className={`connection-dot ${status}`} />
            <span>{statusLabel}</span>
          </span>
        )}
        {!title && terminalTitle ? (
          <div className="terminal-runtime-title">
            <strong>{terminalTitle}</strong>
            <small>{baseTitle}</small>
          </div>
        ) : null}
        {target.mode !== "shell" ? (
          <button
            type="button"
            className="terminal-address"
            aria-label={`复制 IP ${address}`}
            title={`复制 IP：${address}`}
            onClick={() =>
              void navigator.clipboard
                .writeText(address)
                .then(() => toast.success("IP 已复制"))
                .catch((error) => toast.error(errorMessage(error)))
            }
          >
            <span>{address}</span>
            <Copy />
          </button>
        ) : (
          <span className="terminal-address">本机</span>
        )}
        {isRdp ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={rdpFullscreen ? "退出 RDP 全屏" : "RDP 全屏"}
            title={rdpFullscreen ? "退出全屏" : "全屏"}
            onClick={() => void toggleRdpFullscreen()}
          >
            <Maximize2 />
          </Button>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={status === "connecting"}
            aria-label={status === "connected" ? "断开终端" : "连接终端"}
            title={status === "connected" ? "断开" : "连接"}
            onClick={() =>
              status === "connected"
                ? void disconnect()
                : setGeneration((value) => value + 1)
            }
          >
            {status === "connected" ? <Unplug /> : <PlugZap />}
          </Button>
          {onClose ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`关闭窗格 ${title}`}
              title="关闭窗格"
              onClick={onClose}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>
      <Dialog
        open={!!transferPath}
        onOpenChange={(open) => {
          if (!open) setTransferPath(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {transferPath?.direction === "upload" ? "上传文件" : "下载文件"}
            </DialogTitle>
            <DialogDescription>
              请确认远端绝对路径，然后选择本地文件。未识别出当前目录时需要手动指定。
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="快捷传输远端路径"
            value={transferPath?.path ?? ""}
            onChange={(e) =>
              setTransferPath((current) =>
                current ? { ...current, path: e.target.value } : null,
              )
            }
          />
          <Button
            disabled={!transferPath?.path.startsWith("/")}
            onClick={() => {
              if (transferPath) {
                void performTransfer(transferPath);
                setTransferPath(null);
              }
            }}
          >
            选择本地文件
          </Button>
        </DialogContent>
      </Dialog>
      {pendingCommandApproval ? (
        <div
          className="terminal-command-approval"
          role="status"
          aria-live="polite"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="terminal-command-approval__copy">
            <div className="terminal-command-approval__title">
              <strong>命令已暂停，等待审批决定</strong>
              {pendingCommandApproval.approval ? (
                <span className="terminal-command-approval__state">
                  {pendingCommandApproval.approval.status === "pending"
                    ? "等待管理员处理"
                    : pendingCommandApproval.approval.status === "approved"
                      ? "审批通过"
                      : pendingCommandApproval.approval.status === "expired"
                        ? "已过期"
                        : pendingCommandApproval.approval.status === "cancelled"
                          ? "已取消"
                          : "已拒绝"}
                </span>
              ) : null}
            </div>
            <code
              className="terminal-command-approval__command"
              title={pendingCommandApproval.command}
            >
              {pendingCommandApproval.command}
            </code>
            <span className="terminal-command-approval__hint">
              {pendingCommandApproval.approval?.status === "pending"
                ? formatCommandApprovalCountdown(
                    pendingCommandApproval.remainingSeconds,
                  )
                : pendingCommandApproval.approval?.status === "approved"
                  ? `管理员已通过，可执行至 ${new Date(pendingCommandApproval.approval.approvedUntil || "").toLocaleTimeString()}`
                  : pendingCommandApproval.approval?.status === "expired"
                    ? "审批已过期，等待时间超过 5 分钟"
                    : pendingCommandApproval.approval?.status === "cancelled"
                      ? "审批已取消，当前命令未执行"
                      : pendingCommandApproval.message}
            </span>
          </div>
          <div className="terminal-command-approval__actions">
            {!pendingCommandApproval.approval ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={commandApprovalBusy}
                  onClick={() => void submitCommandApproval("ignore")}
                >
                  忽略
                </Button>
                <Button
                  size="sm"
                  disabled={commandApprovalBusy}
                  onClick={() => void submitCommandApproval("submit")}
                >
                  {commandApprovalBusy ? "提交中" : "确认提交审批"}
                </Button>
              </>
            ) : pendingCommandApproval.approval.status === "approved" ? (
              <Button size="sm" onClick={() => void executeApprovedCommand()}>
                执行命令
              </Button>
            ) : pendingCommandApproval.approval.status === "pending" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={commandApprovalBusy}
                onClick={() => void cancelPendingCommandApproval()}
              >
                取消审批
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  clearCommandApprovalTimer();
                  setPendingCommandApproval(null);
                }}
              >
                关闭
              </Button>
            )}
          </div>
        </div>
      ) : null}
      <div
        className="terminal-surface"
        aria-label={
          isRdp
            ? "Windows RDP 终端"
            : target.mode === "shell"
              ? "本机终端"
              : "SSH 终端"
        }
        onPointerDown={() => {
          if (!searchOpen) return;
          requestAnimationFrame(() => terminal.current?.focus());
        }}
      >
        <div ref={container} className="terminal-host" />
      </div>
    </div>
  );
}
