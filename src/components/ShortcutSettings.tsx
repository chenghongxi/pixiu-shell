import { useState } from "react";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import {
  shortcutActions,
  effectiveShortcuts,
  captureShortcut,
  shortcutConflict,
  shortcutLabel,
} from "@/lib/shortcuts";
export function ShortcutSettings({
  values,
  onChange,
  onSave,
  busy,
}: {
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  onSave: () => void;
  busy: boolean;
}) {
  const [recording, setRecording] = useState("");
  const bindings = effectiveShortcuts(values),
    conflict = shortcutConflict(bindings);
  return (
    <Card className="shortcut-config">
      <CardHeader>
        <CardTitle>键盘快捷键</CardTitle>
        <CardDescription>
          默认修饰键：macOS 使用 ⌘，Windows / Linux 使用
          Ctrl。点击组合键可重新设置，字号缩放只影响当前终端。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {conflict ? (
          <Alert variant="destructive">
            <AlertDescription>{conflict}</AlertDescription>
          </Alert>
        ) : null}
        <div className="shortcut-binding-list">
          {shortcutActions.map((action) => (
            <div key={action.id}>
              <span>{action.label}</span>
              <Button
                variant="outline"
                size="sm"
                data-shortcut-recorder="true"
                disabled={busy}
                aria-label={`配置快捷键 ${action.label}`}
                onClick={() => setRecording(action.id)}
                onBlur={() => setRecording("")}
                onKeyDown={(event) => {
                  if (recording !== action.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    setRecording("");
                    return;
                  }
                  const value = captureShortcut(event.nativeEvent);
                  if (value) {
                    onChange({ ...bindings, [action.id]: value });
                    setRecording("");
                  }
                }}
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
          ))}
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="ghost" disabled={busy} onClick={() => onChange({})}>
          恢复默认
        </Button>
        <span />
        <Button disabled={busy || !!conflict} onClick={onSave}>
          保存快捷键
        </Button>
      </CardFooter>
    </Card>
  );
}
