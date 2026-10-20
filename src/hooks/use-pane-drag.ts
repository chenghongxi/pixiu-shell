import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { dropEdge, type DropEdge } from "@/lib/pane-layout";
export interface PaneDrop {
  targetId: string;
  edge: DropEdge | "center";
}
interface DragView {
  sourceId: string;
  x: number;
  y: number;
  drop: PaneDrop | null;
}
interface Gesture {
  sourceId: string;
  originId: string;
  pointerId: number;
  x: number;
  y: number;
  started: boolean;
  capture: HTMLElement;
  hoverId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}
export function usePaneDrag({
  activeId,
  onDrop,
  onPreview,
  onCancel,
}: {
  activeId: string;
  onDrop: (source: string, drop: PaneDrop) => boolean;
  onPreview: (id: string) => void;
  onCancel: (originId: string) => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragView | null>(null);
  function release(): Gesture | null {
    const current = gesture.current;
    gesture.current = null;
    if (current?.timer) clearTimeout(current.timer);
    if (current?.capture.hasPointerCapture(current.pointerId))
      current.capture.releasePointerCapture(current.pointerId);
    setDrag(null);
    return current;
  }
  function cancel() {
    const current = release();
    if (current?.started) {
      suppressClick.current = true;
      onCancel(current.originId);
    }
  }
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        const current = gesture.current;
        gesture.current = null;
        if (current.timer) clearTimeout(current.timer);
        if (current.capture.hasPointerCapture(current.pointerId))
          current.capture.releasePointerCapture(current.pointerId);
        suppressClick.current = current.started;
        setDrag(null);
        if (current.started) onCancel(current.originId);
      }
    }
    function blur() {
      const current = gesture.current;
      if (!current) return;
      gesture.current = null;
      if (current.timer) clearTimeout(current.timer);
      suppressClick.current = current.started;
      setDrag(null);
      if (current.started) onCancel(current.originId);
    }
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", blur);
    };
  }, [onCancel]);
  useEffect(
    () => () => {
      if (gesture.current?.timer) clearTimeout(gesture.current.timer);
      gesture.current = null;
    },
    [],
  );
  function hit(x: number, y: number, source: string): PaneDrop | null {
    const element = document.elementFromPoint(x, y);
    const pane = element?.closest<HTMLElement>(".session-view:not([hidden])");
    const targetId = pane?.dataset.paneId;
    if (!pane || !targetId || targetId === source) return null;
    const bounds = pane.getBoundingClientRect();
    const edge = dropEdge(
      (x - bounds.left) / bounds.width,
      (y - bounds.top) / bounds.height,
    );
    if (edge) return { targetId, edge };
    const sourcePane = Array.from(
      document.querySelectorAll<HTMLElement>(".session-view:not([hidden])"),
    ).find((item) => item.dataset.paneId === source);
    if (
      sourcePane &&
      pane.dataset.split === "true" &&
      x >= bounds.left &&
      x <= bounds.right &&
      y >= bounds.top &&
      y <= bounds.bottom
    )
      return { targetId, edge: "center" };
    return null;
  }
  function bind<T extends HTMLElement = HTMLButtonElement>(
    sourceId: string,
  ): HTMLAttributes<T> {
    return {
      draggable: false,
      onDragStart: (event) => event.preventDefault(),
      onPointerDown: (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.stopPropagation();
        suppressClick.current = false;
        gesture.current = {
          sourceId,
          originId: activeId,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          started: false,
          capture: event.currentTarget,
          hoverId: null,
          timer: null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (
          !current.started &&
          Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6
        )
          return;
        event.stopPropagation();
        current.started = true;
        suppressClick.current = true;
        const hover = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-session-tab-id]")?.dataset.sessionTabId;
        const hoverId = hover && hover !== sourceId ? hover : null;
        if (hoverId !== current.hoverId) {
          if (current.timer) clearTimeout(current.timer);
          current.hoverId = hoverId;
          current.timer = hoverId
            ? setTimeout(() => {
                if (gesture.current === current) onPreview(hoverId);
              }, 350)
            : null;
        }
        setDrag({
          sourceId,
          x: event.clientX,
          y: event.clientY,
          drop: hit(event.clientX, event.clientY, sourceId),
        });
      },
      onPointerUp: (event) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const target = current.started
          ? hit(event.clientX, event.clientY, sourceId)
          : null;
        release();
        if (current.started) {
          event.preventDefault();
          suppressClick.current = true;
          if (!target || !onDrop(sourceId, target)) onCancel(current.originId);
        }
      },
      onPointerCancel: cancel,
      onLostPointerCapture: () => {
        if (gesture.current) cancel();
      },
      onClickCapture: (event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
    };
  }
  return { drag, bind };
}
