import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { dropEdge, type DropEdge } from "@/lib/pane-layout";
export interface PaneDrop {
  targetId: string;
  edge: DropEdge | "center";
}
export interface TabReorder {
  targetId: string;
  before: boolean;
}
interface DragView {
  sourceId: string;
  drop: PaneDrop | null;
  reorder: TabReorder | null;
}
interface TabSlot {
  id: string;
  el: HTMLElement;
  left: number;
  width: number;
}
interface Gesture {
  sourceId: string;
  originId: string;
  pointerId: number;
  x: number;
  y: number;
  started: boolean;
  hoverId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  slots: TabSlot[] | null;
  shift: number | null;
  frame: number | null;
  cleanup: () => void;
}
function measureSlots(): TabSlot[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-session-tab-id]"),
  ).flatMap((el) => {
    const id = el.dataset.sessionTabId;
    return id ? [{ id, el, left: el.offsetLeft, width: el.offsetWidth }] : [];
  });
}
function pointerInTabRow(x: number, y: number): boolean {
  const row = document
    .querySelector(".session-tabrow")
    ?.getBoundingClientRect();
  return (
    !!row &&
    x >= row.left &&
    x <= row.right &&
    y >= row.top - 4 &&
    y <= row.bottom + 12
  );
}
function localX(clientX: number, el: HTMLElement): number {
  const parent = el.offsetParent as HTMLElement | null;
  if (!parent) return clientX;
  return clientX - parent.getBoundingClientRect().left + parent.scrollLeft;
}
function clearShift(slots: TabSlot[] | null) {
  slots?.forEach((slot) => {
    slot.el.style.transition = "none";
    slot.el.style.transform = "";
    slot.el.style.zIndex = "";
    slot.el.style.pointerEvents = "";
    slot.el.style.transition = "";
  });
}
function slideTabs(
  slots: TabSlot[],
  sourceId: string,
  index: number,
  x: number,
) {
  const source = slots.find((slot) => slot.id === sourceId);
  if (!source) return;
  const others = slots.filter((slot) => slot.id !== sourceId);
  const order = [...others.slice(0, index), source, ...others.slice(index)];
  const gap =
    slots.length > 1
      ? Math.max(0, slots[1].left - slots[0].left - slots[0].width)
      : 0;
  let left = slots[0].left;
  const desired = new Map<string, number>();
  for (const slot of order) {
    desired.set(slot.id, left);
    left += slot.width + gap;
  }
  const last = slots[slots.length - 1];
  const follow = Math.min(
    last.left + last.width - source.width - source.left,
    Math.max(slots[0].left - source.left, x - (source.left + source.width / 2)),
  );
  source.el.style.transition = "none";
  source.el.style.zIndex = "3";
  source.el.style.pointerEvents = "none";
  source.el.style.transform = `translate3d(${follow}px,0,0)`;
  for (const slot of others) {
    const dx = (desired.get(slot.id) ?? slot.left) - slot.left;
    slot.el.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
    slot.el.style.transform = dx ? `translate3d(${dx}px,0,0)` : "";
  }
}
function followTab(slots: TabSlot[], sourceId: string, x: number) {
  const source = slots.find((slot) => slot.id === sourceId);
  if (!source) return;
  const last = slots[slots.length - 1];
  const follow = Math.min(
    last.left + last.width - source.width - source.left,
    Math.max(slots[0].left - source.left, x - (source.left + source.width / 2)),
  );
  source.el.style.transform = `translate3d(${follow}px,0,0)`;
}
function insertion(slots: TabSlot[], sourceId: string, x: number): number {
  let index = 0;
  for (const slot of slots) {
    if (slot.id === sourceId) continue;
    if (x > slot.left + slot.width / 2) index += 1;
  }
  return index;
}
function reorderAt(
  slots: TabSlot[],
  sourceId: string,
  index: number,
): TabReorder | null {
  const sourceIndex = slots.findIndex((slot) => slot.id === sourceId);
  if (sourceIndex < 0 || index === sourceIndex) return null;
  const others = slots.filter((slot) => slot.id !== sourceId);
  if (!others.length) return null;
  return index < others.length
    ? { targetId: others[index].id, before: true }
    : { targetId: others[others.length - 1].id, before: false };
}
function placeTabs(slots: TabSlot[], sourceId: string, index: number) {
  const source = slots.find((slot) => slot.id === sourceId);
  const others = slots.filter((slot) => slot.id !== sourceId);
  source?.el.parentElement?.insertBefore(source.el, others[index]?.el ?? null);
  clearShift(slots);
}
function sameDrag(current: DragView | null, next: DragView): boolean {
  return (
    !!current &&
    current.sourceId === next.sourceId &&
    current.reorder == null &&
    next.reorder == null &&
    current.drop?.targetId === next.drop?.targetId &&
    current.drop?.edge === next.drop?.edge
  );
}
export function usePaneDrag({
  activeId,
  onDrop,
  onReorder,
  onPreview,
  onCancel,
}: {
  activeId: string;
  onDrop: (source: string, drop: PaneDrop) => boolean;
  onReorder: (source: string, reorder: TabReorder) => void;
  onPreview: (id: string) => void;
  onCancel: (originId: string) => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragView | null>(null);
  function publish(next: DragView) {
    setDrag((current) => (sameDrag(current, next) ? current : next));
  }
  function release(): Gesture | null {
    const current = gesture.current;
    gesture.current = null;
    if (current?.timer) clearTimeout(current.timer);
    if (current?.frame != null) cancelAnimationFrame(current.frame);
    clearShift(current?.slots ?? null);
    current?.cleanup();
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
      if (event.key !== "Escape" || !gesture.current) return;
      event.preventDefault();
      const started = gesture.current.started;
      const origin = gesture.current.originId;
      release();
      if (started) {
        suppressClick.current = true;
        onCancel(origin);
      }
    }
    function blur() {
      if (gesture.current) cancel();
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
      gesture.current?.cleanup();
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
        const target = event.target;
        if (target instanceof Element && target.closest("[data-slot='button']"))
          return;
        event.stopPropagation();
        suppressClick.current = false;
        const current: Gesture = {
          sourceId,
          originId: activeId,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          started: false,
          hoverId: null,
          timer: null,
          slots: null,
          shift: null,
          frame: null,
          cleanup: () => undefined,
        };
        const move = (pointer: PointerEvent) => {
          if (
            gesture.current !== current ||
            current.pointerId !== pointer.pointerId
          )
            return;
          if (
            !current.started &&
            Math.hypot(pointer.clientX - current.x, pointer.clientY - current.y) <
              6
          )
            return;
          if (!current.started) {
            current.started = true;
            suppressClick.current = true;
            current.slots = measureSlots();
            const dragging = current.slots.find((slot) => slot.id === sourceId);
            if (dragging) dragging.el.style.pointerEvents = "none";
            publish({ sourceId, drop: null, reorder: null });
          }
          const hover = document
            .elementFromPoint(pointer.clientX, pointer.clientY)
            ?.closest<HTMLElement>("[data-session-tab-id]")?.dataset
            .sessionTabId;
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
          const slots = current.slots;
          if (
            slots?.length &&
            pointerInTabRow(pointer.clientX, pointer.clientY)
          ) {
            const x = localX(pointer.clientX, slots[0].el);
            const index = insertion(slots, sourceId, x);
            if (index !== current.shift) {
              current.shift = index;
              slideTabs(slots, sourceId, index, x);
            } else followTab(slots, sourceId, x);
            publish({ sourceId, drop: null, reorder: null });
            return;
          }
          if (current.shift != null) {
            current.shift = null;
            clearShift(slots);
          }
          publish({
            sourceId,
            drop: hit(pointer.clientX, pointer.clientY, sourceId),
            reorder: null,
          });
        };
        const track = (pointer: PointerEvent) => {
          if (
            gesture.current !== current ||
            current.pointerId !== pointer.pointerId
          )
            return;
          if (current.frame != null) cancelAnimationFrame(current.frame);
          current.frame = requestAnimationFrame(() => {
            current.frame = null;
            move(pointer);
          });
        };
        const finish = (pointer: PointerEvent) => {
          if (
            gesture.current !== current ||
            current.pointerId !== pointer.pointerId
          )
            return;
          if (current.frame != null) {
            cancelAnimationFrame(current.frame);
            current.frame = null;
          }
          move(pointer);
          const slots = current.slots;
          const reorder =
            current.started &&
            slots?.length &&
            current.shift != null &&
            pointerInTabRow(pointer.clientX, pointer.clientY)
              ? reorderAt(slots, sourceId, current.shift)
              : null;
          if (reorder && slots && current.shift != null)
            placeTabs(slots, sourceId, current.shift);
          const target =
            current.started && !reorder
              ? hit(pointer.clientX, pointer.clientY, sourceId)
              : null;
          const started = current.started;
          const origin = current.originId;
          release();
          if (!started) return;
          suppressClick.current = true;
          if (reorder) onReorder(sourceId, reorder);
          else if (!target || !onDrop(sourceId, target)) onCancel(origin);
        };
        const abort = (pointer: PointerEvent) => {
          if (
            gesture.current !== current ||
            current.pointerId !== pointer.pointerId
          )
            return;
          cancel();
        };
        current.cleanup = () => {
          window.removeEventListener("pointermove", track);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", abort);
          if (current.frame != null) cancelAnimationFrame(current.frame);
          clearShift(current.slots);
        };
        gesture.current = current;
        window.addEventListener("pointermove", track);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", abort);
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
