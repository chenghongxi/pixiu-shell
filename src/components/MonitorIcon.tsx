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

// Remix Icon's robot-2-line, also used by Pixiu UI (Apache-2.0).
export function AssistantIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M13.5 2c0 .444-.193.843-.5 1.118V5h5a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h5V3.118A1.5 1.5 0 1 1 13.5 2M6 7a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zm-4 3H0v6h2zm20 0h2v6h-2zM9 14.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m6 0a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3" />
    </svg>
  );
}
