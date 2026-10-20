import { useRef, type CSSProperties, type PointerEvent } from "react";
export function ResizeHandle({
  axis,
  label,
  value,
  min,
  max,
  step = 0.025,
  onChange,
  onCommit,
  coordinate,
  style,
}: {
  axis: "row" | "column";
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  coordinate: (clientX: number, clientY: number) => number;
  style?: CSSProperties;
}) {
  const latest = useRef(value);
  const dragging = useRef(false);
  function apply(next: number) {
    if (!Number.isFinite(next)) return;
    latest.current = Math.min(max, Math.max(min, next));
    onChange(latest.current);
  }
  function finish(event: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.dataset.dragging = "false";
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit?.(latest.current);
  }
  return (
    <div
      className={`resize-handle resize-${axis}`}
      style={style}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        latest.current = value;
        dragging.current = true;
        event.currentTarget.dataset.dragging = "true";
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current) apply(coordinate(event.clientX, event.clientY));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={(event) => {
        const decrease = axis === "row" ? "ArrowLeft" : "ArrowUp";
        const increase = axis === "row" ? "ArrowRight" : "ArrowDown";
        if (
          event.key === decrease ||
          event.key === increase ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          event.preventDefault();
          apply(
            event.key === "Home"
              ? min
              : event.key === "End"
                ? max
                : value + (event.key === decrease ? -step : step),
          );
          onCommit?.(latest.current);
        }
      }}
    >
      <span />
    </div>
  );
}
