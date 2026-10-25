import type { SVGProps } from "react";

// Matches Pixiu cluster list's monitor icon (three rising bars), scaled 1.5x
// from its 16x16 source so it lines up with the 24x24 lucide icons around it.
export function MonitorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="1.5" y="15" width="2.25" height="7.5" rx="1.125" />
      <rect x="9.75" y="4.5" width="2.25" height="18" rx="1.125" />
      <rect x="18" y="10.5" width="2.25" height="12" rx="1.125" />
    </svg>
  );
}
