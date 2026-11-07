import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export function Choice({
  value,
  onChange,
  options,
  label,
  disabled,
  placeholder,
  triggerClassName,
  contentClassName,
  contentPosition,
  displayValue,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  contentClassName?: string;
  contentPosition?: "item-aligned" | "popper";
  displayValue?: string;
}) {
  return (
    <Select disabled={disabled} value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className={["w-full", triggerClassName].filter(Boolean).join(" ")}
      >
        <SelectValue placeholder={placeholder}>{displayValue || undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent className={contentClassName} position={contentPosition}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
