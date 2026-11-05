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
# Whole disks only: partitions repeat their parent's counters, and loop/ram/sr
# devices are not real IO. Columns 6 and 10 are sectors read and written,
# and a sector is 512 bytes.
i() { awk '$3 ~ /^(sd|vd|xvd|hd)[a-z]+$/ || $3 ~ /^nvme[0-9]+n[0-9]+$/ {r+=$6; w+=$10} END{printf "%d %d", r*512, w*512}' /proc/diskstats 2>/dev/null || printf "0 0"; }
# /proc/net/tcp6 is absent when IPv6 is disabled, so cat feeds awk whatever
# exists. Column 4 is the two-digit hex state, which also filters both headers.
t() { cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4 ~ /^[0-9A-Fa-f][0-9A-Fa-f]$/ {c[$4]++} END{n=0; for(k in c) n+=c[k]; printf "%d %d %d %d %d", c["01"]+0, c["06"]+0, c["08"]+0, c["0A"]+0, n-c["0A"]+0}'; }
a=$(c); b=$(n); e=$(i); sleep 1; a2=$(c); b2=$(n); e2=$(i)
set -- $a $a2 $b $b2 $e $e2 $(t)
dt=$(( $3 - $1 )); di=$(( $4 - $2 ))
cpu=$(awk -v dt="$dt" -v di="$di" 'BEGIN{if(dt<=0){print 0} else {printf "%.1f", (dt-di)*100/dt}}')
rx=$(( $7 - $5 )); tx=$(( $8 - $6 ))
if [ "$rx" -lt 0 ]; then rx=0; fi
if [ "$tx" -lt 0 ]; then tx=0; fi
# Beyond $9 a bare $10 means ${1}0, so the double digits need braces.
dr=$(( ${11} - ${9} )); dw=$(( ${12} - ${10} ))
if [ "$dr" -lt 0 ]; then dr=0; fi
if [ "$dw" -lt 0 ]; then dw=0; fi
tcpEst=${13}; tcpTw=${14}; tcpCw=${15}; tcpLs=${16}; tcpAll=${17}
up=$(awk '{printf "%.0f", $1}' /proc/uptime)
read -r l1 l5 l15 _ < /proc/loadavg
cores=$(nproc 2>/dev/null)
if [ -z "$cores" ]; then cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null); fi
case "$cores" in ''|*[!0-9]*|0) cores=1 ;; esac
printf "uptime=%s load1=%s load5=%s load15=%s cores=%s cpu=%s memTotal=%s memUsed=%s memAvailable=%s swapTotal=%s swapUsed=%s diskTotal=%s diskUsed=%s netRx=%s netTx=%s netRxTotal=%s netTxTotal=%s diskRead=%s diskWrite=%s tcpEstablished=%s tcpTimeWait=%s tcpCloseWait=%s tcpListen=%s tcpTotal=%s\n" \
  "$up" "$l1" "$l5" "$l15" "$cores" "$cpu" $(m) $(s) $(d) "$rx" "$tx" "$7" "$8" \
  "$dr" "$dw" "$tcpEst" "$tcpTw" "$tcpCw" "$tcpLs" "$tcpAll"
printf '__PIXIU_PROCESSES__\n'
(LC_ALL=C ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,args= --sort=-pcpu 2>/dev/null || printf '__PIXIU_PROCESS_UNAVAILABLE__\n') |
  awk 'NR <= 200 { print substr($0, 1, 512) }'
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessMetrics {
    pid: u32,
    user: String,
    cpu_percent: f64,
    memory_percent: f64,
    rss_kb: u64,
    state: String,
    command: String,
}

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
    disk_read_bytes_per_sec: f64,
    disk_write_bytes_per_sec: f64,
    tcp_established: u32,
    tcp_time_wait: u32,
    tcp_close_wait: u32,
    tcp_listen: u32,
    tcp_total: u32,
    processes: Option<Vec<ProcessMetrics>>,
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
    let session = crate::ssh::connect_session(host, known_hosts, None, None, None)?;
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
    Ok(stdout)
}

fn parse(output: &str) -> Result<HostMetrics> {
    let line = output
        .lines()
        .find(|line| line.starts_with("uptime="))
        .context("远程主机未返回监控指标，目前仅支持 Linux 主机")?;
    let processes = output.split_once("__PIXIU_PROCESSES__\n").and_then(|(_, lines)| {
        if lines.lines().any(|line| line == "__PIXIU_PROCESS_UNAVAILABLE__") {
            return None;
        }
        Some(lines.lines().filter_map(parse_process).collect())
    });
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
        disk_read_bytes_per_sec: number("diskRead"),
        disk_write_bytes_per_sec: number("diskWrite"),
        tcp_established: size("tcpEstablished") as u32,
        tcp_time_wait: size("tcpTimeWait") as u32,
        tcp_close_wait: size("tcpCloseWait") as u32,
        tcp_listen: size("tcpListen") as u32,
        tcp_total: size("tcpTotal") as u32,
        processes,
    })
}

fn parse_process(line: &str) -> Option<ProcessMetrics> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse::<u32>().ok()?;
    let user = fields.next()?.to_owned();
    let cpu_percent = fields.next()?.parse::<f64>().ok()?;
    let memory_percent = fields.next()?.parse::<f64>().ok()?;
    let rss_kb = fields.next()?.parse::<u64>().ok()?;
    let state = fields.next()?.to_owned();
    let command = fields.collect::<Vec<_>>().join(" ");
    if pid == 0 || !cpu_percent.is_finite() || !memory_percent.is_finite() {
        return None;
    }
    Some(ProcessMetrics {
        pid,
        user,
        cpu_percent,
        memory_percent,
        rss_kb,
        state,
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_process_fields_and_command() {
        let process = parse_process(" 42 root 12.5 1.2 2048 S /usr/bin/app --name=a b").unwrap();
        assert_eq!(process.pid, 42);
        assert_eq!(process.cpu_percent, 12.5);
        assert_eq!(process.rss_kb, 2048);
        assert_eq!(process.command, "/usr/bin/app --name=a b");
        assert!(parse_process("bad input").is_none());
        assert!(parse_process("42 root NaN 1.2 2048 S app").is_none());
    }

    #[test]
    fn process_collection_failure_does_not_hide_host_metrics() {
        let metrics = parse("uptime=1 cpu=1\n__PIXIU_PROCESSES__\n__PIXIU_PROCESS_UNAVAILABLE__\n").unwrap();
        assert!(metrics.processes.is_none());
        let metrics = parse("uptime=1 cpu=1\n__PIXIU_PROCESSES__\n42 root 1.0 0.1 2048 S app --flag=value\n").unwrap();
        assert_eq!(metrics.processes.unwrap()[0].pid, 42);
    }
}
