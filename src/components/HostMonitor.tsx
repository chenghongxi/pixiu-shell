import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { MetricChart } from "./MetricChart";
import { MonitorIcon } from "./MonitorIcon";
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "./ui/alert";
import {
  errorMessage,
  hostMetrics,
  stopHostMetrics,
  type Host,
  type HostMetrics,
} from "@/lib/api";

const maxPoints = 60;
/** Each probe sleeps one second on the host, so 10s keeps traffic modest. */
const intervalMs = 10000;

interface Sample {
  at: number;
  metrics: HostMetrics;
}

export function HostMonitor({
  host,
  visible,
  onClose,
}: {
  host: Host;
  visible: boolean;
  onClose: () => void;
}) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState("");
  const timer = useRef(0);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    async function tick() {
      try {
        const metrics = await hostMetrics(host.id);
        if (cancelled) return;
        setSamples((current) =>
          [...current, { at: Date.now(), metrics }].slice(-maxPoints),
        );
        setError("");
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) timer.current = window.setTimeout(tick, intervalMs);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [visible, host.id]);

  // The cached SSH session is only useful while the panel keeps polling.
  useEffect(() => {
    if (visible) return;
    void stopHostMetrics(host.id).catch(() => undefined);
  }, [visible, host.id]);
  useEffect(() => () => void stopHostMetrics(host.id).catch(() => undefined), [host.id]);

  const latest = samples.at(-1)?.metrics;
  const labels = samples.map((sample) => clock(sample.at));
  const percent = (used: number, total: number) =>
    total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const network = networkScale(samples);
  return (
    <section className="ai-panel monitor-panel" hidden={!visible}>
      <header>
        <div>
          <MonitorIcon />
          <strong>主机监控</strong>
          <span>{host.name}</span>
        </div>
        <div className="monitor-actions">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="关闭监控"
            title="关闭监控"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </header>
      <div className="monitor-body">
        {error ? (
          <Alert variant="destructive" className="monitor-alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="monitor-summary">
          <Metric
            label="运行时间"
            value={latest ? uptime(latest.uptimeSecs) : "—"}
          />
          <Metric
            label="平均负载"
            value={
              latest
                ? `${latest.load1.toFixed(2)} / ${latest.load5.toFixed(2)} / ${latest.load15.toFixed(2)}`
                : "—"
            }
          />
          <Metric label="CPU 核数" value={latest ? String(latest.cores) : "—"} />
          <Metric label="内存" value={latest ? size(latest.memTotalKb) : "—"} />
        </div>
        <MetricChart
          title="CPU 使用率 (%)"
          unit="%"
          max={100}
          labels={labels}
          note={latest ? `${latest.cpuPercent.toFixed(1)}%` : undefined}
          series={[
            {
              name: "CPU",
              color: "--chart-blue",
              values: samples.map((sample) => sample.metrics.cpuPercent),
            },
          ]}
        />
        <MetricChart
          title="内存使用（%）"
          unit="%"
          max={100}
          labels={labels}
          note={latest ? gib(latest.memUsedKb, latest.memTotalKb) : undefined}
          series={[
            {
              name: "内存",
              color: "--chart-blue",
              values: samples.map((sample) =>
                percent(sample.metrics.memUsedKb, sample.metrics.memTotalKb),
              ),
            },
          ]}
        />
        <MetricChart
          title="磁盘使用 (%)"
          unit="%"
          max={100}
          labels={labels}
          note={latest ? gib(latest.diskUsedKb, latest.diskTotalKb) : undefined}
          series={[
            {
              name: "磁盘",
              color: "--chart-blue",
              values: samples.map((sample) =>
                percent(sample.metrics.diskUsedKb, sample.metrics.diskTotalKb),
              ),
            },
          ]}
        />
        <MetricChart
          title={`网络速率（${network.unit}）`}
          unit={network.unit}
          labels={labels}
          note={
            latest
              ? `↓ ${network.format(latest.netRxBytesPerSec)} ↑ ${network.format(latest.netTxBytesPerSec)}`
              : undefined
          }
          tickFormat={network.tick}
          series={[
            {
              name: "接收",
              color: "--chart-blue",
              values: samples.map((sample) =>
                network.convert(sample.metrics.netRxBytesPerSec),
              ),
            },
            {
              name: "发送",
              color: "--chart-blue",
              dashed: true,
              values: samples.map((sample) =>
                network.convert(sample.metrics.netTxBytesPerSec),
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="monitor-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}
function uptime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时 ${minutes} 分`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${total % 60} 秒`;
}
function size(kb: number) {
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
function gib(usedKb: number, totalKb: number) {
  const toGib = (kb: number) => kb / 1024 / 1024;
  return `${toGib(usedKb).toFixed(1)} / ${toGib(totalKb).toFixed(1)} GB`;
}
/** Keeps one unit for the whole card so the axis stays readable. */
function networkScale(samples: Sample[]) {
  const peak = Math.max(
    0,
    ...samples.flatMap((sample) => [
      sample.metrics.netRxBytesPerSec,
      sample.metrics.netTxBytesPerSec,
    ]),
  );
  if (peak >= 1024 * 1024) {
    return {
      unit: "MB/s",
      convert: (bytes: number) => bytes / 1024 / 1024,
      format: (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB/s`,
      tick: (value: number) => value.toFixed(value >= 10 ? 0 : 1),
    };
  }
  return {
    unit: "KB/s",
    convert: (bytes: number) => bytes / 1024,
    format: (bytes: number) => `${(bytes / 1024).toFixed(1)} KB/s`,
    tick: (value: number) => value.toFixed(value >= 100 ? 0 : 1),
  };
}
