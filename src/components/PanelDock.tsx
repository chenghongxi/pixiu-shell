import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ResizeHandle } from "./ResizeHandle";

/**
 * 右侧面板停靠区：所有面板共用同一宽度并贴紧窗口右缘。
 * 只保留一个拖拽把手，调整的是全部面板的宽度。
 */
export function PanelDock({
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
    // 同步从原生偏好里恢复的宽度，不重挂载面板内容。
    // oxlint-disable-next-line react/set-state-in-effect
    setCurrent(width);
  }, [width]);
  function commit(value: number) {
    const node = dock.current;
    if (!node) return;
    // 多个面板并排时按可见面板数摊分可用宽度，避免存下一个放不下的值。
    const panels = Array.from(node.children).filter(
      (el) =>
        el instanceof HTMLElement &&
        !el.hidden &&
        !el.classList.contains("resize-handle"),
    ).length;
    const available = node.parentElement?.clientWidth ?? 1200;
    const max = Math.max(
      280,
      Math.floor((available - 240) / Math.max(1, panels)),
    );
    onWidthChange(Math.round(Math.min(max, Math.max(280, value))));
  }
  return (
    <div
      className="panel-dock"
      hidden={hidden}
      ref={dock}
      style={{ "--panel-w": `${current}px` } as CSSProperties}
    >
      <ResizeHandle
        axis="row"
        label="调整侧边面板宽度"
        value={current}
        min={280}
        max={1000}
        step={20}
        onChange={setCurrent}
        onCommit={commit}
        coordinate={(x) =>
          (dock.current?.getBoundingClientRect().right ?? x) - x
        }
      />
      {children}
    </div>
  );
}
