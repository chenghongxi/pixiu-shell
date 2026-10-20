import { Monitor, TerminalSquare } from "lucide-react";
import type { Host } from "@/lib/api";

export function HostOsIcon({ host }: { host: Host }) {
  const windows = /windows|win server|microsoft/i.test(host.osType ?? "");
  return windows ? (
    <Monitor aria-label="Windows 主机" />
  ) : (
    <TerminalSquare aria-label="Linux/Unix 主机" />
  );
}
