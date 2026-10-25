import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";

export interface MetricSeries {
  name: string;
  color: string;
  values: number[];
  /** Dashed strokes keep two same-colour curves apart (e.g. RX vs TX). */
  dashed?: boolean;
}

/**
 * Lightweight SVG line chart shaped after the Pixiu console metric panels:
 * bordered card, small title, smooth line with a fading area and a hover cursor.
 */
export function MetricChart({
  title,
  series,
  labels,
  unit = "",
  max,
  height = 112,
  note,
  tickFormat,
}: {
  title: string;
  series: MetricSeries[];
  labels: string[];
  unit?: string;
  max?: number;
  height?: number;
  note?: string;
  tickFormat?: (value: number) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Keeps area gradient ids unique across several cards on screen.
  const gradientId = useId();
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Re-runs on expand/collapse: the plot node is rebuilt then, and the
  // observer must follow the new node or width sticks at 0 forever.
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded]);

  // Escape closes the enlarged view as well.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const chartHeight = expanded ? 380 : height;
  const pad = { top: 10, right: 10, bottom: 16, left: 34 };
  const plotWidth = Math.max(width - pad.left - pad.right, 10);
  const plotHeight = Math.max(chartHeight - pad.top - pad.bottom, 10);
  const count = Math.max(...series.map((item) => item.values.length), labels.length, 0);
  const ceiling = max ?? niceCeiling(Math.max(0.0001, ...series.flatMap((item) => item.values)));
  const x = (index: number) =>
    pad.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) =>
    pad.top + plotHeight - (Math.min(value, ceiling) / ceiling) * plotHeight;
  const path = (values: number[]) => {
    const points = values.map((value, index) => [x(index), y(value)] as const);
    if (!points.length) return "";
    if (points.length === 1) {
      const [px, py] = points[0];
      return `M ${px - 6} ${py} L ${px + 6} ${py}`;
    }
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const previous = points[i - 1] ?? points[i];
      const start = points[i];
      const end = points[i + 1];
      const next = points[i + 2] ?? end;
      const c1x = start[0] + (end[0] - previous[0]) / 6;
      const c1y = start[1] + (end[1] - previous[1]) / 6;
      const c2x = end[0] - (next[0] - start[0]) / 6;
      const c2y = end[1] - (next[1] - start[1]) / 6;
      d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${end[0]} ${end[1]}`;
    }
    return d;
  };
  const area = (values: number[]) => {
    if (values.length < 2) return "";
    const base = pad.top + plotHeight;
    return `${path(values)} L ${x(values.length - 1)} ${base} L ${x(0)} ${base} Z`;
  };
  const ticks = Array.from({ length: 6 }, (_, index) => (ceiling / 5) * index);
  const axisLabels = count
    ? Array.from({ length: 5 }, (_, index) =>
        Math.round((index / 4) * (count - 1)),
      ).filter((index, position, all) => all.indexOf(index) === position)
    : [];
  const hovered = hover != null && hover < count ? hover : null;
  const card = (
    <div className={expanded ? "metric-card metric-card--expanded" : "metric-card"}>
      <div className="metric-card__header">
        <span className="metric-card__title">{title}</span>
        {note ? <span className="metric-card__note">{note}</span> : null}
        <button
          type="button"
          className="metric-card__expand"
          aria-label={expanded ? "还原图表" : "放大图表"}
          title={expanded ? "还原图表" : "放大图表"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </button>
      </div>
      <div
        className="metric-card__plot"
        ref={box}
        style={{ height: chartHeight }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - bounds.left - pad.left) / plotWidth;
          const index = Math.round(ratio * (count - 1));
          setHover(count <= 1 ? 0 : Math.min(Math.max(index, 0), count - 1));
        }}
      >
        {width > 0 ? (
          <svg width={width} height={chartHeight} aria-hidden="true">
            <defs>
              {series.map((item, position) => (
                <linearGradient
                  key={item.name}
                  id={`${gradientId}-${position}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={`var(${item.color})`} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={`var(${item.color})`} stopOpacity="0.02" />
                </linearGradient>
              ))}
            </defs>
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  className="metric-card__grid"
                  x1={pad.left}
                  x2={pad.left + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text className="metric-card__axis" x={pad.left - 5} y={y(tick) + 3} textAnchor="end">
                  {tickFormat ? tickFormat(tick) : formatTick(tick)}
                </text>
              </g>
            ))}
            <line
              className="metric-card__axis-line"
              x1={pad.left}
              x2={pad.left + plotWidth}
              y1={pad.top + plotHeight}
              y2={pad.top + plotHeight}
            />
            <line
              className="metric-card__axis-line"
              x1={pad.left}
              x2={pad.left}
              y1={pad.top}
              y2={pad.top + plotHeight}
            />
            {series.map((item, position) => (
              <g key={item.name}>
                <path
                  className="metric-card__area"
                  style={{ fill: `url(#${gradientId}-${position})` }}
                  d={area(item.values)}
                />
                <path
                  className="metric-card__line"
                  style={{ stroke: `var(${item.color})` }}
                  strokeDasharray={item.dashed ? "3 3" : undefined}
                  d={path(item.values)}
                />
                {hovered != null && item.values[hovered] != null ? (
                  <circle
                    cx={x(hovered)}
                    cy={y(item.values[hovered])}
                    r={2.6}
                    style={{ fill: `var(${item.color})` }}
                  />
                ) : null}
              </g>
            ))}
            {hovered != null ? (
              <line
                className="metric-card__cursor"
                x1={x(hovered)}
                x2={x(hovered)}
                y1={pad.top}
                y2={pad.top + plotHeight}
              />
            ) : null}
            {axisLabels.map((index) => (
              <text
                key={index}
                className="metric-card__axis"
                x={x(index)}
                y={chartHeight - 4}
                textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
              >
                {labels[index] ?? ""}
              </text>
            ))}
          </svg>
        ) : null}
        {count === 0 ? <p className="metric-card__empty">暂无数据</p> : null}
        {hovered != null ? (
          <div
            className="metric-card__tooltip"
            style={{
              left: Math.min(Math.max(x(hovered) + 8, 8), Math.max(width - 120, 8)),
            }}
          >
            <span className="metric-card__tooltip-time">{labels[hovered] ?? ""}</span>
            {series.map((item) => (
              <span key={item.name} className="metric-card__tooltip-row">
                <i
                  style={{
                    background: item.dashed
                      ? `repeating-linear-gradient(90deg, var(${item.color}) 0 3px, transparent 3px 6px)`
                      : `var(${item.color})`,
                  }}
                />
                {item.name}
                <b>{`${formatValue(item.values[hovered] ?? 0)}${unit}`}</b>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
  if (!expanded) return card;
  return createPortal(
    <>
      <div className="metric-card-backdrop" onClick={() => setExpanded(false)} />
      {card}
    </>,
    document.body,
  );
}

function niceCeiling(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= magnitude * step) return magnitude * step;
  }
  return magnitude * 10;
}
function formatTick(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}G`;
  if (value >= 1024) return `${Math.round(value / 1024)}M`;
  if (value >= 10) return String(Math.round(value));
  return value.toFixed(value < 1 ? 1 : 0);
}
function formatValue(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}
