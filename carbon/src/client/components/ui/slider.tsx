import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onValueChange,
  ...props
}: SliderPrimitive.Root.Props) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max]
  );

  // base-ui decides the value's shape in two places that disagree for a
  // one-element array: the root treats `[n]` as a range and hands the keyboard
  // path an array, but the control counts thumbs (`values.length > 1`) and hands
  // pointer drags and track presses a bare number. Callers that pass an array
  // naturally expect an array back, so normalize the shape to match the input.
  const arrayShaped = Array.isArray(value ?? defaultValue);
  const handleValueChange = React.useCallback<
    NonNullable<SliderPrimitive.Root.Props['onValueChange']>
  >(
    (next, details) => {
      onValueChange?.(arrayShaped && !Array.isArray(next) ? [next as number] : next, details);
    },
    [onValueChange, arrayShaped]
  );

  return (
    <SliderPrimitive.Root
      className="data-horizontal:w-full data-vertical:h-full"
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      onValueChange={onValueChange ? handleValueChange : undefined}
      {...props}
    >
      <SliderPrimitive.Control
        className={cn(
          'data-vertical:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col',
          className
        )}
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="bg-input/30 border-input border rounded-4xl data-horizontal:h-3 data-horizontal:w-full data-vertical:h-full data-vertical:w-3 relative overflow-hidden select-none"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {/* Key by position, never by value: a value key remounts the thumb on
            every change, dropping its focused input mid-interaction. */}
        {_values.map((_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            // biome-ignore lint/suspicious/noArrayIndexKey: thumbs are positional; the index is their identity
            key={index}
            className="border-primary ring-ring/50 size-4 rounded-4xl border bg-white shadow-sm transition-colors hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
