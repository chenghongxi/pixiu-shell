import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Slider({
  className,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("slider-root", className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="slider-track"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="slider-range"
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        className="slider-thumb"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
