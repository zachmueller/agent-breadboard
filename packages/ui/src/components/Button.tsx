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
  /** Square and unpadded, for a lone icon (set by IconButton). */
  iconOnly?: boolean;
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
  xs: 'h-6 text-xs gap-1 rounded',
  sm: 'h-7 text-[13px] gap-1.5 rounded-md',
  md: 'h-8 text-sm gap-2 rounded-md',
};

// Padding is chosen here rather than overridden by the caller: `cn` doesn't resolve conflicting
// utilities, and in the generated CSS `px-2.5` comes after (and beats) an appended `px-0`.
const PADDING: Record<ButtonSize, string> = { xs: 'px-2', sm: 'px-2.5', md: 'px-3' };
const SQUARE: Record<ButtonSize, string> = { xs: 'w-6 px-0', sm: 'w-7 px-0', md: 'w-8 px-0' };

export function buttonClasses(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string, iconOnly = false) {
  return cn(
    'inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors',
    'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    VARIANTS[variant],
    SIZES[size],
    iconOnly ? SQUARE[size] : PADDING[size],
    className,
  );
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, trailing, iconOnly, className, children, disabled, type = 'button', ref, ...rest }: ButtonProps) {
  return (
    <button ref={ref} type={type} className={buttonClasses(variant, size, className, iconOnly)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 size={size === 'xs' ? 12 : 14} className="animate-spin" aria-hidden /> : icon}
      {children}
      {trailing}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'iconOnly'> {
  /** Accessible label (required: icon-only buttons need one). */
  label: string;
  children: ReactNode;
}

export function IconButton({ label, size = 'sm', variant = 'ghost', className, children, ...rest }: IconButtonProps) {
  return (
    <Button aria-label={label} title={label} size={size} variant={variant} iconOnly className={className} {...rest}>
      {children}
    </Button>
  );
}
