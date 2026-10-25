use crate::storage::LocalHost;
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use ssh2::Session;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
};

/// Reads /proc twice one second apart so CPU load and network rates are deltas
/// instead of boot-time counters. Runs through `sh` on stdin to keep the script
/// free of shell quoting pitfalls.
const PROBE_SCRIPT: &str = r#"
c() { awk '/^cpu /{printf "%d %d", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }
n() { awk 'NR>2{gsub(/:/,""); if($1!="lo"){r+=$2; t+=$10}} END{printf "%d %d", r+0, t+0}' /proc/net/dev; }
m() { awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} END{printf "%d %d %d", t+0, (t-a)+0, a+0}' /proc/meminfo; }
s() { awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{printf "%d %d", t+0, (t-f)+0}' /proc/meminfo; }
d() { df -Pk 2>/dev/null | awk 'NR>1 {if($1 ~ /^\/dev\//){t+=$2; u+=$3; f=1} else if(!f && $6=="/"){t=$2; u=$3}} END{printf "%d %d", t+0, u+0}'; }
a=$(c); b=$(n); sleep 1; a2=$(c); b2=$(n)
set -- $a $a2 $b $b2
dt=$(( $3 - $1 )); di=$(( $4 - $2 ))
cpu=$(awk -v dt="$dt" -v di="$di" 'BEGIN{if(dt<=0){print 0} else {printf "%.1f", (dt-di)*100/dt}}')
rx=$(( $7 - $5 )); tx=$(( $8 - $6 ))
if [ "$rx" -lt 0 ]; then rx=0; fi
if [ "$tx" -lt 0 ]; then tx=0; fi
up=$(awk '{printf "%.0f", $1}' /proc/uptime)
read -r l1 l5 l15 _ < /proc/loadavg
cores=$(nproc 2>/dev/null)
if [ -z "$cores" ]; then cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null); fi
case "$cores" in ''|*[!0-9]*|0) cores=1 ;; esac
printf "uptime=%s load1=%s load5=%s load15=%s cores=%s cpu=%s memTotal=%s memUsed=%s memAvailable=%s swapTotal=%s swapUsed=%s diskTotal=%s diskUsed=%s netRx=%s netTx=%s netRxTotal=%s netTxTotal=%s\n" \
  "$up" "$l1" "$l5" "$l15" "$cores" "$cpu" $(m) $(s) $(d) "$rx" "$tx" "$7" "$8"
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostMetrics {
    uptime_secs: f64,
    load1: f64,
    load5: f64,
    load15: f64,
    cores: u32,
    cpu_percent: f64,
    mem_total_kb: u64,
    mem_used_kb: u64,
    mem_available_kb: u64,
    swap_total_kb: u64,
    swap_used_kb: u64,
    disk_total_kb: u64,
    disk_used_kb: u64,
    net_rx_bytes_per_sec: f64,
    net_tx_bytes_per_sec: f64,
    net_rx_total_bytes: u64,
    net_tx_total_bytes: u64,
}

pub(crate) struct Probe {
    pub session: Session,
    pub metrics: HostMetrics,
}

/// Samples one host, reusing the cached session when it still answers.
pub(crate) fn probe(
    cached: Option<Session>,
    host: &LocalHost,
    known_hosts: &Path,
) -> Result<Probe> {
    if let Some(session) = cached {
        if let Ok(output) = exec(&session) {
            return Ok(Probe {
                session,
                metrics: parse(&output)?,
            });
        }
    }
    let session = crate::files::connect_session(host, known_hosts, None, None)?;
    let output = exec(&session).context("远程采集失败")?;
    Ok(Probe {
        session,
        metrics: parse(&output)?,
    })
}

fn exec(session: &Session) -> Result<String> {
    let mut channel = session.channel_session().context("无法打开 SSH 通道")?;
    channel.exec("sh").context("无法启动远程 shell")?;
    channel.write_all(PROBE_SCRIPT.as_bytes())?;
    channel.send_eof()?;
    let mut stdout = String::new();
    channel.read_to_string(&mut stdout)?;
    let mut stderr = String::new();
    channel.stderr().read_to_string(&mut stderr)?;
    channel.wait_close()?;
    let code = channel.exit_status()?;
    ensure!(
        code == 0,
        "远程采集命令失败（退出码 {}）：{}",
        code,
        stderr.trim()
    );
    stdout
        .lines()
        .rfind(|line| line.contains('='))
        .map(str::to_string)
        .context("远程主机未返回监控指标，目前仅支持 Linux 主机")
}

fn parse(line: &str) -> Result<HostMetrics> {
    let fields: HashMap<&str, &str> = line
        .split_whitespace()
        .filter_map(|field| field.split_once('='))
        .collect();
    ensure!(fields.contains_key("cpu"), "监控指标字段缺失");
    let number = |key: &str| -> f64 {
        fields
            .get(key)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let size = |key: &str| -> u64 { number(key).max(0.0) as u64 };
    Ok(HostMetrics {
        uptime_secs: number("uptime"),
        load1: number("load1"),
        load5: number("load5"),
        load15: number("load15"),
        cores: number("cores").max(1.0) as u32,
        cpu_percent: number("cpu"),
        mem_total_kb: size("memTotal"),
        mem_used_kb: size("memUsed"),
        mem_available_kb: size("memAvailable"),
        swap_total_kb: size("swapTotal"),
        swap_used_kb: size("swapUsed"),
        disk_total_kb: size("diskTotal"),
        disk_used_kb: size("diskUsed"),
        net_rx_bytes_per_sec: number("netRx"),
        net_tx_bytes_per_sec: number("netTx"),
        net_rx_total_bytes: size("netRxTotal"),
        net_tx_total_bytes: size("netTxTotal"),
    })
}
