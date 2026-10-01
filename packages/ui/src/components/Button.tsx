import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Leading icon element (e.g. `<Play size={14} />`). */
  icon?: ReactNode;
  trailing?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent shadow-sm',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-hover shadow-[0_1px_0_rgba(0,0,0,0.03)]',
  ghost: 'bg-transparent text-fg-muted hover:text-fg hover:bg-hover border border-transparent',
  subtle: 'bg-raised text-fg hover:bg-hover border border-transparent',
  danger: 'bg-danger text-white hover:opacity-90 border border-transparent shadow-sm',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded',
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-2 rounded-md',
};

export function buttonClasses(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string) {
  return cn(
    'inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors',
    'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, trailing, className, children, disabled, type = 'button', ref, ...rest }: ButtonProps) {
  return (
    <button ref={ref} type={type} className={buttonClasses(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 size={size === 'xs' ? 12 : 14} className="animate-spin" aria-hidden /> : icon}
      {children}
      {trailing}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  /** Accessible label (required: icon-only buttons need one). */
  label: string;
  children: ReactNode;
}

export function IconButton({ label, size = 'sm', variant = 'ghost', className, children, ...rest }: IconButtonProps) {
  const dim = size === 'xs' ? 'w-6 px-0' : size === 'sm' ? 'w-7 px-0' : 'w-8 px-0';
  return (
    <Button aria-label={label} title={label} size={size} variant={variant} className={cn(dim, className)} {...rest}>
      {children}
    </Button>
  );
}
