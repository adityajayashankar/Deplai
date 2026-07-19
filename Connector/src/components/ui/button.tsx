import * as React from 'react';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  variant?: 'default' | 'outline';
  size?: 'sm' | 'lg';
};

/**
 * Small landing-page button primitive. `asChild` keeps the semantic anchor
 * element for links such as the GitHub OAuth entry point.
 */
export function Button({
  asChild = false,
  className = '',
  variant = 'default',
  size,
  children,
  ...props
}: ButtonProps) {
  const baseClassName = [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 disabled:pointer-events-none disabled:opacity-50',
    variant === 'outline' ? 'border border-foreground/20 bg-transparent' : '',
    size === 'sm' ? 'h-8 px-3 text-xs' : '',
    size === 'lg' ? 'h-10 px-6 text-sm' : '',
    className,
  ].filter(Boolean).join(' ');

  if (asChild && React.isValidElement<{ className?: string }>(children)) {
    return React.cloneElement(children, {
      className: [baseClassName, children.props.className].filter(Boolean).join(' '),
    });
  }

  return (
    <button className={baseClassName} {...props}>
      {children}
    </button>
  );
}
