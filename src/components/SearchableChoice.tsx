import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";

export function SearchableChoice({
  value,
  options,
  label,
  onChange,
  disabled,
  onCreate,
}: {
  value: string;
  options: { value: string; label: string }[];
  label: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onCreate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      modal
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className="searchable-choice-trigger"
        >
          <span>{selected?.label ?? "请选择"}</span>
          <ChevronDown />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={5}
          className="searchable-choice-content"
          style={{
            zIndex: 120,
            width: "min(360px, calc(100vw - 32px))",
            maxHeight: "min(420px, 60dvh)",
            overflow: "hidden",
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="searchable-choice-search">
            <Search />
            <SearchInput
              autoFocus
              aria-label={`搜索${label}`}
              placeholder={`搜索${label}…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div
            className="searchable-choice-list"
            role="listbox"
            aria-label={label}
          >
            {filtered.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.value === value ? <Check /> : null}
              </button>
            ))}
            {!filtered.length ? <p>没有匹配的{label}</p> : null}
          </div>
          {onCreate ? (
            <button
              type="button"
              className="searchable-choice-create"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              <Plus />
              新建{label}
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
