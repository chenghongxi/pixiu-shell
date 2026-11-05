import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label,
  className,
  disabled,
  children,
  onEmpty,
}: {
  value: string;
  label: string;
  className?: string;
  disabled?: boolean;
  children?: ReactNode;
  onEmpty?: () => void;
}) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    if (!value && onEmpty) {
      onEmpty();
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current) return;
      setCopiedValue(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiedValue(null), 1800);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const copied = copiedValue !== null && copiedValue === value;
  const text = copied ? "已复制" : label;
  return (
    <button
      type="button"
      className={cn("copy-button", className)}
      aria-label={text}
      data-copied={copied}
      disabled={disabled}
      onClick={() => void copy()}
    >
      {children}
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}
