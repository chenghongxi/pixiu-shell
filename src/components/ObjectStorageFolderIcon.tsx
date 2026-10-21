import type { SVGProps } from "react";

// Matches Pixiu object storage's `ri:folder-3-line` directory icon.
export function ObjectStorageFolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M3 3.993C3 3.445 3.455 3 4.002 3H9l2 3h8.998C20.551 6 21 6.456 21 7.002v11.996A1.002 1.002 0 0 1 19.998 20H4.002A1.002 1.002 0 0 1 3 18.998V3.993zM5 5v13h14V8H9.97l-2-3H5z"
      />
    </svg>
  );
}
