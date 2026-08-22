import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';
import { SparkBurst } from '../effects/SparkBurst';

const buttonVariants = cva(
  "cursor-pointer focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-4xl border border-transparent text-sm leading-none font-medium focus-visible:ring-[3px] aria-invalid:ring-[3px] [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all disabled:cursor-default [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none",
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:brightness-115',
        exciting:
          'relative overflow-visible border-transparent bg-primary text-primary-foreground hover:brightness-115',
        outline:
          'border-border! bg-input/30 hover:bg-input/60 hover:border-border/80 hover:text-foreground hover:brightness-125 aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:brightness-125 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'border-transparent hover:bg-foreground/8 hover:text-foreground dark:hover:brightness-125 aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive:
          'border-transparent bg-destructive/10 hover:bg-destructive/25 hover:brightness-115 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40',
        link: 'border-transparent text-primary underline-offset-4 hover:underline hover:brightness-115',
        // Launch UI marketing blocks use this glass "glow" variant (glass-* from launch-ui.css).
        glow: 'glass-4 hover:glass-5 shadow-md',
      },
      size: {
        default:
          'h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5',
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        lg: 'h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        icon: 'size-9',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  children,
  onMouseEnter,
  onClick,
  asChild = false,
  sparkle = false,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Add spark burst effect on hover and click */
    sparkle?: boolean;
  }) {
  const [sparkTrigger, setSparkTrigger] = React.useState(0);
  const hasSparkle = variant === 'exciting' || sparkle;

  const handleMouseEnter = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (hasSparkle) setSparkTrigger((t) => t + 1);
      if (onMouseEnter) (onMouseEnter as (e: React.MouseEvent<HTMLButtonElement>) => void)(e);
    },
    [hasSparkle, onMouseEnter]
  );

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (hasSparkle) setSparkTrigger((t) => t + 1);
      if (onClick) (onClick as (e: React.MouseEvent<HTMLButtonElement>) => void)(e);
    },
    [hasSparkle, onClick]
  );

  // Support Radix-style asChild: when true and children is a single React element,
  // use that element as Base UI's render prop (it becomes the root element with
  // button styles applied), and its children become the button's children.
  let resolvedRender = props.render;
  let resolvedChildren = children;
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      children?: React.ReactNode;
      [key: string]: unknown;
    }>;
    const { children: innerChildren, ...childProps } = child.props;
    resolvedRender = React.createElement(child.type as string | React.ComponentType, childProps);
    resolvedChildren = innerChildren as React.ReactNode;
  }

  return (
    <ButtonPrimitive
      data-slot="button"
      // A render element (via asChild or render) is typically an <a>/<Link>,
      // not a native <button>; Base UI needs to know so it adds button
      // semantics (role, keyboard activation) instead of warning. An explicit
      // nativeButton in props still wins via the spread below.
      nativeButton={!resolvedRender}
      className={cn(
        buttonVariants({ variant, size, className }),
        hasSparkle && 'relative overflow-visible'
      )}
      {...props}
      onMouseEnter={handleMouseEnter}
      onClick={handleClick}
      render={resolvedRender}
    >
      {resolvedChildren}
      {hasSparkle && (
        <SparkBurst delay={0.05} count={10} palette="primary" trigger={sparkTrigger} />
      )}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
