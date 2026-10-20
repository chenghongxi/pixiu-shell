import { useEffect, useRef, useState, type ReactNode } from "react";
import { ResizeHandle } from "./ResizeHandle";
export function AiDock({
  width,
  hidden,
  onWidthChange,
  children,
}: {
  width: number;
  hidden: boolean;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(width);
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Synchronize the width restored from native preferences without remounting chat.
    // oxlint-disable-next-line react/set-state-in-effect
    setCurrent(width);
  }, [width]);
  function commit(value: number) {
    const available = dock.current?.parentElement?.clientWidth ?? 1200;
    onWidthChange(Math.round(Math.min(Math.max(280, available - 240), value)));
  }
  return (
    <div
      className="ai-panels"
      hidden={hidden}
      ref={dock}
      style={{ width: current }}
    >
      <ResizeHandle
        axis="row"
        label="调整 AI 面板宽度"
        value={current}
        min={280}
        max={1000}
        step={20}
        onChange={setCurrent}
        onCommit={commit}
        coordinate={(x) =>
          (dock.current?.parentElement?.getBoundingClientRect().right ?? x) - x
        }
      />
      {children}
    </div>
  );
}
