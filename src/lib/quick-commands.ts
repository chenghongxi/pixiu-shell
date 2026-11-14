export interface QuickCommandTemplate {
  command: string;
  description: string;
  os: "unix" | "windows" | "all";
}

const QUICK_COMMAND_TEMPLATES: QuickCommandTemplate[] = [
  // File, archive, search, and log viewing
  { command: "ls -lh", description: "文件大小详情", os: "unix" },
  { command: "ls -lht", description: "按修改时间倒序", os: "unix" },
  { command: "ls -lah", description: "含隐藏文件详情", os: "unix" },
  { command: "df -hT", description: "磁盘容量与文件系统", os: "unix" },
  { command: "du -sh * | sort -rh | head -n 20", description: "目录占用前 20", os: "unix" },
  { command: "free -h", description: "内存使用概览", os: "unix" },
  { command: "tail -f -n 200 ", description: "追踪末尾 200 行日志", os: "unix" },
  { command: "less +F ", description: "实时滚动查看日志", os: "unix" },
  { command: "grep -rn \"\" .", description: "递归搜索文本", os: "unix" },
  { command: "grep -rnE \"\" .", description: "递归正则搜索", os: "unix" },
  { command: "find . -name \"*.log\" -mtime -1", description: "查找 1 天内日志", os: "unix" },
  { command: "find . -type f -size +100M", description: "查找大于 100M 文件", os: "unix" },
  { command: "tar -czvf archive.tar.gz ", description: "打包 gzip 压缩", os: "unix" },
  { command: "tar -xzvf ", description: "解压 .tar.gz", os: "unix" },
  { command: "tar -tzvf ", description: "预览压缩包内容", os: "unix" },
  { command: "chmod +x ", description: "赋予可执行权限", os: "unix" },
  { command: "rsync -avz --progress ", description: "增量同步传输", os: "unix" },

  // Process, system, and systemd
  { command: "ps aux --sort=-%mem | head -n 20", description: "内存占用前 20 进程", os: "unix" },
  { command: "ps aux --sort=-%cpu | head -n 20", description: "CPU 占用前 20 进程", os: "unix" },
  { command: "ps -ef | grep ", description: "按名称筛选进程", os: "unix" },
  { command: "top -H -p ", description: "查看进程内线程", os: "unix" },
  { command: "uptime", description: "运行时间与负载", os: "unix" },
  { command: "uname -a", description: "内核与系统架构", os: "unix" },
  { command: "systemctl status ", description: "查看服务状态", os: "unix" },
  { command: "systemctl restart ", description: "重启系统服务", os: "unix" },
  { command: "systemctl daemon-reload", description: "重载 unit 配置", os: "unix" },
  { command: "systemctl list-units --type=service --state=failed", description: "查看失败服务", os: "unix" },
  { command: "journalctl -xe --no-pager", description: "查看最近系统报错", os: "unix" },
  { command: "journalctl -u  -n 200 -f", description: "追踪指定服务日志", os: "unix" },
  { command: "journalctl --since \"1 hour ago\" --no-pager", description: "近 1 小时日志", os: "unix" },

  // Network and HTTP diagnostics
  { command: "ss -tulnp", description: "监听端口与进程", os: "unix" },
  { command: "ss -s", description: "Socket 连接统计", os: "unix" },
  { command: "netstat -tulnp", description: "监听端口与进程", os: "unix" },
  { command: "lsof -i :", description: "查看端口占用进程", os: "unix" },
  { command: "ip addr show", description: "查看网卡与 IP", os: "unix" },
  { command: "ip route show", description: "查看路由表", os: "unix" },
  { command: "tcpdump -i any -nn port ", description: "按端口抓包", os: "unix" },
  { command: "curl -iL ", description: "输出响应头并跟随跳转", os: "all" },
  {
    command: "curl -sS -o /dev/null -w \"%{http_code} %{time_total}s\\n\" ",
    description: "测试状态码与耗时",
    os: "unix",
  },
  { command: "nginx -t", description: "校验 Nginx 配置", os: "unix" },
  { command: "nginx -s reload", description: "热加载 Nginx", os: "unix" },

  // Docker and Kubernetes
  { command: "docker ps -a", description: "查看全部容器", os: "all" },
  {
    command: "docker ps -a --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\"",
    description: "精简表格列容器",
    os: "all",
  },
  { command: "docker logs -f --tail 200 ", description: "追踪容器最近 200 行", os: "all" },
  { command: "docker exec -it  /bin/sh", description: "进入容器 sh", os: "all" },
  { command: "docker exec -it  /bin/bash", description: "进入容器 bash", os: "all" },
  { command: "docker stats --no-stream", description: "容器资源瞬时快照", os: "all" },
  { command: "docker system df", description: "Docker 磁盘占用", os: "all" },
  { command: "docker compose ps", description: "Compose 服务状态", os: "all" },
  { command: "docker compose up -d", description: "后台启动 Compose", os: "all" },
  { command: "docker compose logs -f --tail 100", description: "追踪 Compose 日志", os: "all" },
  { command: "kubectl get pods -A", description: "全部命名空间 Pod", os: "all" },
  { command: "kubectl get pods -o wide", description: "Pod 节点与 IP", os: "all" },
  { command: "kubectl describe pod ", description: "查看 Pod 事件详情", os: "all" },
  { command: "kubectl logs -f --tail=200 ", description: "追踪 Pod 日志", os: "all" },
  { command: "kubectl exec -it  -- /bin/sh", description: "进入 Pod 终端", os: "all" },
  { command: "kubectl top pods -A", description: "Pod CPU/内存排行", os: "all" },

  // Git
  { command: "git status -sb", description: "精简分支与状态", os: "all" },
  { command: "git log --oneline -n 20", description: "最近 20 条提交", os: "all" },
  { command: "git pull --rebase", description: "变基拉取更新", os: "all" },
  { command: "git diff --stat", description: "改动文件统计", os: "all" },

  // Windows local shell (PowerShell / cmd)
  {
    command: "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15",
    description: "内存占用前 15 进程",
    os: "windows",
  },
  {
    command: "Get-Service | Where-Object Status -eq 'Running'",
    description: "查看运行中服务",
    os: "windows",
  },
  { command: "netstat -ano | findstr :", description: "查看端口占用 PID", os: "windows" },
  { command: "ipconfig /all", description: "网络适配器详情", os: "windows" },
  { command: "Test-NetConnection -Port ", description: "测试主机端口连通", os: "windows" },
  { command: "Get-ChildItem -Force", description: "含隐藏文件列表", os: "windows" },
];

export function getQuickCommands(options?: {
  isWindowsShell?: boolean;
  includeTransfer?: boolean;
  uploadCommand?: string;
  downloadCommand?: string;
}): Array<{ command: string; description: string }> {
  const targetOs = options?.isWindowsShell ? "windows" : "unix";
  const items: Array<{ command: string; description: string }> = [];

  if (options?.includeTransfer) {
    const upload = (options.uploadCommand || "cl-u").trim();
    const download = (options.downloadCommand || "cl-d").trim();
    if (upload) {
      items.push({
        command: `${upload} .`,
        description: "快捷上传到当前目录",
      });
    }
    if (download) {
      items.push({
        command: `${download} `,
        description: "快捷下载远端文件",
      });
    }
  }

  for (const item of QUICK_COMMAND_TEMPLATES) {
    if (item.os === "all" || item.os === targetOs) {
      items.push({ command: item.command, description: item.description });
    }
  }

  return items;
}
