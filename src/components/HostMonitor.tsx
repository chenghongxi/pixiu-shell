import { useEffect, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { MetricChart } from "./MetricChart";
import { MonitorIcon } from "./MonitorIcon";
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "./ui/alert";
import { SearchInput } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  errorMessage,
  hostMetrics,
  stopHostMetrics,
  type Host,
  type HostMetrics,
  type ProcessMetrics,
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
  embedded = false,
}: {
  host: Host;
  visible: boolean;
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    const monitorId = crypto.randomUUID();
    let cancelled = false;
    let inFlight = false;
    let timer = 0;
    async function tick() {
      inFlight = true;
      try {
        const metrics = await hostMetrics(host.id, monitorId);
        if (cancelled) return;
        setSamples((current) =>
          [...current, { at: Date.now(), metrics }].slice(-maxPoints),
        );
        setError("");
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        inFlight = false;
        if (cancelled) {
          void stopHostMetrics(host.id, monitorId).catch(() => undefined);
        } else {
          timer = window.setTimeout(tick, intervalMs);
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (!inFlight) void stopHostMetrics(host.id, monitorId).catch(() => undefined);
    };
  }, [visible, host.id]);

  const latest = samples.at(-1)?.metrics;
  const labels = samples.map((sample) => clock(sample.at));
  const percent = (used: number, total: number) =>
    total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const network = rateScale(samples, (metrics) => [
    metrics.netRxBytesPerSec,
    metrics.netTxBytesPerSec,
  ]);
  const disk = rateScale(samples, (metrics) => [
    metrics.diskReadBytesPerSec,
    metrics.diskWriteBytesPerSec,
  ]);
  return (
    <section className={embedded ? "monitor-panel monitor-panel--embedded" : "ai-panel monitor-panel"} hidden={!visible}>
      {!embedded && <header>
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
      </header>}
      <Tabs defaultValue="overview" className="monitor-tabs">
        <TabsList variant="line" className="monitor-tabs__list" aria-label="监控分类">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="processes">进程</TabsTrigger>
        </TabsList>
      <div className="monitor-body">
        {error ? (
          <Alert variant="destructive" className="monitor-alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <TabsContent value="overview" className="monitor-overview">
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
          title={`磁盘 IO（${disk.unit}）`}
          unit={disk.unit}
          labels={labels}
          tickFormat={disk.tick}
          series={[
            {
              name: "读取",
              color: "--chart-blue",
              values: samples.map((sample) =>
                disk.convert(sample.metrics.diskReadBytesPerSec),
              ),
            },
            {
              name: "写入",
              color: "--chart-blue",
              dashed: true,
              values: samples.map((sample) =>
                disk.convert(sample.metrics.diskWriteBytesPerSec),
              ),
            },
          ]}
        />
        <MetricChart
          title="TCP 连接数"
          unit="个"
          labels={labels}
          series={[
            {
              name: "已建立",
              color: "--chart-blue",
              values: samples.map((sample) => sample.metrics.tcpEstablished),
            },
            {
              name: "TIME_WAIT",
              color: "--tone-amber",
              values: samples.map((sample) => sample.metrics.tcpTimeWait),
            },
            {
              name: "CLOSE_WAIT",
              color: "--tone-teal",
              values: samples.map((sample) => sample.metrics.tcpCloseWait),
            },
          ]}
        />
        <MetricChart
          title={`网络速率（${network.unit}）`}
          unit={network.unit}
          labels={labels}
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
        </TabsContent>
        <TabsContent value="processes" className="monitor-processes">
          <ProcessList processes={latest?.processes} loading={!latest && !error} />
        </TabsContent>
      </div>
      </Tabs>
    </section>
  );
}

function ProcessList({
  processes,
  loading,
}: {
  processes: ProcessMetrics[] | null | undefined;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"cpu" | "memory" | "pid">("cpu");
  const keyword = query.trim().toLowerCase();
  const filtered = (processes ?? [])
    .filter((process) =>
      [String(process.pid), process.user, process.command]
        .some((value) => value.toLowerCase().includes(keyword)),
    )
    .sort((a, b) =>
      sort === "memory"
        ? b.rssKb - a.rssKb || a.pid - b.pid
        : sort === "pid"
          ? a.pid - b.pid
          : b.cpuPercent - a.cpuPercent || a.pid - b.pid,
    );

  return (
    <section className="monitor-process-list" aria-label="进程列表">
      <div className="monitor-process-toolbar">
        <label className="monitor-process-search">
          <Search aria-hidden="true" />
          <SearchInput
            aria-label="搜索进程"
            placeholder="搜索 PID、用户或命令"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="monitor-process-sort"
              aria-label={`进程排序：${sort === "cpu" ? "CPU" : sort === "memory" ? "内存" : "PID"}`}
            >
              {sort === "cpu" ? "CPU 排序" : sort === "memory" ? "内存排序" : "PID 排序"}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {([
              ["cpu", "CPU 排序"],
              ["memory", "内存排序"],
              ["pid", "PID 排序"],
            ] as const).map(([value, label]) => (
              <DropdownMenuItem
                key={value}
                role="menuitemradio"
                aria-checked={sort === value}
                onSelect={() => setSort(value)}
              >
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="monitor-process-meta">
        <span>{processes ? `进程 ${filtered.length} / ${processes.length}` : "进程"}</span>
        <span>CPU 前 200 · CPU 为启动以来平均值</span>
      </div>
      {loading ? (
        <p className="monitor-process-empty">正在采集进程数据…</p>
      ) : !processes ? (
        <p className="monitor-process-empty">进程数据暂不可用</p>
      ) : filtered.length === 0 ? (
        <p className="monitor-process-empty">{keyword ? "没有匹配的进程" : "暂无进程数据"}</p>
      ) : (
        <div className="monitor-process-table-wrap" role="region" aria-label="进程数据">
          <table className="monitor-process-table">
            <thead>
              <tr>
                <th>进程</th>
                <th title="进程启动以来的平均 CPU 使用率">CPU</th>
                <th>内存</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((process) => (
                <tr key={process.pid}>
                  <td>
                    <div className="monitor-process-command" title={process.command}>
                      {process.command || `[${process.pid}]`}
                    </div>
                    <div className="monitor-process-detail">
                      <span>PID {process.pid}</span>
                      <span title={process.user}>{process.user}</span>
                      <span>{process.state}</span>
                    </div>
                  </td>
                  <td className="monitor-process-number">{process.cpuPercent.toFixed(1)}%</td>
                  <td className="monitor-process-number">
                    <div>{size(process.rssKb)}</div>
                    <small>{process.memoryPercent.toFixed(1)}%</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
function rateScale(
  samples: Sample[],
  values: (metrics: HostMetrics) => number[],
) {
  const peak = Math.max(
    0,
    ...samples.flatMap((sample) => values(sample.metrics)),
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
