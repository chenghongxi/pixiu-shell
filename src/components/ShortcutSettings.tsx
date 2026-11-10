import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Choice } from "./Choice";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Alert, AlertDescription } from "./ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  shortcutActions,
  effectiveShortcuts,
  captureShortcut,
  shortcutConflict,
  shortcutLabel,
} from "@/lib/shortcuts";
import type { UserShortcut } from "@/lib/api";

const shortcutKinds = [
  { value: "send", label: "发送字符串" },
  { value: "sendEnter", label: "发送并回车" },
];

function blankShortcut(): UserShortcut {
  return { id: crypto.randomUUID(), name: "", binding: "", kind: "send", text: "" };
}
function UserShortcutEmpty() {
  return (
    <div className="shortcut-page__empty">
      <svg viewBox="0 0 79 86" aria-hidden="true">
        <defs>
          <linearGradient id="shortcut-empty-g1" x1="38.8503086%" y1="0%" x2="61.1496914%" y2="100%">
            <stop offset="0%" stopColor="var(--empty-fill-1)" />
            <stop offset="100%" stopColor="var(--empty-fill-4)" />
          </linearGradient>
          <linearGradient id="shortcut-empty-g2" x1="0%" y1="9.5%" x2="100%" y2="90.5%">
            <stop offset="0%" stopColor="var(--empty-fill-1)" />
            <stop offset="100%" stopColor="var(--empty-fill-6)" />
          </linearGradient>
          <rect id="shortcut-empty-path" x="0" y="0" width="17" height="36" />
        </defs>
        <g fill="none" fillRule="evenodd" stroke="none" strokeWidth="1">
          <g transform="translate(0, 0)">
            <path d="M39.5,86 C61.3152476,86 79,83.9106622 79,81.3333333 C79,78.7560045 57.3152476,78 35.5,78 C13.6847524,78 0,78.7560045 0,81.3333333 C0,83.9106622 17.6847524,86 39.5,86 Z" fill="var(--empty-fill-3)" />
            <polygon fill="var(--empty-fill-7)" transform="translate(27.500000, 51.500000) scale(1, -1) translate(-27.500000, -51.500000)" points="13 58 53 58 42 45 2 45" />
            <g transform="translate(34.500000, 31.500000) scale(-1, 1) rotate(-25.000000) translate(-34.500000, -31.500000) translate(7.000000, 10.000000)">
              <polygon fill="var(--empty-fill-7)" transform="translate(11.500000, 5.000000) scale(1, -1) translate(-11.500000, -5.000000)" points="0 3 18 3 23 7 5 7" />
              <polygon fill="var(--empty-fill-5)" points="0 7 38 7 38 43 0 43" />
              <rect fill="url(#shortcut-empty-g1)" transform="translate(46.500000, 25.000000) scale(-1, 1) translate(-46.500000, -25.000000)" x="38" y="7" width="17" height="36" />
              <polygon fill="var(--empty-fill-2)" transform="translate(39.500000, 3.500000) scale(-1, 1) translate(-39.500000, -3.500000)" points="24 7 41 7 55 0 38 0" />
            </g>
            <rect fill="url(#shortcut-empty-g2)" x="13" y="45" width="40" height="36" />
            <g transform="translate(53.000000, 45.000000)">
              <use fill="var(--empty-fill-8)" transform="translate(8.500000, 18.000000) scale(-1, 1) translate(-8.500000, -18.000000)" href="#shortcut-empty-path" />
              <polygon fill="var(--empty-fill-9)" transform="translate(12.000000, 9.000000) scale(-1, 1) translate(-12.000000, -9.000000)" points="7 0 24 0 20 18 7 16.5" />
            </g>
            <polygon fill="var(--empty-fill-2)" transform="translate(66.000000, 51.500000) scale(-1, 1) translate(-66.000000, -51.500000)" points="62 45 79 45 70 58 53 58" />
          </g>
        </g>
      </svg>
      <p>暂无用户按键</p>
    </div>
  );
}
function shortcutError(
  item: UserShortcut,
  bindings: Record<string, string>,
  others: UserShortcut[],
) {
  const name = item.name.trim();
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return "名称需要 1–40 个字符";
  if (!item.binding) return "请按下快捷键";
  if (!item.text || item.text.length > 2000 || /[\u0000-\u001f\u007f]/.test(item.text))
    return "字符串需要 1–2000 个字符，换行请写 \\n";
  return shortcutConflict(bindings, undefined, [
    ...others.filter((entry) => entry.id !== item.id),
    { ...item, name },
  ].map((entry) => ({ label: entry.name || "用户按键", binding: entry.binding })));
}
export function ShortcutSettings({
  values,
  onChange,
  userShortcuts,
  onUserShortcutsChange,
  busy,
}: {
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  userShortcuts: UserShortcut[];
  onUserShortcutsChange: (values: UserShortcut[]) => void;
  busy: boolean;
}) {
  const [recording, setRecording] = useState("");
  const [tab, setTab] = useState("shortcuts");
  const [draft, setDraft] = useState<UserShortcut | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [removing, setRemoving] = useState<UserShortcut | null>(null);
  const bindings = effectiveShortcuts(values),
    conflict = shortcutConflict(
      bindings,
      undefined,
      userShortcuts.map((item) => ({ label: item.name || "用户按键", binding: item.binding })),
    );
  const recordingRef = useRef(recording);
  const bindingsRef = useRef(bindings);
  const onChangeRef = useRef(onChange);
  recordingRef.current = recording;
  bindingsRef.current = bindings;
  onChangeRef.current = onChange;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = recordingRef.current;
      if (!id) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setRecording("");
        return;
      }
      const value = captureShortcut(event);
      if (!value) return;
      event.preventDefault();
      event.stopPropagation();
      if (id === "draft") setDraft((current) => current && { ...current, binding: value });
      else onChangeRef.current({ ...bindingsRef.current, [id]: value });
      setRecording("");
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!recordingRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-shortcut-recorder]")) return;
      setRecording("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  useEffect(() => {
    if (recording) document.documentElement.dataset.shortcutRecording = "true";
    else delete document.documentElement.dataset.shortcutRecording;
    return () => {
      delete document.documentElement.dataset.shortcutRecording;
    };
  }, [recording]);
  function arm(id: string) {
    document.documentElement.dataset.shortcutRecording = "true";
    setRecording(id);
  }
  return (
    <div className="settings-section identity-manager shortcut-page">
      <div className="identity-manager__heading">
        <h2>键盘快捷键</h2>
        <p>默认修饰键：macOS 使用 ⌘，Windows / Linux 使用 Ctrl。点击组合键可重新设置，字号缩放只影响当前终端。</p>
      </div>
      {conflict ? (
        <Alert variant="destructive">
          <AlertDescription>{conflict}</AlertDescription>
        </Alert>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setRecording("");
        }}
      >
        <div className="shortcut-page__toolbar">
          <TabsList variant="line">
            <TabsTrigger value="shortcuts">快捷键</TabsTrigger>
            <TabsTrigger value="user">用户按键</TabsTrigger>
          </TabsList>
          <div className="shortcut-page__toolbar-actions">
            {tab === "shortcuts" ? (
              <Button variant="outline" disabled={busy} onClick={() => onChange({})}>
                恢复默认
              </Button>
            ) : (
              <Button
                className="host-primary-action"
                variant="outline"
                size="sm"
                disabled={busy || userShortcuts.length >= 30}
                onClick={() => {
                  setDialogError("");
                  setDraft(blankShortcut());
                }}
              >
                添加按键
              </Button>
            )}
          </div>
        </div>
        <TabsContent value="shortcuts">
          <div className="shortcut-binding-list">
            {shortcutActions.map((action) => (
              <div key={action.id}>
                <span>{action.label}</span>
                <div className="shortcut-binding-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    className="shortcut-binding-key"
                    data-shortcut-recorder="true"
                    data-recording={recording === action.id ? "true" : undefined}
                    disabled={busy}
                    aria-label={`配置快捷键 ${action.label}`}
                    title="点击后按下新的快捷键"
                    onClick={() => arm(action.id)}
                  >
                    {recording === action.id
                      ? "按下组合键…"
                      : bindings[action.id]
                        ? shortcutLabel(bindings[action.id])
                        : "未设置"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onChange({ ...bindings, [action.id]: "" })}
                  >
                    清除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="user">
          {userShortcuts.length ? (
            <div className="shortcut-binding-list">
              {userShortcuts.map((item) => (
              <div key={item.id}>
                <span>{item.name}</span>
                <div className="shortcut-binding-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    className="shortcut-binding-key"
                    disabled={busy}
                    aria-label={`编辑 ${item.name}`}
                    title="编辑"
                    onClick={() => { setDialogError(""); setDraft(item); }}
                  >
                    {shortcutLabel(item.binding)}
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRemoving(item)}>
                    删除
                  </Button>
                </div>
              </div>
              ))}
            </div>
          ) : (
            <UserShortcutEmpty />
          )}
        </TabsContent>
      </Tabs>
      <Dialog open={!!draft} onOpenChange={(open) => { if (!open) { setDraft(null); setRecording(""); } }}>
        <DialogContent className="identity-dialog">
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!draft) return;
            const next = { ...draft, name: draft.name.trim() };
            const message = shortcutError(next, bindings, userShortcuts);
            if (message) {
              setDialogError(message);
              return;
            }
            const exists = userShortcuts.some((item) => item.id === next.id);
            onUserShortcutsChange(exists ? userShortcuts.map((item) => item.id === next.id ? next : item) : [...userShortcuts, next]);
            setDraft(null);
            setRecording("");
          }}>
            <DialogHeader>
              <DialogTitle>{draft && userShortcuts.some((item) => item.id === draft.id) ? "编辑用户按键" : "添加用户按键"}</DialogTitle>
              <DialogDescription className="sr-only">设置名称、快捷键、发送类型和要发送的字符串。</DialogDescription>
            </DialogHeader>
            <div className="identity-dialog__fields">
              <label>
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>名称</span>
                <Input maxLength={40} placeholder="例如：查看目录" value={draft?.name ?? ""} onChange={(event) => setDraft((current) => current && { ...current, name: event.target.value })} />
              </label>
              <div className="identity-dialog__choice">
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>快捷键</span>
                <Button
                  type="button"
                  variant="outline"
                  className="user-shortcut-recorder"
                  data-shortcut-recorder="true"
                  data-empty={!draft?.binding && recording !== "draft" ? "true" : undefined}
                  data-recording={recording === "draft" ? "true" : undefined}
                  onClick={() => arm("draft")}
                >
                  {recording === "draft" ? "按下组合键…" : draft?.binding ? shortcutLabel(draft.binding) : "点击后按下组合键"}
                </Button>
              </div>
              <div className="identity-dialog__choice">
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>类型</span>
                <Choice
                  label="用户按键类型"
                  value={draft?.kind ?? "send"}
                  options={shortcutKinds}
                  triggerClassName="identity-dialog__select"
                  contentClassName="identity-dialog__select-content"
                  contentPosition="popper"
                  onChange={(kind) => setDraft((current) => current && { ...current, kind: kind as UserShortcut["kind"] })}
                />
              </div>
              <label>
                <span className="identity-dialog__label"><i aria-hidden="true">*</i>字符串</span>
                <Input maxLength={2000} placeholder="请输入字符串" value={draft?.text ?? ""} onChange={(event) => setDraft((current) => current && { ...current, text: event.target.value })} />
              </label>
              {dialogError ? <Alert variant="destructive"><AlertDescription>{dialogError}</AlertDescription></Alert> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setDraft(null); setRecording(""); }}>取消</Button>
              <Button>确定</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DeleteConfirmDialog
        open={!!removing}
        label={`确定删除用户按键 ${removing?.name ?? ""} 吗？`}
        hint="删除后会立即从本机配置中移除。"
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        onConfirm={() => {
          if (!removing) return;
          onUserShortcutsChange(userShortcuts.filter((item) => item.id !== removing.id));
          setRemoving(null);
        }}
      >
        确定删除用户按键“<strong>{removing?.name}</strong>”吗？
      </DeleteConfirmDialog>
    </div>
  );
}
