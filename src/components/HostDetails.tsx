import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Network,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import {
  resource,
  errorMessage,
  type Host,
  type HostIp,
  type PlatformHostDetail,
} from "@/lib/api";
import { Button } from "./ui/button";
import { SearchInput } from "./ui/input";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

const ipTypes: Record<string, string> = {
  public: "外网",
  private: "内网",
  elastic: "弹性公网",
  vip: "虚拟 IP",
  other: "其他",
};
type Scope = "all" | "public" | "private" | "other";
const category = (ip: HostIp): Exclude<Scope, "all"> =>
  ip.ipType === "public" || ip.ipType === "elastic"
    ? "public"
    : ip.ipType === "private"
      ? "private"
      : "other";
const pageSize = 10;

export function HostDetails({ host }: { host: Host }) {
  const [detail, setDetail] = useState<PlatformHostDetail | null>(null);
  const [ips, setIps] = useState<HostIp[]>([]);
  const [errors, setErrors] = useState({ detail: "", ips: "" });
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    let cancelled = false;
    // These independent reads share the platform permission boundary, never credentials.
    void Promise.allSettled([
      resource<PlatformHostDetail>(`assets/hosts/${host.id}`),
      resource<HostIp[]>(`assets/hosts/${host.id}/ips`),
    ]).then(([info, addresses]) => {
      if (cancelled) return;
      setDetail(info.status === "fulfilled" ? info.value : null);
      setIps(addresses.status === "fulfilled" ? addresses.value : []);
      setErrors({
        detail: info.status === "rejected" ? errorMessage(info.reason) : "",
        ips:
          addresses.status === "rejected" ? errorMessage(addresses.reason) : "",
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [host.id, revision]);
  const counts = { all: ips.length, public: 0, private: 0, other: 0 };
  for (const ip of ips) counts[category(ip)]++;
  const keyword = query.trim().toLowerCase();
  const filtered = ips.filter(
    (ip) =>
      (scope === "all" || category(ip) === scope) &&
      [ip.ip, ip.interfaceName, ip.networkCidr].some((value) =>
        value?.toLowerCase().includes(keyword),
      ),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("IP 已复制");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <div className="host-detail-extra">
      <section className="host-system-info" aria-label="主机基础信息">
        <header>
          <h2>系统与资产</h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="刷新主机详情"
            title="刷新主机详情"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setRevision((v) => v + 1);
            }}
          >
            <RefreshCw />
          </Button>
        </header>
        {errors.detail ? (
          <p role="alert" className="host-detail-error">
            基础信息加载失败：{errors.detail}
          </p>
        ) : null}
        <dl>
          {[
            ["主机名", detail?.hostname],
            [
              "系统",
              [detail?.osType || host.osType, detail?.osVersion]
                .filter(Boolean)
                .join(" · "),
            ],
            ["架构", detail?.arch],
            ["云厂商", detail?.provider],
            [
              "区域 / 可用区",
              [detail?.region, detail?.zone].filter(Boolean).join(" / "),
            ],
            ["实例 ID", detail?.cloudInstanceId],
            ["状态", detail?.lifecycleStatus],
            ["分组路径", (host.groupPaths ?? [host.group]).join(" · ")],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || (loading ? "加载中" : "—")}</dd>
            </div>
          ))}
        </dl>
        {detail?.description ? (
          <p className="detail-note">{detail.description}</p>
        ) : null}
      </section>
      <section className="host-ip-section" aria-label="主机 IP 地址">
        <header>
          <h2>
            <Network />
            网络地址
          </h2>
          <span>{loading ? "加载中" : `${ips.length} 个 IP`}</span>
        </header>
        <Tabs
          value={scope}
          onValueChange={(value) => {
            setScope(value as Scope);
            setPage(1);
          }}
        >
          <div className="host-ip-toolbar">
            <TabsList aria-label="IP 地址分类">
              {(
                [
                  ["all", "全部"],
                  ["public", "外网"],
                  ["private", "内网"],
                  ["other", "其他"],
                ] as const
              ).map(([value, label]) => (
                <TabsTrigger value={value} key={value}>
                  {label}
                  <span>{counts[value]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <label className="host-ip-search">
              <Search />
              <SearchInput
                aria-label="搜索主机 IP 地址"
                placeholder="搜索 IP、网段、网卡"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="复制筛选 IP"
              title={`复制筛选结果（${filtered.length} 个 IP）`}
              disabled={loading || !filtered.length}
              onClick={() => void copy(filtered.map((ip) => ip.ip).join("\n"))}
            >
              <Copy />
            </Button>
          </div>
          {errors.ips ? (
            <p role="alert" className="host-detail-error">
              IP 地址加载失败：{errors.ips}
            </p>
          ) : null}
          <div
            className="host-ip-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="主机 IP 地址表格"
          >
            <table className="host-ip-table">
              <thead>
                <tr>
                  <th>IP 地址</th>
                  <th>类型</th>
                  <th>网段</th>
                  <th>网卡</th>
                  <th>
                    <span className="sr-only">复制</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((ip) => (
                  <tr key={ip.id}>
                    <td>
                      <span className="host-ip-value">{ip.ip}</span>
                      <span className="host-ip-markers">
                        {ip.ip === host.address ? <span>登录</span> : null}
                        {ip.isPrimary ? <span>主地址</span> : null}
                      </span>
                    </td>
                    <td>
                      <span
                        className="host-ip-type"
                        data-ip-type={category(ip)}
                      >
                        {ipTypes[ip.ipType] || ip.ipType}
                      </span>
                    </td>
                    <td>{ip.networkCidr || "—"}</td>
                    <td>{ip.interfaceName || "—"}</td>
                    <td>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`复制地址 ${ip.ip}`}
                        title="复制 IP"
                        onClick={() => void copy(ip.ip)}
                      >
                        <Copy />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length ? (
              <p className="host-ip-empty">
                {loading
                  ? "正在加载网络地址…"
                  : errors.ips
                    ? "地址暂不可用"
                    : keyword
                      ? "没有匹配的 IP"
                      : "暂无绑定 IP"}
              </p>
            ) : null}
          </div>
          <footer className="host-ip-pagination" aria-label="IP 地址分页">
            <span>
              匹配 {filtered.length} 个 / 共 {ips.length} 个
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="上一页 IP"
              title="上一页"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft />
            </Button>
            <span>
              {currentPage} / {pages}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="下一页 IP"
              title="下一页"
              disabled={currentPage === pages}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight />
            </Button>
          </footer>
        </Tabs>
      </section>
    </div>
  );
}
