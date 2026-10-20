export type DropEdge = "left" | "right" | "top" | "bottom";
export type SplitAxis = "row" | "column";
export type PaneLayout =
  | { kind: "pane"; id: string }
  | {
      kind: "split";
      id: string;
      axis: SplitAxis;
      ratio: number;
      first: PaneLayout;
      second: PaneLayout;
    };
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PaneDivider {
  id: string;
  axis: SplitAxis;
  ratio: number;
  rect: PaneRect;
}
export function paneIds(layout: PaneLayout): string[] {
  return layout.kind === "pane"
    ? [layout.id]
    : [...paneIds(layout.first), ...paneIds(layout.second)];
}
export function splitPane(
  layout: PaneLayout,
  target: string,
  next: string,
  axis: SplitAxis,
  splitId: string,
  side: "before" | "after" = "after",
): PaneLayout {
  if (layout.kind === "pane")
    return layout.id === target
      ? {
          kind: "split",
          id: splitId,
          axis,
          ratio: 0.5,
          first: side === "before" ? { kind: "pane", id: next } : layout,
          second: side === "before" ? layout : { kind: "pane", id: next },
        }
      : layout;
  return {
    ...layout,
    first: splitPane(layout.first, target, next, axis, splitId, side),
    second: splitPane(layout.second, target, next, axis, splitId, side),
  };
}
export function removePane(
  layout: PaneLayout,
  target: string,
): PaneLayout | null {
  if (layout.kind === "pane") return layout.id === target ? null : layout;
  const first = removePane(layout.first, target),
    second = removePane(layout.second, target);
  return first && second ? { ...layout, first, second } : (first ?? second);
}
export function resizePane(
  layout: PaneLayout,
  id: string,
  ratio: number,
): PaneLayout {
  if (layout.kind === "pane" || !Number.isFinite(ratio)) return layout;
  return layout.id === id
    ? { ...layout, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
    : {
        ...layout,
        first: resizePane(layout.first, id, ratio),
        second: resizePane(layout.second, id, ratio),
      };
}
export function measurePanes(layout: PaneLayout) {
  const panes = new Map<string, PaneRect>();
  const dividers: PaneDivider[] = [];
  function walk(node: PaneLayout, rect: PaneRect) {
    if (node.kind === "pane") {
      panes.set(node.id, rect);
      return;
    }
    dividers.push({ id: node.id, axis: node.axis, ratio: node.ratio, rect });
    if (node.axis === "row") {
      walk(node.first, { ...rect, width: rect.width * node.ratio });
      walk(node.second, {
        ...rect,
        x: rect.x + rect.width * node.ratio,
        width: rect.width * (1 - node.ratio),
      });
    } else {
      walk(node.first, { ...rect, height: rect.height * node.ratio });
      walk(node.second, {
        ...rect,
        y: rect.y + rect.height * node.ratio,
        height: rect.height * (1 - node.ratio),
      });
    }
  }
  walk(layout, { x: 0, y: 0, width: 1, height: 1 });
  return { panes, dividers };
}
export function paneStyle(rect: PaneRect) {
  const left = rect.x > 0 ? 2 : 0,
    top = rect.y > 0 ? 2 : 0,
    right = rect.x + rect.width < 0.99999 ? 2 : 0,
    bottom = rect.y + rect.height < 0.99999 ? 2 : 0;
  return {
    left: `calc(${rect.x * 100}% + ${left}px)`,
    top: `calc(${rect.y * 100}% + ${top}px)`,
    width: `calc(${rect.width * 100}% - ${left + right}px)`,
    height: `calc(${rect.height * 100}% - ${top + bottom}px)`,
  };
}

export function dropEdge(x: number, y: number): DropEdge | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > 1 ||
    y > 1
  )
    return null;
  const edges: [DropEdge, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const nearest = edges.reduce((best, item) =>
    item[1] < best[1] ? item : best,
  );
  return nearest[1] <= 0.32 ? nearest[0] : null;
}

/** Move an existing connection; session identity and mounted terminal stay unchanged. */
export function movePane(
  layouts: PaneLayout[],
  source: string,
  target: string,
  edge: DropEdge,
  splitId: string,
): PaneLayout[] {
  if (source === target) return layouts;
  const sourceRoot = layouts.find((root) => paneIds(root).includes(source));
  const targetRoot = layouts.find((root) => paneIds(root).includes(target));
  if (!sourceRoot || !targetRoot) return layouts;
  if (sourceRoot !== targetRoot && paneIds(targetRoot).length >= 8)
    return layouts;
  const axis = edge === "left" || edge === "right" ? "row" : "column";
  const side = edge === "left" || edge === "top" ? "before" : "after";
  return layouts.flatMap((root) => {
    const remaining = removePane(root, source);
    return remaining
      ? [splitPane(remaining, target, source, axis, splitId, side)]
      : [];
  });
}

/** Swap two panes inside the same group while keeping every split ratio unchanged. */
export function swapPanes(
  layouts: PaneLayout[],
  source: string,
  target: string,
): PaneLayout[] {
  if (source === target) return layouts;
  const group = layouts.find((root) => {
    const ids = paneIds(root);
    return ids.includes(source) && ids.includes(target);
  });
  if (!group) return layouts;
  function swap(node: PaneLayout): PaneLayout {
    if (node.kind === "pane")
      return node.id === source
        ? { ...node, id: target }
        : node.id === target
          ? { ...node, id: source }
          : node;
    return { ...node, first: swap(node.first), second: swap(node.second) };
  }
  return layouts.map((root) => (root === group ? swap(root) : root));
}
