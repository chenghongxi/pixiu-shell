import { ScreenLock } from "@/components/ScreenLock";
import { HostKeyPrompt } from "@/components/HostKeyPrompt";
import { effectiveShortcuts, shortcutMatches } from "@/lib/shortcuts";
import type { LockStatus } from "@/lib/api";
import { applyWindowOpacity, GRAPHITE_BACKGROUND } from "@/lib/themes";
import { HostSearch } from "@/components/HostSearch";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  LockKeyhole,
  FileCode2,
  ListChecks,
  Sparkles,
  Copy,
  Columns2,
  Rows2,
  Maximize2,
  PanelsTopLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  LoaderCircle,
  Moon,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Server,
  Square,
  Settings2,
  Sun,
  Tag,
  TerminalSquare,
  X,
  ArrowUpRight,
  ArrowRightLeft,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, SearchInput } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Toaster } from "@/components/ui/sonner";
import { ObjectStorageFolderIcon } from "@/components/ObjectStorageFolderIcon";
import { MonitorIcon } from "@/components/MonitorIcon";
import { HostEditor } from "@/components/HostEditor";
import { Choice } from "@/components/Choice";
import { PlatformLogin } from "@/components/PlatformLogin";
import { SettingsPage } from "@/components/SettingsPage";
import { BatchImportDialog } from "@/components/BatchImportDialog";
import { FileManager } from "@/components/FileManager";
import {
  command,
  onPlatformAuthExpired,
  desktop,
  defaultPreferences,
  directOptions,
  errorMessage,
  fromLocal,
  fromPlatform,
  platform,
  type Host,
  type HostOptions,
  type LocalHost,
  type Mode,
  type Preferences,
  type Target,
  type User,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
const TerminalPane = lazy(() =>
  import("@/components/TerminalPane").then((module) => ({
    default: module.TerminalPane,
  })),
);
const AiAssistant = lazy(() =>
  import("@/components/AiAssistant").then((module) => ({
    default: module.AiAssistant,
  })),
);
import type { TerminalHandle } from "@/lib/terminal-ai";
import { PanelDock } from "@/components/PanelDock";
import { ResizeHandle } from "@/components/ResizeHandle";
import {
  measurePanes,
  paneIds,
  paneStyle,
  removePane,
  resizePane,
  splitPane,
  movePane,
  swapPanes,
  type PaneLayout,
  type SplitAxis,
} from "@/lib/pane-layout";
import { usePaneDrag, type PaneDrop } from "@/hooks/use-pane-drag";
import { HostTree } from "@/components/HostTree";
import { HostDetails } from "@/components/HostDetails";
import { HostProfile, type HostProfileTab } from "@/components/HostProfile";
import { HostMonitor } from "@/components/HostMonitor";
import { resource, platformGroupPaths, type HostNode } from "@/lib/api";
import { BatchCommand } from "@/components/BatchCommand";
const ScriptManager = lazy(() =>
  import("@/components/ScriptManager").then((module) => ({
    default: module.ScriptManager,
  })),
);
interface Session {
  fontSize?: number;
  label?: string;
  terminalTitle?: string;
  id: string;
  host: Host;
  target: Target;
}
function sessionTitle(session: Session) {
  return session.label || session.host.name;
}
function paneTitle(session: Session) {
  return session.terminalTitle || sessionTitle(session);
}
const cacheKey = "pixiu-shell:preferences:v2";
// Written by the previous TShell-branded build; adopted once on first read.
const legacyCacheKey = "tshell:preferences:v2";
function cachedPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(cacheKey);
    if (stored) return { ...defaultPreferences, ...JSON.parse(stored) };
    const legacy = localStorage.getItem(legacyCacheKey);
    if (legacy) {
      localStorage.setItem(cacheKey, legacy);
      localStorage.removeItem(legacyCacheKey);
      return { ...defaultPreferences, ...JSON.parse(legacy) };
    }
  } catch {
    return defaultPreferences;
  }
  return defaultPreferences;
}
function GroupPath({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length)
    return <span className="workspace-group-path__empty">未分组</span>;
  return (
    <span className="workspace-group-path" title={path}>
      {segments.map((segment, index) => (
        <span
          key={`${segment}-${index}`}
          className="workspace-group-path__segment"
          data-current={index === segments.length - 1 || undefined}
        >
          {index ? <ChevronRight aria-hidden="true" /> : null}
          <span>{segment}</span>
        </span>
      ))}
    </span>
  );
}
function uniqueLocalHostCopyName(
  name: string,
  hosts: LocalHost[],
  group: string,
) {
  const taken = new Set(
    hosts
      .filter((host) => (host.group || "") === (group || ""))
      .map((host) => host.name),
  );
  const source = name.trim() || "主机";
  const base = `${source} 副本`;
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${source} 副本 ${index}`)) index += 1;
  return `${source} 副本 ${index}`;
}

export default function App() {
  const [preferences, setPreferences] = useState(cachedPreferences);
  const [lockStatus, setLockStatus] = useState<LockStatus>({
    configured: false,
    locked: false,
  });
  const [systemShell, setSystemShell] = useState(
    /Win/.test(navigator.platform)
      ? "cmd"
      : /Mac/.test(navigator.platform)
        ? "zsh"
        : "bash",
  );
  const [ready, setReady] = useState(!desktop);
  const [mode, setMode] = useState<Mode>(preferences.mode);
  const [view, setView] = useState<"workspace" | "settings" | "scripts">(
    "workspace",
  );
  const [settingsTab, setSettingsTab] = useState("appearance");
  const [resourceCreateRequest, setResourceCreateRequest] = useState(0);
  const [createRequest, setCreateRequest] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [localHosts, setLocalHosts] = useState<LocalHost[]>([]);
  const [localGroups, setLocalGroups] = useState<string[]>([]);
  const [hostCreateOpen, setHostCreateOpen] = useState(false);
  const [platformHosts, setPlatformHosts] = useState<Host[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resourceGroupFilter, setResourceGroupFilter] = useState<string | null>(
    null,
  );
  const [resourcePage, setResourcePage] = useState(1);
  const [workspaceHostPageSize, setWorkspaceHostPageSize] = useState(10);
  const [workspaceHostPageJump, setWorkspaceHostPageJump] = useState("1");
  const [workspaceSelectedHosts, setWorkspaceSelectedHosts] = useState<
    string[]
  >([]);
  const [workspaceCheckingHost, setWorkspaceCheckingHost] = useState<
    string | null
  >(null);
  const [workspaceEditingHost, setWorkspaceEditingHost] =
    useState<LocalHost | null>(null);
  const [inlineEditingHostId, setInlineEditingHostId] = useState<string | null>(
    null,
  );
  const [workspaceMoreOpen, setWorkspaceMoreOpen] = useState<string | null>(
    null,
  );
  const [workspaceDeleteHost, setWorkspaceDeleteHost] =
    useState<LocalHost | null>(null);
  const [workspaceHostKeyword, setWorkspaceHostKeyword] = useState("");
  const [workspaceHostNotice, setWorkspaceHostNotice] = useState(true);
  const [workspaceBatchImportOpen, setWorkspaceBatchImportOpen] =
    useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [hostTreeMenu, setHostTreeMenu] = useState<
    | { kind: "root"; x: number; y: number }
    | { kind: "group"; group: string; x: number; y: number }
    | { kind: "host"; host: LocalHost; x: number; y: number }
    | null
  >(null);
  const [folderCreateParent, setFolderCreateParent] = useState<
    string | null | undefined
  >(undefined);
  const [folderName, setFolderName] = useState("");
  const [folderSaving, setFolderSaving] = useState(false);
  const [movingHost, setMovingHost] = useState<LocalHost | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [movingHostSaving, setMovingHostSaving] = useState(false);
  const [revealRevision, setRevealRevision] = useState(0);
  const hostTree = useRef<HTMLDivElement>(null);
  const sessionBarRef = useRef<HTMLDivElement>(null);
  const [hostSearchOpen, setHostSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [layouts, setLayouts] = useState<PaneLayout[]>([]);
  const [maximizedLayoutPaneId, setMaximizedPaneId] = useState<string | null>(
    null,
  );
  const [fullscreen, setFullscreen] = useState(false);
  const isWindowsPlatform = /Win/.test(navigator.platform);
  const [attachPane, setAttachPane] = useState<{
    id: string;
    axis: SplitAxis;
  } | null>(null);
  const paneContainer = useRef<HTMLDivElement>(null);
  const splitNumber = useRef(1);
  const [active, setActive] = useState("home");
  const [scriptsVisited, setScriptsVisited] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const terminalHandles = useRef(new Map<string, TerminalHandle>());
  const [fileTarget, setFileTarget] = useState<{
    target: Target;
    name: string;
  } | null>(null);
  const [hostProfileTab, setHostProfileTab] =
    useState<HostProfileTab>("overview");
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<{
    host: Host;
    options: HostOptions;
    purpose: "terminal" | "files";
  } | null>(null);
  const [accountId, setAccountId] = useState("default");
  const [pathId, setPathId] = useState("default");
  const search = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const connectId = useRef(0);
  const preferenceQueue = useRef<Promise<void>>(Promise.resolve());
  const prefsRef = useRef(preferences);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    setHostProfileTab("overview");
  }, [selectedId]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      const theme =
        preferences.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preferences.theme;
      document.documentElement.style.setProperty(
        "--graphite-background",
        GRAPHITE_BACKGROUND,
      );
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.dataset.theme = theme;
      setResolvedTheme(theme);
    }
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);
  useEffect(() => {
    // Surface colors blend with the desktop via --window-opacity so text,
    // icons and borders stay opaque; dialogs follow --popup-opacity.
    applyWindowOpacity(
      document.documentElement,
      preferences.windowOpacity ?? 100,
    );
  }, [preferences.windowOpacity]);
  useEffect(
    () =>
      onPlatformAuthExpired(() => {
        // Invalidate requests already in flight before clearing their cached data.
        requestId.current++;
        connectId.current++;
        setUser(null);
        setPlatformHosts([]);
        setLoading(false);
        setConnecting(false);
        setConnection(null);
        setAiOpen(false);
        setFileTarget((current) =>
          current?.target.mode === "platform" ? null : current,
        );
        setError("平台登录已失效，请重新登录");
      }),
    [],
  );
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    // Wait out React development replay before restoring native session state.
    queueMicrotask(() => {
      if (cancelled) return;
      void Promise.all([
        command<Preferences>("preferences_load"),
        command<User | null>("workspace_restore").catch((error) => {
          if (!cancelled) setError(errorMessage(error));
          return null;
        }),
        command<LockStatus>("lock_status"),
        command<{ name: string }>("system_shell_info"),
      ])
        .then(([preferences, user, lock, shell]) => {
          if (cancelled) return;
          prefsRef.current = preferences;
          setPreferences(preferences);
          setMode(preferences.mode);
          setUser(user);
          if (lock) setLockStatus(lock);
          if (shell?.name) setSystemShell(shell.name);
          localStorage.setItem(cacheKey, JSON.stringify(preferences));
          setReady(true);
        })
        .catch((error) => {
          if (!cancelled) {
            setError(errorMessage(error));
            setReady(true);
          }
        });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const refreshLocal = useCallback(async () => {
    if (!desktop) return;
    try {
      const [hosts, groups] = await Promise.all([
        command<LocalHost[]>("local_hosts"),
        command<string[]>("groups_list"),
      ]);
      setLocalHosts(
        hosts.map((host) => ({
          ...host,
          tags: host.tags ?? [],
          tunnels: host.tunnels ?? [],
          hasPassword: host.hasPassword ?? false,
        })),
      );
      setLocalGroups(groups);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }, []);
  function openFolderCreate(parent: string | null) {
    setHostTreeMenu(null);
    setFolderCreateParent(parent);
    setFolderName("");
  }
  async function saveFolder() {
    const name = folderName.trim();
    if (!name) {
      toast.error("请输入文件夹名称");
      return;
    }
    if (name.includes("/")) {
      toast.error("文件夹名称不能包含 /");
      return;
    }
    setFolderSaving(true);
    try {
      const path = folderCreateParent ? `${folderCreateParent}/${name}` : name;
      await command("group_save", { previous: null, name: path });
      setExpandedGroups((current) => {
        const next = new Set(current);
        if (folderCreateParent) next.add(`local:group:${folderCreateParent}`);
        return next;
      });
      await refreshLocal();
      setFolderCreateParent(undefined);
      toast.success("文件夹已创建");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setFolderSaving(false);
    }
  }
  function openMoveHost(host: LocalHost) {
    setHostTreeMenu(null);
    setMovingHost(host);
    setMoveTarget(host.group || "__unassigned__");
  }
  async function moveHostToGroup() {
    if (!movingHost) return;
    setMovingHostSaving(true);
    try {
      await moveLocalHostToGroup(
        movingHost,
        moveTarget === "__unassigned__" ? "" : moveTarget,
      );
      await refreshLocal();
      setMovingHost(null);
      toast.success("主机分组已更新");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setMovingHostSaving(false);
    }
  }
  async function moveLocalHostToGroup(host: LocalHost, group: string) {
    await command("save_host", {
      host: { ...host, group },
      password: null,
    });
  }
  async function duplicateLocalHost(host: LocalHost) {
    if (!host.id) {
      toast.error("无法复制未保存的主机");
      return;
    }
    setHostTreeMenu(null);
    try {
      await command("duplicate_host", {
        id: host.id,
        name: uniqueLocalHostCopyName(host.name, localHosts, host.group),
      });
      if (host.group) {
        setExpandedGroups((current) => {
          const next = new Set(current);
          next.add(`local:group:${host.group}`);
          return next;
        });
      }
      await refreshLocal();
      toast.success("已在当前分组创建副本");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function dropHostIntoGroup(host: Host, group: string) {
    if (!host.local || host.local.group === group) return;
    try {
      await moveLocalHostToGroup(host.local, group);
      await refreshLocal();
      toast.success(`已将“${host.name}”移动到“${group}”`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function dropGroupIntoGroup(source: string, target: string) {
    const name = source.split("/").filter(Boolean).at(-1);
    if (!name || `${target}/${name}` === source) return;
    try {
      await command("group_move", { source, target });
      setExpandedGroups((current) => {
        const next = new Set(current);
        next.add(`local:group:${target}`);
        return next;
      });
      await refreshLocal();
      toast.success(`已将“${name}”移动到“${target}”`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  useEffect(() => {
    if (!hostTreeMenu) return;
    const close = () => setHostTreeMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hostTreeMenu]);
  useEffect(() => {
    // Synchronize native SQLite data once bootstrap has completed.
    // oxlint-disable-next-line react/set-state-in-effect
    if (ready && !lockStatus.locked) void refreshLocal();
  }, [ready, refreshLocal, lockStatus.locked]);
  const refreshPlatform = useCallback(async () => {
    const generation = ++requestId.current;
    if (!desktop || !user) {
      setPlatformHosts([]);
      return;
    }
    setError("");
    setLoading(true);
    try {
      const [hosts, nodes] = await Promise.all([
        platform<import("@/lib/api").PlatformHost[]>({ type: "hosts" }),
        resource<HostNode[]>("assets/nodes").catch(() => []),
      ]);
      const paths = platformGroupPaths(nodes);
      if (generation === requestId.current)
        setPlatformHosts(
          hosts.map((host) => {
            const result = fromPlatform(host),
              groupPaths =
                host.nodeIds
                  ?.map((id) => paths.get(id))
                  .filter((path): path is string => !!path) ?? [];
            return {
              ...result,
              group: groupPaths[0] || result.group,
              groupPaths: groupPaths.length ? groupPaths : [result.group],
            };
          }),
        );
    } catch (error) {
      if (generation === requestId.current) {
        setPlatformHosts([]);
        setError(errorMessage(error));
      }
    } finally {
      if (generation === requestId.current) setLoading(false);
    }
  }, [user]);
  useEffect(() => {
    // Synchronize the external platform when its identity changes.
    // oxlint-disable-next-line react/set-state-in-effect
    if (ready && mode === "platform" && !lockStatus.locked)
      void refreshPlatform();
    return () => {
      // Cancellation generation; this is not a DOM ref.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      requestId.current++;
    };
  }, [ready, mode, refreshPlatform, lockStatus.locked]);
  async function lockWorkspace() {
    if (!lockStatus.configured) {
      settings("security");
      toast.info("请先设置锁屏密码");
      return;
    }
    try {
      const value = await command<LockStatus>("screen_lock");
      setHostSearchOpen(false);
      setLoginOpen(false);
      setAttachPane(null);
      setLockStatus(value);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function unlockWorkspace() {
    setLockStatus((current) => ({ ...current, locked: false }));
    if (!user && desktop)
      try {
        setUser(await command<User | null>("platform_restore"));
      } catch (error) {
        setError(errorMessage(error));
      }
    requestAnimationFrame(() => terminalHandles.current.get(active)?.focus());
  }
  const keyboardShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (lockStatus.locked || event.isComposing) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest("[data-shortcut-recorder]")) return;
    const bindings = effectiveShortcuts(preferences.shortcuts);
    const action = Object.entries(bindings).find(([, binding]) =>
      shortcutMatches(event, binding),
    )?.[0];
    if (!action) return;
    const editing =
      element?.closest('input,textarea,[contenteditable="true"]') &&
      !element.closest(".terminal-surface");
    if (
      !["search", "lock", "settings"].includes(action) &&
      (view !== "workspace" ||
        editing ||
        document.querySelector('[role="dialog"]'))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "search") {
      setHostSearchOpen((value) => !value);
      return;
    }
    if (action === "settings") {
      settings();
      return;
    }
    if (action === "lock") {
      void lockWorkspace();
      return;
    }
    if (action === "fullscreen") {
      void toggleFullscreen();
      return;
    }
    if (action === "newShell") {
      newSystemShell();
      return;
    }
    if (action === "splitRight" || action === "splitDown") {
      splitActive(action === "splitRight" ? "row" : "column");
      return;
    }
    if (action === "closeTab") {
      if (active !== "home") closeSession(active);
      return;
    }
    if (action === "nextTab" || action === "previousTab") {
      const index = sessions.findIndex((session) => session.id === active);
      const position =
        index < 0
          ? action === "nextTab"
            ? 0
            : sessions.length - 1
          : (index + (action === "nextTab" ? 1 : -1) + sessions.length) %
            sessions.length;
      const next = sessions[position];
      if (next) activateSession(next);
      return;
    }
    if (action === "zoomReset") {
      setSessions((current) =>
        current.map((session) =>
          session.id === active ? { ...session, fontSize: undefined } : session,
        ),
      );
      return;
    }
    const delta = action === "zoomIn" ? 1 : -1;
    setSessions((current) =>
      current.map((session) =>
        session.id === active
          ? {
              ...session,
              fontSize: Math.max(
                10,
                Math.min(
                  24,
                  (session.fontSize ?? preferences.fontSize) + delta,
                ),
              ),
            }
          : session,
      ),
    );
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => keyboardShortcut(event);
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);
  function savePreferences(next: Preferences): Promise<void> {
    const previous = prefsRef.current;
    prefsRef.current = next;
    const operation = preferenceQueue.current.then(async () => {
      if (desktop) await command("preferences_save", { preferences: next });
      localStorage.setItem(cacheKey, JSON.stringify(next));
      setPreferences(next);
      if (previous.platformAddress !== next.platformAddress) {
        // Cancellation generation; this is not a DOM ref.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        requestId.current++;
        connectId.current++;
        setUser(null);
        setPlatformHosts([]);
        dropLayoutSessions(
          sessions
            .filter((session) => session.target.mode === "platform")
            .map((session) => session.id),
        );
        setSessions((current) =>
          current.filter((session) => session.target.mode === "local"),
        );
        setFileTarget(null);
        setActive("home");
      }
    });
    preferenceQueue.current = operation.catch(() => {
      prefsRef.current = previous;
    });
    return operation;
  }
  function patchPreferences(patch: Partial<Preferences>) {
    return savePreferences({ ...prefsRef.current, ...patch });
  }
  function settings(tab = "appearance", add = false) {
    setSettingsTab(tab);
    setView("settings");
    if (add) setCreateRequest((value) => value + 1);
  }
  async function testWorkspaceHost(host: LocalHost) {
    setWorkspaceCheckingHost(host.id);
    try {
      await command<{ message: string }>("local_connectivity_test", {
        host: { ...host, proxy: host.proxy ?? null },
        password: null,
        proxyPassword: null,
      });
      toast.success(`${host.address} SSH 连通正常`, {
        className: "connectivity-toast",
      });
    } catch (error) {
      toast.error(`${host.name}：${errorMessage(error)}`);
    } finally {
      setWorkspaceCheckingHost(null);
    }
  }
  async function deleteWorkspaceHost() {
    if (!workspaceDeleteHost?.id) return;
    try {
      await command("delete_host", { id: workspaceDeleteHost.id });
      toast.success(`已删除 ${workspaceDeleteHost.name}`);
      setWorkspaceDeleteHost(null);
      setWorkspaceMoreOpen(null);
      await refreshLocal();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function login() {
    if (!preferences.platformAddress) {
      settings("platform");
      toast.info("请先配置并保存运维平台地址");
    } else {
      if (desktop) {
        try {
          const restored = await command<User | null>("platform_restore");
          if (restored) {
            setUser(restored);
            return;
          }
        } catch (error) {
          setError(errorMessage(error));
          setLoginOpen(true);
          return;
        }
      }
      setLoginOpen(true);
    }
  }
  function revealHost(host: Host, select = true) {
    setInlineEditingHostId(null);
    const group =
      preferences.groupBy === "tag" ? host.tags[0] || "无标签" : host.group;
    if (select) setSelectedId(host.id);
    setKeyword("");
    const parts = group.split("/").filter(Boolean);
    const expansionKeys = parts.map(
      (_, index) =>
        `${host.mode}:${preferences.groupBy}:${parts.slice(0, index + 1).join("/")}`,
    );
    setExpandedGroups(new Set(expansionKeys));
    setRevealRevision((value) => value + 1);
    if (mode !== host.mode) {
      setMode(host.mode);
      void patchPreferences({ mode: host.mode }).catch((error) =>
        toast.error(errorMessage(error)),
      );
    }
  }
  function openHostProfile(host: Host) {
    setInlineEditingHostId(null);
    setSelectedId(host.id);
    setResourceGroupFilter(null);
    setView("workspace");
    setActive("home");
  }
  function closeHostProfile() {
    setInlineEditingHostId(null);
    setSelectedId(null);
    if (active !== "home") return;
    const fallback = sessions.at(-1);
    if (fallback) setActive(fallback.id);
  }
  function activateSession(session: Session) {
    if (session.target.mode === "shell") {
      setView("workspace");
      setActive(session.id);
      return;
    }

    // Prefer fresh resource metadata after a host has moved to another group.
    const host =
      session.target.mode === "local"
        ? localHosts.find((host) => host.id === session.host.id)
        : undefined;
    const current = host
      ? fromLocal(host)
      : (platformHosts.find(
          (host) =>
            host.id === session.host.id && host.mode === session.target.mode,
        ) ?? session.host);
    setView("workspace");
    setActive(session.id);
    revealHost(current);
  }
  function dropLayoutSessions(ids: string[]) {
    setLayouts((current) =>
      current.flatMap((root) => {
        let next: PaneLayout | null = root;
        for (const id of ids) if (next) next = removePane(next, id);
        return next ? [next] : [];
      }),
    );
  }
  function closeSession(id: string) {
    const siblings = layouts.find((root) => paneIds(root).includes(id));
    const next = siblings
      ? paneIds(siblings).find((pane) => pane !== id)
      : undefined;
    setSessions((current) => current.filter((session) => session.id !== id));
    dropLayoutSessions([id]);
    if (active === id) {
      if (maximizedPaneId === id) setMaximizedPaneId(null);
      const index = sessions.findIndex((session) => session.id === id);
      const survivor =
        sessions.find((session) => session.id === next) ??
        sessions[index + 1] ??
        sessions[index - 1];
      if (survivor) activateSession(survivor);
      else {
        setActive("home");
        setMonitorOpen(false);
      }
    }
  }
  function updateTerminalTitle(id: string, title: string | null) {
    const terminalTitle = title || undefined;
    setSessions((current) => {
      const session = current.find((item) => item.id === id);
      if (!session || session.terminalTitle === terminalTitle) return current;
      return current.map((item) =>
        item.id === id ? { ...item, terminalTitle } : item,
      );
    });
  }
  function systemSession(id = crypto.randomUUID()): Session {
    return {
      id,
      label: `本机 ${systemShell} · ${splitNumber.current++}`,
      host: {
        id,
        name: `本机 ${systemShell}`,
        address: "本机",
        port: 0,
        group: "本机终端",
        mode: "local",
        tags: [],
      },
      target: { mode: "shell", id },
    };
  }
  function toggleMaximizedPane(id: string) {
    setActive(id);
    if (
      !layouts.some(
        (root) => paneIds(root).includes(id) && paneIds(root).length > 1,
      )
    )
      return;
    setMaximizedPaneId(maximizedPaneId === id ? null : id);
  }
  async function toggleFullscreen() {
    if (!desktop) return;
    try {
      const window = getCurrentWindow();
      const next = !(await window.isFullscreen());
      await window.setFullscreen(next);
      setFullscreen(next);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function minimizeWindow() {
    if (!desktop) return;
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function toggleMaximizeWindow() {
    if (!desktop) return;
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  async function closeWindow() {
    if (!desktop) return;
    try {
      await getCurrentWindow().close();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  function newSystemShell() {
    const next = systemSession();
    setSessions((current) => [...current, next]);
    setLayouts((current) => [...current, { kind: "pane", id: next.id }]);
    activateSession(next);
  }
  function splitActive(axis: SplitAxis) {
    const original = sessions.find((session) => session.id === active);
    if (!original) {
      newSystemShell();
      return;
    }
    const group = layouts.find((root) => paneIds(root).includes(active));
    if (group && paneIds(group).length >= 8) {
      toast.info("每组最多支持 8 个窗格，可新建标签继续连接");
      return;
    }
    const id = crypto.randomUUID(),
      splitId = crypto.randomUUID();
    const next =
      original.target.mode === "shell"
        ? systemSession(id)
        : {
            ...original,
            id,
            label: `${original.host.name} · ${splitNumber.current++}`,
            terminalTitle: undefined,
            target: { ...original.target },
          };
    setSessions((current) => [...current, next]);
    setLayouts((current) => {
      if (current.some((root) => paneIds(root).includes(active)))
        return current.map((root) =>
          splitPane(root, active, id, axis, splitId),
        );
      return [
        ...current,
        splitPane({ kind: "pane", id: active }, active, id, axis, splitId),
      ];
    });
    activateSession(next);
    setMaximizedPaneId(null);
  }
  function mergeSession() {
    if (!attachPane) return;
    const incoming = sessions.find((session) => session.id === attachPane.id);
    const original = sessions.find((session) => session.id === active);
    if (!incoming || !original || incoming.id === original.id) return;
    const group = layouts.find((root) => paneIds(root).includes(active));
    if (group && paneIds(group).length >= 8) {
      toast.info("每组最多支持 8 个窗格");
      return;
    }
    const splitId = crypto.randomUUID();
    setLayouts((current) => {
      const detached = current.flatMap((root) => {
        const next = removePane(root, incoming.id);
        return next ? [next] : [];
      });
      if (detached.some((root) => paneIds(root).includes(active)))
        return detached.map((root) =>
          splitPane(root, active, incoming.id, attachPane.axis, splitId),
        );
      return [
        ...detached,
        splitPane(
          { kind: "pane", id: active },
          active,
          incoming.id,
          attachPane.axis,
          splitId,
        ),
      ];
    });
    setAttachPane(null);
    activateSession(incoming);
    setMaximizedPaneId(null);
  }
  function dockSession(sourceId: string, drop: PaneDrop) {
    const incoming = sessions.find((session) => session.id === sourceId);
    const target = sessions.find((session) => session.id === drop.targetId);
    if (!incoming || !target || incoming.id === target.id) return false;
    const targetGroup = layouts.find((root) =>
      paneIds(root).includes(target.id),
    );
    if (
      targetGroup &&
      !paneIds(targetGroup).includes(sourceId) &&
      paneIds(targetGroup).length >= 8
    ) {
      toast.info("每组最多支持 8 个窗格");
      return false;
    }
    const splitId = crypto.randomUUID();
    setLayouts((current) =>
      drop.edge === "center"
        ? swapPanes(current, sourceId, target.id)
        : movePane(current, sourceId, target.id, drop.edge, splitId),
    );
    activateSession(incoming);
    setMaximizedPaneId(null);
    return true;
  }
  const { drag, bind: bindPaneDrag } = usePaneDrag({
    activeId: active,
    onDrop: dockSession,
    onPreview: (id) => {
      if (sessions.some((session) => session.id === id)) {
        setActive(id);
        setView("workspace");
      }
    },
    onCancel: (id) =>
      setActive(
        id === "home" || sessions.some((session) => session.id === id)
          ? id
          : "home",
      ),
  });
  function separatePanes() {
    setMaximizedPaneId(null);
    const group = layouts.find((root) => paneIds(root).includes(active));
    if (!group) return;
    setLayouts((current) =>
      current.flatMap((root) =>
        root === group
          ? paneIds(root).map((id) => ({ kind: "pane" as const, id }))
          : [root],
      ),
    );
  }
  function openConnection(
    host: Host,
    purpose: "terminal" | "files",
    account?: string,
    path?: string,
  ) {
    const target: Target = {
      mode: host.mode,
      id: host.id,
      accountId: account === "default" ? undefined : account,
      accessPathId: path === "default" ? undefined : path,
      protocol:
        host.mode === "platform" &&
        /windows|win server|microsoft/i.test(host.osType ?? host.name)
          ? "rdp"
          : "ssh",
    };
    if (purpose === "files") setFileTarget({ target, name: host.name });
    else {
      const id = crypto.randomUUID();
      setSessions((current) => [...current, { id, host, target }]);
      setLayouts((current) => [...current, { kind: "pane", id }]);
      setActive(id);
      revealHost(host, false);
    }
    setView("workspace");
    setConnection(null);
  }
  const closeHostFiles = useCallback(() => {
    setFileTarget((current) => {
      if (current?.target.mode === "local") {
        void command("file_close", { target: current.target }).catch(
          () => undefined,
        );
      }
      return null;
    });
  }, []);
  async function connect(
    host: Host,
    purpose: "terminal" | "files" = "terminal",
  ) {
    if (!desktop) {
      toast.error("请在 Pixiu Shell 桌面应用中连接主机");
      return;
    }
    if (host.mode === "local") {
      openConnection(host, purpose);
      return;
    }
    const generation = ++connectId.current;
    setConnecting(true);
    try {
      const options = await platform<HostOptions>({
        type: "hostOptions",
        id: host.id,
      });
      if (generation !== connectId.current) return;
      const direct = directOptions(options);
      if (direct) {
        openConnection(host, purpose, direct.accountId, direct.accessPathId);
        return;
      }
      setAccountId("default");
      setPathId("default");
      setConnection({ host, options, purpose });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      if (generation === connectId.current) setConnecting(false);
    }
  }
  const hosts = mode === "local" ? localHosts.map(fromLocal) : platformHosts;
  const selected = hosts.find((host) => host.id === selectedId);
  const activeSession = sessions.find((session) => session.id === active);
  const hostProfileOpen =
    view === "workspace" && active === "home" && !!selected;
  const filesInHostProfile = !!(
    hostProfileOpen &&
    fileTarget &&
    selected &&
    fileTarget.target.id === selected.id &&
    fileTarget.target.mode === selected.mode
  );
  // 主机监控只在平台/图形会话里可用，shell 会话没有采集来源。
  const monitorPanelOpen =
    monitorOpen &&
    view === "workspace" &&
    !!activeSession &&
    activeSession.target.mode !== "shell";
  const activeLayout =
    layouts.find((root) => paneIds(root).includes(active)) ??
    (activeSession ? { kind: "pane" as const, id: active } : null);
  const geometry = activeLayout
    ? measurePanes(activeLayout)
    : { panes: new Map(), dividers: [] };
  const isSplit = geometry.panes.size > 1;
  // Maximization belongs to the split group, while the visible pane follows
  // its active tab. Other groups and the connection page remain accessible.
  const maximizedPaneId =
    isSplit &&
    maximizedLayoutPaneId &&
    geometry.panes.has(maximizedLayoutPaneId)
      ? active
      : null;
  const otherSessions = sessions.filter(
    (session) => !geometry.panes.has(session.id),
  );
  const normalizedKeyword = keyword.trim().toLowerCase();
  const filtered = hosts.filter((host) =>
    [
      host.name,
      host.address,
      ...(host.searchAddresses ?? []),
      host.group,
      ...(host.groupPaths ?? [host.group]),
      ...host.tags,
    ].some((value) => value.toLowerCase().includes(normalizedKeyword)),
  );
  const resourceFiltered = filtered.filter((host) => {
    if (!resourceGroupFilter) return true;
    return preferences.groupBy === "tag"
      ? host.tags.includes(resourceGroupFilter)
      : (host.groupPaths ?? [host.group]).some(
          (path) =>
            path === resourceGroupFilter ||
            path.startsWith(`${resourceGroupFilter}/`),
        );
  });
  const normalizedWorkspaceHostKeyword = workspaceHostKeyword
    .trim()
    .toLowerCase();
  const workspaceResourceFiltered = resourceFiltered.filter(
    (host) =>
      !normalizedWorkspaceHostKeyword ||
      [host.name, host.address, host.group, ...(host.groupPaths ?? [])].some(
        (value) => value.toLowerCase().includes(normalizedWorkspaceHostKeyword),
      ),
  );
  const resourcePageCount = Math.max(
    1,
    Math.ceil(workspaceResourceFiltered.length / workspaceHostPageSize),
  );
  const safeWorkspaceHostPage = Math.min(resourcePage, resourcePageCount);
  const pagedResources = workspaceResourceFiltered.slice(
    (safeWorkspaceHostPage - 1) * workspaceHostPageSize,
    safeWorkspaceHostPage * workspaceHostPageSize,
  );
  const workspaceHostPageNumbers = Array.from(
    { length: Math.min(resourcePageCount, 5) },
    (_, index) => {
      const first = Math.min(
        Math.max(1, safeWorkspaceHostPage - 2),
        Math.max(1, resourcePageCount - 4),
      );
      return first + index;
    },
  );
  function goToWorkspaceHostPage(page: number) {
    const next = Math.min(Math.max(1, page), resourcePageCount);
    setResourcePage(next);
    setWorkspaceHostPageJump(String(next));
  }
  const groups = new Map<string, Host[]>();
  if (
    mode === "local" &&
    preferences.groupBy === "group" &&
    !normalizedKeyword
  ) {
    for (const name of localGroups) groups.set(name, []);
  }
  for (const host of filtered) {
    for (const name of preferences.groupBy === "tag"
      ? host.tags.length
        ? host.tags
        : ["无标签"]
      : (host.groupPaths ?? [host.group])) {
      const group = groups.get(name);
      if (group) group.push(host);
      else groups.set(name, [host]);
    }
  }
  const dropTargetGroup = drag?.drop
    ? layouts.find((root) => paneIds(root).includes(drag.drop!.targetId))
    : undefined;
  const dropBlocked = !!(
    drag &&
    dropTargetGroup &&
    !paneIds(dropTargetGroup).includes(drag.sourceId) &&
    paneIds(dropTargetGroup).length >= 8
  );
  const projectedLayouts =
    drag?.drop && !dropBlocked
      ? drag.drop.edge === "center"
        ? swapPanes(layouts, drag.sourceId, drag.drop.targetId)
        : movePane(
            layouts,
            drag.sourceId,
            drag.drop.targetId,
            drag.drop.edge,
            "preview",
          )
      : [];
  const projectedRoot = drag
    ? projectedLayouts.find((root) => paneIds(root).includes(drag.sourceId))
    : undefined;
  const dropBounds =
    projectedRoot && drag
      ? measurePanes(projectedRoot).panes.get(drag.sourceId)
      : drag?.drop
        ? geometry.panes.get(drag.drop.targetId)
        : undefined;
  useLayoutEffect(() => {
    if (!revealRevision || preferences.sidebarHidden || loading) return;
    const tree = hostTree.current;
    const row = tree?.querySelector<HTMLElement>(
      ".host-group[open] .host-row.selected",
    );
    if (!tree || !row) return;
    const treeBounds = tree.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    // Scroll only the host tree; never move the toolbar or terminal viewport.
    if (rowBounds.top < treeBounds.top)
      tree.scrollTop += rowBounds.top - treeBounds.top;
    else if (rowBounds.bottom > treeBounds.bottom)
      tree.scrollTop += rowBounds.bottom - treeBounds.bottom;
  }, [
    revealRevision,
    expandedGroups,
    preferences.sidebarHidden,
    loading,
    localHosts,
    platformHosts,
  ]);
  useLayoutEffect(() => {
    const bar = sessionBarRef.current;
    if (!bar || view !== "workspace") return;
    const tab =
      active === "home"
        ? bar.querySelector<HTMLElement>(".session-tab.active")
        : [...bar.querySelectorAll<HTMLElement>("[data-session-tab-id]")].find(
            (item) => item.dataset.sessionTabId === active,
          );
    if (!tab) return;
    const barBounds = bar.getBoundingClientRect();
    const tabBounds = tab.getBoundingClientRect();
    const tabStart = bar.scrollLeft + tabBounds.left - barBounds.left;
    const tabEnd = tabStart + tabBounds.width;
    const usableWidth = bar.clientWidth - 6;
    if (tabStart < bar.scrollLeft) bar.scrollLeft = tabStart;
    else if (tabEnd > bar.scrollLeft + usableWidth)
      bar.scrollLeft = tabEnd - usableWidth;
  }, [active, sessions.length, view]);
  return (
    <>
      <div
        inert={lockStatus.locked}
        style={lockStatus.locked ? { visibility: "hidden" } : undefined}
        className={cn(
          "app-shell",
          desktop && /Mac/.test(navigator.platform) && "native-macos",
        )}
        data-sidebar-hidden={preferences.sidebarHidden || view !== "workspace"}
        data-view={view}
        data-pane-dragging={!!drag}
        data-fullscreen={fullscreen}
      >
        <header
          className="window-toolbar"
          data-tauri-drag-region={desktop ? "deep" : undefined}
        >
          <div className="window-leading">
            <div className="traffic-light-space" aria-hidden="true" />
            <strong>Pixiu Shell</strong>
          </div>
          <div className="window-drag-space" />
          <div className="window-actions">
            {view === "workspace" ? (
              <>
                {activeSession ? (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="左右分屏"
                      title="左右分屏（本机 Shell）"
                      onClick={() => splitActive("row")}
                    >
                      <Columns2 />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="上下分屏"
                      title="上下分屏（本机 Shell）"
                      onClick={() => splitActive("column")}
                    >
                      <Rows2 />
                    </Button>
                    {otherSessions.length ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="合并标签分屏"
                        title="将其他主机标签加入分屏"
                        onClick={() =>
                          setAttachPane({
                            id: otherSessions[0].id,
                            axis: "row",
                          })
                        }
                      >
                        <PanelsTopLeft />
                      </Button>
                    ) : null}
                    {isSplit ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="取消分屏"
                        title="恢复为独立标签，保留连接"
                        onClick={separatePanes}
                      >
                        <Maximize2 />
                      </Button>
                    ) : null}
                  </>
                ) : null}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="文件"
                  title="文件管理"
                  data-active={!!fileTarget}
                  disabled={
                    activeSession?.target.mode === "shell" ||
                    (!activeSession && !selected) ||
                    connecting
                  }
                  onClick={() => {
                    // 三个侧边面板可以同时打开，这里只切换自己。
                    if (activeSession) {
                      const target = activeSession.target;
                      setFileTarget((current) =>
                        current &&
                        current.target.mode === target.mode &&
                        current.target.id === target.id &&
                        current.target.accountId === target.accountId
                          ? null
                          : { target, name: activeSession.host.name },
                      );
                    } else if (selected) {
                      setHostProfileTab("files");
                      void connect(selected, "files");
                    }
                  }}
                >
                  <ObjectStorageFolderIcon />
                </Button>
                {activeSession?.target.mode !== "shell" ? (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="主机 AI"
                      title="主机 AI 助手"
                      data-active={aiOpen}
                      onClick={() => setAiOpen((value) => !value)}
                    >
                      <Sparkles className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="主机监控"
                      title="主机监控"
                      data-active={monitorOpen}
                      onClick={() => setMonitorOpen((value) => !value)}
                    >
                      <MonitorIcon className="size-3.5" />
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          {isWindowsPlatform ? (
            <div className="windows-controls" aria-label="窗口控制">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="最小化窗口"
                title="最小化"
                onClick={() => void minimizeWindow()}
              >
                <Minus />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="最大化或还原窗口"
                title="最大化 / 还原"
                onClick={() => void toggleMaximizeWindow()}
              >
                <Square />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="windows-close"
                aria-label="关闭窗口"
                title="关闭"
                onClick={() => void closeWindow()}
              >
                <X />
              </Button>
            </div>
          ) : null}
        </header>
        <nav className="activity-rail" aria-label="主导航">
          <div className="rail-brand">
            <TerminalSquare />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="主机管理"
            title={
              view !== "workspace"
                ? "返回终端"
                : preferences.sidebarHidden
                  ? "展开主机列表"
                  : "收起主机列表"
            }
            aria-expanded={view === "workspace" && !preferences.sidebarHidden}
            aria-controls="host-sidebar"
            data-active={view === "workspace"}
            onClick={() => {
              if (view !== "workspace") {
                setView("workspace");
                return;
              }
              void patchPreferences({
                sidebarHidden: !prefsRef.current.sidebarHidden,
              }).catch((error) => toast.error(errorMessage(error)));
            }}
          >
            <Server />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="批量命令"
            title="批量命令"
            data-active={batchOpen && view === "workspace"}
            onClick={() => {
              setView("workspace");
              setBatchOpen((value) => (view === "workspace" ? !value : true));
            }}
          >
            <ListChecks />
          </Button>
          {mode === "platform" && user ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="主机脚本"
              title="主机脚本"
              data-active={view === "scripts"}
              onClick={() => {
                setScriptsVisited(true);
                setView("scripts");
              }}
            >
              <FileCode2 />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="新建本机终端"
            title="新建本机终端"
            onClick={newSystemShell}
          >
            <TerminalSquare />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="配置中心"
            title="配置中心"
            data-active={view === "settings"}
            onClick={() => settings()}
          >
            <Settings2 />
          </Button>
          <div className="rail-spacer" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="锁定工作区"
            title="锁定工作区"
            onClick={() => void lockWorkspace()}
          >
            <LockKeyhole />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="切换黑白主题"
            onClick={() =>
              void patchPreferences({
                theme: resolvedTheme === "dark" ? "light" : "dark",
              }).catch((error) => toast.error(errorMessage(error)))
            }
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </nav>
        <aside
          className="sidebar"
          id="host-sidebar"
          hidden={preferences.sidebarHidden || view !== "workspace"}
        >
          <div className="sidebar-heading">
            <span className="sidebar-heading__title">
              {mode === "local" ? "主机" : "授权主机"}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="sidebar-heading__icon"
              aria-label="刷新主机"
              title="刷新主机"
              disabled={loading}
              onClick={() =>
                void (mode === "local" ? refreshLocal() : refreshPlatform())
              }
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
            <div className="sidebar-heading__actions">
              {mode === "local" ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="sidebar-heading__icon"
                  aria-label="添加主机"
                  title="添加主机"
                  onClick={() => settings("hosts", true)}
                >
                  <Plus />
                </Button>
              ) : user ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="sidebar-heading__icon"
                  aria-label="添加平台主机"
                  title="添加平台主机"
                  onClick={() => {
                    settings("resources");
                    setResourceCreateRequest((value) => value + 1);
                  }}
                >
                  <Plus />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-xs"
                className="sidebar-heading__icon"
                aria-label="切换分组方式"
                title={
                  preferences.groupBy === "group"
                    ? "当前按分组，切换为标签"
                    : "当前按标签，切换为分组"
                }
                onClick={() =>
                  void patchPreferences({
                    groupBy: preferences.groupBy === "group" ? "tag" : "group",
                  }).catch((error) => toast.error(errorMessage(error)))
                }
              >
                {preferences.groupBy === "group" ? <Folder /> : <Tag />}
              </Button>
            </div>
          </div>
          <div className="host-search">
            <SearchInput
              ref={search}
              aria-label="搜索主机"
              placeholder="搜索主机、IP、标签"
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value);
                setResourcePage(1);
              }}
            />
          </div>
          <div className="host-tree" ref={hostTree}>
            {loading || !ready ? (
              <div className="table-empty">
                <LoaderCircle className="animate-spin" />
                加载中
              </div>
            ) : groups.size ? (
              <HostTree
                groups={groups}
                prefix={`${mode}:${preferences.groupBy}:`}
                expanded={
                  keyword.trim()
                    ? new Set(
                        [...groups.keys()].flatMap((path) => {
                          const parts = path.split("/").filter(Boolean);
                          return parts.map(
                            (_, index) =>
                              `${mode}:${preferences.groupBy}:${parts
                                .slice(0, index + 1)
                                .join("/")}`,
                          );
                        }),
                      )
                    : expandedGroups
                }
                onExpand={(key) =>
                  setExpandedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                selected={selectedId}
                tags={preferences.groupBy === "tag"}
                onGroupSelect={(path) => {
                  setInlineEditingHostId(null);
                  setResourceGroupFilter(path);
                  setResourcePage(1);
                  setSelectedId(null);
                }}
                onSelect={openHostProfile}
                onConnect={(host) => void connect(host)}
                onRootContextMenu={(event) => {
                  if (mode !== "local" || preferences.groupBy !== "group")
                    return;
                  setHostTreeMenu({
                    kind: "root",
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onGroupContextMenu={(group, event) => {
                  if (mode !== "local" || preferences.groupBy !== "group")
                    return;
                  setHostTreeMenu({
                    kind: "group",
                    group,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onHostContextMenu={(host, event) => {
                  if (mode !== "local" || !host.local) return;
                  setHostTreeMenu({
                    kind: "host",
                    host: host.local,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onHostDrop={(host, group) => {
                  if (mode !== "local" || preferences.groupBy !== "group")
                    return;
                  void dropHostIntoGroup(host, group);
                }}
                onGroupDrop={(source, target) => {
                  if (mode !== "local" || preferences.groupBy !== "group")
                    return;
                  void dropGroupIntoGroup(source, target);
                }}
              />
            ) : (
              <div className="sidebar-empty">
                {keyword
                  ? "没有匹配的主机"
                  : mode === "platform" && !user
                    ? "登录后加载授权主机"
                    : "暂无主机"}
              </div>
            )}
          </div>
        </aside>
        {hostTreeMenu ? (
          <div
            className="host-tree-menu"
            role="menu"
            style={{ left: hostTreeMenu.x, top: hostTreeMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {hostTreeMenu.kind === "host" ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setHostTreeMenu(null);
                    openHostProfile(fromLocal(hostTreeMenu.host));
                  }}
                >
                  <Server />
                  详情
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void duplicateLocalHost(hostTreeMenu.host);
                  }}
                >
                  <Copy />
                  拷贝
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openMoveHost(hostTreeMenu.host)}
                >
                  <ArrowRightLeft />
                  移动至分组
                </button>
              </>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  openFolderCreate(
                    hostTreeMenu.kind === "group" ? hostTreeMenu.group : null,
                  )
                }
              >
                <FolderPlus />
                创建文件夹
              </button>
            )}
          </div>
        ) : null}
        <main className="workspace">
          {!desktop ? (
            <div className="preview-notice">
              浏览器预览 · 配色与布局可体验，SSH、SFTP
              和主机存储需在桌面应用中使用。
            </div>
          ) : null}
          {error ? (
            <div className="workspace-error">
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          <div className="settings-container" hidden={view !== "settings"}>
            <SettingsPage
              lockStatus={lockStatus}
              onLockStatus={setLockStatus}
              onLock={() => void lockWorkspace()}
              resourceCreateRequest={resourceCreateRequest}
              onResourceCreateHandled={() => setResourceCreateRequest(0)}
              platformEnabled={mode === "platform" && !!user}
              refreshPlatform={refreshPlatform}
              preferences={preferences}
              onSave={savePreferences}
              hosts={localHosts}
              refresh={refreshLocal}
              onConnect={(host) => {
                // 设置页点「登录」直接切回工作区开终端，避免用户再找一次主机。
                setView("workspace");
                void connect(fromLocal(host), "terminal");
              }}
              tab={settingsTab}
              onTab={setSettingsTab}
              createRequest={createRequest}
            />
          </div>
          <div className="scripts-workspace" hidden={view !== "scripts"}>
            {scriptsVisited && mode === "platform" && user ? (
              <Suspense
                fallback={<div className="table-empty">正在加载主机脚本…</div>}
              >
                <ScriptManager hosts={platformHosts} />
              </Suspense>
            ) : null}
          </div>
          <div className="terminal-workspace" hidden={view !== "workspace"}>
            <div
              className={cn(
                "session-layout",
                !(sessions.length || selected) && "session-layout--no-tabs",
              )}
            >
              {sessions.length || selected ? (
                <div className="session-tabrow">
                  <div className="session-bar" ref={sessionBarRef}>
                    {selected ? (
                      <div
                        className={cn(
                          "session-tab",
                          active === "home" && "active",
                        )}
                        data-tauri-drag-region="false"
                      >
                        <button
                          className="session-tab-label"
                          title="主机详情"
                          onClick={() => openHostProfile(selected)}
                        >
                          <Server />
                          <span>详情</span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="关闭主机详情"
                          onClick={closeHostProfile}
                        >
                          <X />
                        </Button>
                      </div>
                    ) : null}
                    {sessions.map((session) => (
                      <div
                        key={session.id}
                        className={cn(
                          "session-tab",
                          active === session.id && "active",
                        )}
                        data-session-tab-id={session.id}
                        data-tauri-drag-region="false"
                        data-drag-source={drag?.sourceId === session.id}
                      >
                        <button
                          className="session-tab-drag"
                          title="拖到终端左、右、上、下边缘分屏；悬停其他标签可切换目标"
                          {...bindPaneDrag(session.id)}
                          onClick={() => activateSession(session)}
                          onDoubleClick={() => toggleMaximizedPane(session.id)}
                        >
                          <TerminalSquare />
                          <span>{sessionTitle(session)}</span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`关闭 ${sessionTitle(session)}`}
                          onClick={() => closeSession(session.id)}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div
                    className="session-tabrow-space"
                    data-tauri-drag-region
                  />
                </div>
              ) : null}
              <div className="session-content" ref={paneContainer}>
                <section className="connection-page" hidden={active !== "home"}>
                  {!selected && mode === "platform" ? (
                    <div className="page-title">
                      <div>
                        <h1>连接管理</h1>
                        <p>使用运维平台的身份、资源权限和审计策略。</p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() =>
                          user ? void refreshPlatform() : login()
                        }
                      >
                        {user ? "同步主机" : "连接运维平台"}
                        <ArrowUpRight data-icon="inline-end" />
                      </Button>
                    </div>
                  ) : null}
                  {!selected && mode === "local" ? (
                    <div className="workspace-host-tools">
                      {workspaceHostNotice ? (
                        <div className="host-notice">
                          <svg
                            className="host-notice__icon"
                            viewBox="0 0 1024 1024"
                            aria-hidden="true"
                          >
                            <path
                              fill="currentColor"
                              d="M512 64a448 448 0 1 1 0 896.064A448 448 0 0 1 512 64m67.2 275.072c33.28 0 60.288-23.104 60.288-57.344s-27.072-57.344-60.288-57.344c-33.28 0-60.16 23.104-60.16 57.344s26.88 57.344 60.16 57.344M590.912 699.2c0-6.848 2.368-24.64 1.024-34.752l-52.608 60.544c-10.88 11.456-24.512 19.392-30.912 17.28a12.99 12.99 0 0 1-8.256-14.72l87.68-276.992c7.168-35.136-12.544-67.2-54.336-71.296-44.096 0-108.992 44.736-148.48 101.504 0 6.784-1.28 23.68.064 33.792l52.544-60.608c10.88-11.328 23.552-19.328 29.952-17.152a12.8 12.8 0 0 1 7.808 16.128L388.48 728.576c-10.048 32.256 8.96 63.872 55.04 71.04 67.84 0 107.904-43.648 147.456-100.416z"
                            />
                          </svg>
                          <span>
                            管理主机，支持新增、编辑、删除、批量导入节点。节点可用于远程
                            SSH 连接。
                          </span>
                          <button
                            type="button"
                            className="host-notice__close"
                            aria-label="关闭提示"
                            onClick={() => setWorkspaceHostNotice(false)}
                          >
                            <X />
                          </button>
                        </div>
                      ) : null}
                      <div className="host-toolbar">
                        <Button
                          className="host-primary-action"
                          variant="outline"
                          size="sm"
                          onClick={() => setHostCreateOpen(true)}
                        >
                          新增主机
                        </Button>
                        <div className="host-toolbar__right">
                          <div className="host-toolbar__links">
                            <button
                              type="button"
                              className="host-link"
                              onClick={() => setWorkspaceBatchImportOpen(true)}
                            >
                              批量导入
                            </button>
                          </div>
                          <div className="host-toolbar__fields">
                            <label className="host-filter">
                              <Search />
                              <SearchInput
                                value={workspaceHostKeyword}
                                onChange={(event) => {
                                  setWorkspaceHostKeyword(event.target.value);
                                  setResourcePage(1);
                                  setWorkspaceHostPageJump("1");
                                }}
                                placeholder="请输入主机名称、IP 或分组"
                                aria-label="搜索主机"
                              />
                            </label>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label="刷新主机列表"
                              disabled={loading}
                              onClick={() => void refreshLocal()}
                            >
                              <RefreshCw
                                className={loading ? "animate-spin" : undefined}
                              />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {selected ? (
                    <>
                      <HostProfile
                        host={selected}
                        editing={inlineEditingHostId === selected.id}
                        connecting={connecting}
                        onEdit={() => setInlineEditingHostId(selected.id)}
                        onCancelEdit={() => setInlineEditingHostId(null)}
                        onSaved={() => {
                          setInlineEditingHostId(null);
                          void refreshLocal();
                        }}
                        onConnect={() => void connect(selected)}
                        tab={hostProfileTab}
                        fileSession={filesInHostProfile ? fileTarget : null}
                        onTabChange={setHostProfileTab}
                        onOpenFiles={() => void connect(selected, "files")}
                        onCloseFiles={closeHostFiles}
                        extra={
                          selected.mode === "platform" && user ? (
                            <HostDetails
                              key={`${selected.mode}:${selected.id}`}
                              host={selected}
                            />
                          ) : null
                        }
                      />
                    </>
                  ) : (
                    <>
                      <div className="workspace-stats">
                        <div>
                          <Server />
                          <span>
                            可用主机<strong>{hosts.length}</strong>
                          </span>
                        </div>
                        <div>
                          <ObjectStorageFolderIcon className="storage-folder-icon" />
                          <span>
                            主机分组<strong>{groups.size}</strong>
                          </span>
                        </div>
                        <div>
                          <TerminalSquare />
                          <span>
                            打开会话<strong>{sessions.length}</strong>
                          </span>
                        </div>
                      </div>
                      <div className="section-heading">
                        <h2>{mode === "local" ? "主机列表" : "授权资源"}</h2>
                        <span>SSH / SFTP</span>
                      </div>
                      <div className="data-table-wrap">
                        <table className="data-table workspace-host-table">
                          <thead>
                            <tr>
                              <th className="workspace-host-table__check">
                                <input
                                  type="checkbox"
                                  aria-label="全选主机"
                                  checked={
                                    workspaceResourceFiltered.length > 0 &&
                                    workspaceResourceFiltered.every((host) =>
                                      workspaceSelectedHosts.includes(host.id),
                                    )
                                  }
                                  onChange={(event) =>
                                    setWorkspaceSelectedHosts(
                                      event.target.checked
                                        ? workspaceResourceFiltered.map(
                                            (host) => host.id,
                                          )
                                        : [],
                                    )
                                  }
                                />
                              </th>
                              <th>主机名称</th>
                              <th>IP</th>
                              <th className="workspace-host-table__port">
                                端口
                              </th>
                              <th>认证类型</th>
                              <th>分组</th>
                              <th className="workspace-host-table__actions-head">
                                操作
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedResources.map((host) => (
                              <tr
                                key={host.id}
                                data-selected={workspaceSelectedHosts.includes(
                                  host.id,
                                )}
                                onDoubleClick={() => void connect(host)}
                              >
                                <td className="workspace-host-table__check">
                                  <input
                                    type="checkbox"
                                    aria-label={`选择 ${host.name}`}
                                    checked={workspaceSelectedHosts.includes(
                                      host.id,
                                    )}
                                    onChange={(event) =>
                                      setWorkspaceSelectedHosts((current) =>
                                        event.target.checked
                                          ? [...current, host.id]
                                          : current.filter(
                                              (id) => id !== host.id,
                                            ),
                                      )
                                    }
                                  />
                                </td>
                                <td className="workspace-host-table__name">
                                  {host.local ? (
                                    <button
                                      type="button"
                                      className="workspace-host-table__name-link"
                                      onClick={() =>
                                        setWorkspaceEditingHost(host.local!)
                                      }
                                    >
                                      {host.name}
                                    </button>
                                  ) : (
                                    host.name
                                  )}
                                </td>
                                <td className="mono">{host.address}</td>
                                <td className="workspace-host-table__port mono">
                                  {host.port}
                                </td>
                                <td>
                                  {host.local
                                    ? host.local.identityFile
                                      ? "私钥"
                                      : host.local.hasPassword
                                        ? "密码"
                                        : "交互"
                                    : "平台凭据"}
                                </td>
                                <td className="workspace-host-table__group">
                                  <GroupPath path={host.group} />
                                </td>
                                <td>
                                  {host.local ? (
                                    <div className="workspace-host-table__actions">
                                      <button
                                        type="button"
                                        className="host-link"
                                        disabled={
                                          workspaceCheckingHost === host.id
                                        }
                                        onClick={() =>
                                          void testWorkspaceHost(host.local!)
                                        }
                                      >
                                        {workspaceCheckingHost === host.id
                                          ? "检测中…"
                                          : "检测连通性"}
                                      </button>
                                      <button
                                        type="button"
                                        className="host-link"
                                        disabled={connecting}
                                        onClick={() => void connect(host)}
                                      >
                                        登录
                                      </button>
                                      <button
                                        type="button"
                                        className="host-link"
                                        onClick={() =>
                                          setWorkspaceEditingHost(host.local!)
                                        }
                                      >
                                        编辑
                                      </button>
                                      <div className="workspace-host-more">
                                        <button
                                          type="button"
                                          className="host-link workspace-host-more__trigger"
                                          aria-haspopup="menu"
                                          aria-expanded={
                                            workspaceMoreOpen === host.id
                                          }
                                          onClick={() =>
                                            setWorkspaceMoreOpen((current) =>
                                              current === host.id
                                                ? null
                                                : host.id,
                                            )
                                          }
                                        >
                                          更多
                                          <ChevronDown />
                                        </button>
                                        {workspaceMoreOpen === host.id ? (
                                          <div
                                            className="workspace-host-more__menu"
                                            role="menu"
                                          >
                                            <button
                                              type="button"
                                              role="menuitem"
                                              onClick={() =>
                                                setWorkspaceDeleteHost(
                                                  host.local!,
                                                )
                                              }
                                            >
                                              删除
                                            </button>
                                          </div>
                                        ) : null}
                                      </div>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      className="host-link"
                                      disabled={connecting}
                                      onClick={() => void connect(host)}
                                    >
                                      登录
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!workspaceResourceFiltered.length ? (
                          <div className="connection-empty">
                            <TerminalSquare />
                            <h3>
                              {mode === "platform" && !user
                                ? "连接你的运维平台"
                                : "准备好第一台主机"}
                            </h3>
                            <p>
                              {mode === "local"
                                ? "保存连接配置后，从这里打开终端或管理文件。无需登录。"
                                : user
                                  ? "当前账号没有可连接的资源，请联系平台管理员授权。"
                                  : "账号密码或钉钉弹窗登录后，自动加载授权资源。"}
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                mode === "local"
                                  ? settings("hosts", true)
                                  : login()
                              }
                            >
                              {mode === "local" ? "添加主机" : "登录平台"}
                            </Button>
                          </div>
                        ) : null}
                        {workspaceResourceFiltered.length ? (
                          <div
                            className="host-pagination workspace-host-pagination"
                            role="navigation"
                            aria-label="主机列表分页"
                          >
                            <span className="host-pagination__total">
                              共 {workspaceResourceFiltered.length} 条
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              aria-label="上一页"
                              disabled={safeWorkspaceHostPage <= 1}
                              onClick={() =>
                                goToWorkspaceHostPage(safeWorkspaceHostPage - 1)
                              }
                            >
                              <ChevronLeft />
                            </Button>
                            <div className="host-pagination__pages">
                              {workspaceHostPageNumbers.map((page) => (
                                <button
                                  type="button"
                                  key={page}
                                  className="host-pagination__page"
                                  data-active={page === safeWorkspaceHostPage}
                                  aria-current={
                                    page === safeWorkspaceHostPage
                                      ? "page"
                                      : undefined
                                  }
                                  onClick={() => goToWorkspaceHostPage(page)}
                                >
                                  {page}
                                </button>
                              ))}
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              aria-label="下一页"
                              disabled={
                                safeWorkspaceHostPage >= resourcePageCount
                              }
                              onClick={() =>
                                goToWorkspaceHostPage(safeWorkspaceHostPage + 1)
                              }
                            >
                              <ChevronRight />
                            </Button>
                            <Select
                              value={String(workspaceHostPageSize)}
                              onValueChange={(value) => {
                                setWorkspaceHostPageSize(Number(value));
                                goToWorkspaceHostPage(1);
                              }}
                            >
                              <SelectTrigger
                                className="host-pagination__size"
                                aria-label="每页条数"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="host-pagination__size-content">
                                {[10, 20, 30, 50, 100].map((size) => (
                                  <SelectItem key={size} value={String(size)}>
                                    {size}条/页
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <label className="host-pagination__jump">
                              前往
                              <SearchInput
                                inputMode="numeric"
                                aria-label="跳转页码"
                                value={workspaceHostPageJump}
                                onChange={(event) =>
                                  setWorkspaceHostPageJump(
                                    event.target.value.replace(/[^0-9]/g, ""),
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    goToWorkspaceHostPage(
                                      Number(workspaceHostPageJump) || 1,
                                    );
                                  }
                                }}
                                onBlur={() =>
                                  goToWorkspaceHostPage(
                                    Number(workspaceHostPageJump) || 1,
                                  )
                                }
                              />
                              页
                            </label>
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}
                </section>
                {sessions.map((session) => (
                  <section
                    key={session.id}
                    className="session-view"
                    hidden={
                      maximizedPaneId
                        ? session.id !== maximizedPaneId
                        : !geometry.panes.has(session.id)
                    }
                    style={
                      maximizedPaneId === session.id
                        ? { inset: 0 }
                        : geometry.panes.has(session.id)
                          ? {
                              ...paneStyle(geometry.panes.get(session.id)!),
                              right: "auto",
                              bottom: "auto",
                            }
                          : undefined
                    }
                    data-pane-id={session.id}
                    data-pane-maximized={maximizedPaneId === session.id}
                    data-pane-active={active === session.id}
                    data-split={isSplit && !maximizedPaneId}
                    onPointerDownCapture={(event) => {
                      if (
                        isSplit &&
                        event.altKey &&
                        (event.target as HTMLElement).closest(
                          ".terminal-surface",
                        )
                      ) {
                        bindPaneDrag<HTMLElement>(session.id).onPointerDown?.(
                          event,
                        );
                        event.preventDefault();
                        return;
                      }
                      if (
                        active !== session.id &&
                        !(event.target as HTMLElement).closest("button")
                      )
                        activateSession(session);
                    }}
                    onPointerMove={
                      bindPaneDrag<HTMLElement>(session.id).onPointerMove
                    }
                    onPointerUp={
                      bindPaneDrag<HTMLElement>(session.id).onPointerUp
                    }
                    onPointerCancel={
                      bindPaneDrag<HTMLElement>(session.id).onPointerCancel
                    }
                    onLostPointerCapture={
                      bindPaneDrag<HTMLElement>(session.id).onLostPointerCapture
                    }
                    onClickCapture={
                      bindPaneDrag<HTMLElement>(session.id).onClickCapture
                    }
                    onFocusCapture={(event) => {
                      if (
                        active !== session.id &&
                        (event.target as HTMLElement).closest(
                          ".terminal-surface",
                        )
                      )
                        activateSession(session);
                    }}
                  >
                    <Suspense
                      fallback={
                        <div className="table-empty">正在加载终端…</div>
                      }
                    >
                      <TerminalPane
                        ref={(handle) => {
                          if (handle)
                            terminalHandles.current.set(session.id, handle);
                          else terminalHandles.current.delete(session.id);
                        }}
                        dragHandleProps={{
                          ...bindPaneDrag(session.id),
                          onClick: () => activateSession(session),
                          onDoubleClick: () => toggleMaximizedPane(session.id),
                        }}
                        title={isSplit ? paneTitle(session) : undefined}
                        baseTitle={session.label || session.host.name}
                        terminalTitle={session.terminalTitle}
                        onTitleUpdate={(title) =>
                          updateTerminalTitle(session.id, title)
                        }
                        onClose={
                          isSplit ? () => closeSession(session.id) : undefined
                        }
                        address={session.host.address}
                        target={session.target}
                        active={active === session.id && view === "workspace"}
                        preferences={{
                          ...preferences,
                          fontSize: session.fontSize ?? preferences.fontSize,
                        }}
                      />
                    </Suspense>
                  </section>
                ))}
                {!maximizedPaneId &&
                  geometry.dividers.map((divider) => (
                    <ResizeHandle
                      key={divider.id}
                      axis={divider.axis}
                      label={
                        divider.axis === "row" ? "调整分屏宽度" : "调整分屏高度"
                      }
                      value={divider.ratio}
                      min={0.15}
                      max={0.85}
                      style={
                        divider.axis === "row"
                          ? {
                              left: `calc(${(divider.rect.x + divider.rect.width * divider.ratio) * 100}% - 3px)`,
                              top: `${divider.rect.y * 100}%`,
                              height: `${divider.rect.height * 100}%`,
                              width: 6,
                            }
                          : {
                              top: `calc(${(divider.rect.y + divider.rect.height * divider.ratio) * 100}% - 3px)`,
                              left: `${divider.rect.x * 100}%`,
                              width: `${divider.rect.width * 100}%`,
                              height: 6,
                            }
                      }
                      coordinate={(x, y) => {
                        const bounds =
                          paneContainer.current?.getBoundingClientRect();
                        if (!bounds) return divider.ratio;
                        return divider.axis === "row"
                          ? ((x - bounds.left) / bounds.width -
                              divider.rect.x) /
                              divider.rect.width
                          : ((y - bounds.top) / bounds.height -
                              divider.rect.y) /
                              divider.rect.height;
                      }}
                      onChange={(ratio) =>
                        setLayouts((current) =>
                          current.map((root) =>
                            resizePane(root, divider.id, ratio),
                          ),
                        )
                      }
                    />
                  ))}
                {drag?.drop && dropBounds ? (
                  <div
                    className={cn(
                      "pane-drop-preview",
                      dropBlocked && "drop-blocked",
                    )}
                    style={{
                      ...paneStyle(dropBounds),
                      right: "auto",
                      bottom: "auto",
                    }}
                    data-drop-edge={drag.drop.edge}
                    aria-hidden="true"
                  >
                    <span>
                      {dropBlocked
                        ? "每组最多 8 个窗格"
                        : {
                            left: "放到左侧",
                            right: "放到右侧",
                            top: "放到上方",
                            bottom: "放到下方",
                            center: "交换窗格位置",
                          }[drag.drop.edge]}
                    </span>
                  </div>
                ) : null}
              </div>
              <PanelDock
                width={preferences.aiPanelWidth ?? 400}
                onWidthChange={(aiPanelWidth) =>
                  void patchPreferences({ aiPanelWidth }).catch((error) =>
                    toast.error(errorMessage(error)),
                  )
                }
                hidden={
                  !aiOpen &&
                  !monitorPanelOpen &&
                  !(fileTarget && !hostProfileOpen)
                }
              >
                <div className="ai-panels" hidden={!aiOpen}>
                  <Suspense
                    fallback={
                      <div className="table-empty">正在加载主机 AI…</div>
                    }
                  >
                    <AiAssistant
                      key={`chat:${user?.username ?? ""}`}
                      visible={
                        aiOpen &&
                        mode === "platform" &&
                        !!user &&
                        !activeSession &&
                        view === "workspace"
                      }
                      getTerminal={() => undefined}
                      onClose={() => setAiOpen(false)}
                    />
                    {sessions
                      .filter((session) => session.target.mode !== "shell")
                      .map((session) => (
                        <AiAssistant
                          key={session.id}
                          host={session.host}
                          target={session.target}
                          visible={
                            aiOpen &&
                            active === session.id &&
                            view === "workspace"
                          }
                          getTerminal={() =>
                            terminalHandles.current.get(session.id)
                          }
                          onClose={() => setAiOpen(false)}
                        />
                      ))}
                  </Suspense>
                </div>
                <div className="ai-panels" hidden={!monitorPanelOpen}>
                  {activeSession && activeSession.target.mode !== "shell" ? (
                    <HostMonitor
                      key={activeSession.id}
                      host={activeSession.host}
                      visible={monitorPanelOpen}
                      onClose={() => setMonitorOpen(false)}
                    />
                  ) : null}
                </div>
                {fileTarget && !hostProfileOpen ? (
                  <FileManager
                    key={`${fileTarget.target.mode}:${fileTarget.target.id}:${fileTarget.target.accountId}:${fileTarget.target.accessPathId}`}
                    target={fileTarget.target}
                    name={fileTarget.name}
                    onClose={() => setFileTarget(null)}
                  />
                ) : null}
              </PanelDock>
            </div>
          </div>
          <div hidden={view !== "workspace"} className="batch-command-dock">
            {batchOpen ? (
              <BatchCommand
                windows={sessions.map((session) => ({
                  id: session.id,
                  name: sessionTitle(session),
                }))}
                onClose={() => setBatchOpen(false)}
                onExecute={async (id, text) => {
                  const terminal = terminalHandles.current.get(id);
                  if (!terminal) throw new Error("终端尚未就绪");
                  await terminal.execute(text);
                }}
              />
            ) : null}
          </div>
          <footer className="status-bar">
            <span>
              {sessions.length} 个会话<span>UTF-8</span>
              <span title="终端类型">
                {activeSession?.target.mode === "shell" ? "本机" : "SSH2"} ·
                xterm-256color
              </span>
              <button onClick={() => settings("appearance")}>
                {preferences.terminalTheme === "pixiu-shell"
                  ? "Pixiu Shell"
                  : preferences.terminalTheme}{" "}
                · {activeSession?.fontSize ?? preferences.fontSize}px
              </button>
            </span>
          </footer>
        </main>
        <Dialog
          open={!!attachPane}
          onOpenChange={(open) => {
            if (!open) setAttachPane(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>将已有标签加入分屏</DialogTitle>
              <DialogDescription>
                保留原来的 SSH 连接，可以同时查看不同主机。
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>选择标签</FieldLabel>
                <Choice
                  label="选择分屏标签"
                  value={attachPane?.id ?? ""}
                  onChange={(id) =>
                    setAttachPane((current) =>
                      current ? { ...current, id } : null,
                    )
                  }
                  options={otherSessions.map((session) => ({
                    value: session.id,
                    label: sessionTitle(session),
                  }))}
                />
              </Field>
              <Field>
                <FieldLabel>分屏方向</FieldLabel>
                <Choice
                  label="分屏方向"
                  value={attachPane?.axis ?? "row"}
                  onChange={(axis) =>
                    setAttachPane((current) =>
                      current ? { ...current, axis: axis as SplitAxis } : null,
                    )
                  }
                  options={[
                    { value: "row", label: "左右并排" },
                    { value: "column", label: "上下排列" },
                  ]}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button onClick={mergeSession}>加入分屏</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {loginOpen && mode === "platform" ? (
          <PlatformLogin
            initialAddress={preferences.platformAddress}
            onClose={() => setLoginOpen(false)}
            onLogin={(user) => {
              setUser(user);
              setLoginOpen(false);
              toast.success("已登录运维平台");
            }}
          />
        ) : null}
        <Dialog
          open={!!connection}
          onOpenChange={(open) => {
            if (!open) setConnection(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>连接 {connection?.host.name}</DialogTitle>
              <DialogDescription>
                此主机有多个连接选项，请选择账号和访问通道。
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>连接账号</FieldLabel>
                <Choice
                  label="连接账号"
                  value={accountId}
                  onChange={setAccountId}
                  options={[
                    { value: "default", label: "平台默认账号" },
                    ...(connection?.options.accounts
                      .filter((option) => option.status === 1)
                      .map((option) => ({
                        value: option.id,
                        label: `${option.name} · ${option.username}`,
                      })) ?? []),
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel>连接通道</FieldLabel>
                <Choice
                  label="连接通道"
                  value={pathId}
                  onChange={setPathId}
                  options={[
                    { value: "default", label: "平台默认通道" },
                    ...(connection?.options.paths
                      .filter((option) => option.status === 1)
                      .map((option) => ({
                        value: option.id,
                        label: option.name,
                      })) ?? []),
                  ]}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                onClick={() => {
                  if (connection)
                    openConnection(
                      connection.host,
                      connection.purpose,
                      accountId,
                      pathId,
                    );
                }}
              >
                建立连接
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {drag ? (
          <div
            className="pane-drag-ghost"
            style={{
              left: Math.min(drag.x + 14, window.innerWidth - 220),
              top: Math.min(drag.y + 18, window.innerHeight - 66),
            }}
            role="status"
          >
            <strong>
              {sessions.find((session) => session.id === drag.sourceId)
                ?.label ||
                sessions.find((session) => session.id === drag.sourceId)?.host
                  .name ||
                "SSH 会话"}
            </strong>
            <span>
              {drag.drop
                ? "松开即可分屏 · Esc 取消"
                : "拖到边缘重排 · 分屏中心交换位置"}
            </span>
          </div>
        ) : null}
        {hostSearchOpen ? (
          <HostSearch
            hosts={mode === "local" ? localHosts.map(fromLocal) : platformHosts}
            sessions={sessions.map((session) => ({
              id: session.id,
              name: sessionTitle(session),
              host: session.host,
            }))}
            onClose={() => {
              setHostSearchOpen(false);
              requestAnimationFrame(() =>
                terminalHandles.current.get(active)?.focus(),
              );
            }}
            onHost={(host) => void connect(host)}
            onSession={(id) => {
              const session = sessions.find((session) => session.id === id);
              if (session) {
                activateSession(session);
                requestAnimationFrame(() =>
                  terminalHandles.current.get(id)?.focus(),
                );
              }
            }}
          />
        ) : null}
        <Toaster theme={resolvedTheme} position="top-center" />
      </div>
      <Dialog
        open={folderCreateParent !== undefined}
        onOpenChange={(open) => {
          if (!open && !folderSaving) setFolderCreateParent(undefined);
        }}
      >
        <DialogContent
          className="host-folder-dialog"
          showCloseButton={!folderSaving}
        >
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
            <DialogDescription>
              {folderCreateParent
                ? `将在“${folderCreateParent}”下创建子文件夹。`
                : "创建后的文件夹可用于整理本地主机。"}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="host-folder-name">文件夹名称</FieldLabel>
            <Input
              id="host-folder-name"
              autoFocus
              maxLength={120}
              placeholder="请输入文件夹名称"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveFolder();
              }}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={folderSaving}
              onClick={() => setFolderCreateParent(undefined)}
            >
              取消
            </Button>
            <Button disabled={folderSaving} onClick={() => void saveFolder()}>
              {folderSaving ? "创建中..." : "创建文件夹"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!movingHost}
        onOpenChange={(open) => {
          if (!open && !movingHostSaving) setMovingHost(null);
        }}
      >
        <DialogContent
          className="host-move-dialog"
          showCloseButton={!movingHostSaving}
        >
          <DialogHeader>
            <DialogTitle>移动主机</DialogTitle>
            <DialogDescription>
              将“{movingHost?.name}”移动到指定的分组。
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>目标分组</FieldLabel>
            <Select value={moveTarget} onValueChange={setMoveTarget}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择分组" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned__">未分组</SelectItem>
                {localGroups.map((group) => (
                  <SelectItem key={group} value={group}>
                    {group}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={movingHostSaving}
              onClick={() => setMovingHost(null)}
            >
              取消
            </Button>
            <Button
              disabled={movingHostSaving}
              onClick={() => void moveHostToGroup()}
            >
              {movingHostSaving ? "移动中..." : "确认移动"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {hostCreateOpen ? (
        <HostEditor
          onClose={() => setHostCreateOpen(false)}
          onSaved={() => {
            setHostCreateOpen(false);
            void refreshLocal();
          }}
        />
      ) : null}
      {workspaceEditingHost ? (
        <HostEditor
          key={workspaceEditingHost.id}
          host={workspaceEditingHost}
          onClose={() => setWorkspaceEditingHost(null)}
          onSaved={() => {
            setWorkspaceEditingHost(null);
            void refreshLocal();
          }}
        />
      ) : null}
      <Dialog
        open={!!workspaceDeleteHost}
        onOpenChange={(open) => {
          if (!open) setWorkspaceDeleteHost(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除主机“{workspaceDeleteHost?.name}”？</DialogTitle>
            <DialogDescription>
              本地主机配置及保存的凭据将被删除。已打开的会话不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setWorkspaceDeleteHost(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void deleteWorkspaceHost()}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BatchImportDialog
        open={workspaceBatchImportOpen}
        onOpenChange={setWorkspaceBatchImportOpen}
        onImported={async () => {
          await refreshLocal();
          setResourcePage(1);
        }}
      />
      <HostKeyPrompt />
      {lockStatus.locked ? (
        <ScreenLock onUnlocked={() => void unlockWorkspace()} />
      ) : null}
    </>
  );
}
