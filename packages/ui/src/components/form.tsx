import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

const control =
  'w-full rounded-md border border-line-strong bg-surface text-fg placeholder:text-fg-subtle ' +
  'focus:outline-none focus-visible:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed aria-[invalid=true]:border-danger';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  /** Render label inline to the left. */
  inline?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label + hint + error wrapper; passes ids to the control for proper association. */
export function Field({ label, hint, error, required, className, inline, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn(inline ? 'flex items-center gap-3' : 'flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={id} className="text-[13px] font-medium text-fg-muted">
          {label}
          {required && <span className="text-danger-fg"> *</span>}
        </label>
      )}
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-fg-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-xs text-danger-fg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type Labelled = { label?: ReactNode; hint?: ReactNode; error?: ReactNode; wrapperClassName?: string };

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, Labelled {
  size?: 'sm' | 'md';
  leading?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ label, hint, error, wrapperClassName, className, size = 'md', leading, ref, required, ...rest }: InputProps) {
  const render = (ids?: { id: string; describedBy?: string; invalid: boolean }) => (
    <div className="relative flex items-center">
      {leading && <span className="pointer-events-none absolute left-2.5 flex text-fg-subtle">{leading}</span>}
      <input
        ref={ref}
        id={ids?.id ?? rest.id}
        aria-describedby={ids?.describedBy}
        aria-invalid={ids?.invalid || undefined}
        required={required}
        className={cn(control, size === 'sm' ? 'h-7 px-2 text-[13px]' : 'h-8 px-2.5 text-sm', leading ? (size === 'sm' ? 'pl-7' : 'pl-8') : '', className)}
        {...rest}
      />
    </div>
  );
  if (!label && !hint && !error) return render();
  return (
    <Field label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      {(ids) => render(ids)}
    </Field>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, Labelled {
  mono?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({ label, hint, error, wrapperClassName, className, mono, ref, required, ...rest }: TextAreaProps) {
  const render = (ids?: { id: string; describedBy?: string; invalid: boolean }) => (
    <textarea
      ref={ref}
      id={ids?.id ?? rest.id}
      aria-describedby={ids?.describedBy}
      aria-invalid={ids?.invalid || undefined}
      required={required}
      className={cn(control, 'min-h-20 px-2.5 py-2 text-sm leading-relaxed', mono && 'font-mono text-[12.5px]', className)}
      {...rest}
    />
  );
  if (!label && !hint && !error) return render();
  return (
    <Field label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      {(ids) => render(ids)}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>, Labelled {
  options?: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ label, hint, error, wrapperClassName, className, options, placeholder, size = 'md', children, ref, required, ...rest }: SelectProps) {
  const render = (ids?: { id: string; describedBy?: string; invalid: boolean }) => (
    <div className="relative flex items-center">
      <select
        ref={ref}
        id={ids?.id ?? rest.id}
        aria-describedby={ids?.describedBy}
        aria-invalid={ids?.invalid || undefined}
        required={required}
        className={cn(control, 'appearance-none pr-7', size === 'sm' ? 'h-7 pl-2 text-[13px]' : 'h-8 pl-2.5 text-sm', className)}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2 text-fg-subtle" aria-hidden />
    </div>
  );
  if (!label && !hint && !error) return render();
  return (
    <Field label={label} hint={hint} error={error} required={required} className={wrapperClassName}>
      {(ids) => render(ids)}
    </Field>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, ...rest }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input id={rest.id ?? id} type="checkbox" className="mt-0.5 size-3.5 rounded border-line-strong accent-[var(--bb-accent)]" {...rest} />
      <label htmlFor={rest.id ?? id} className="text-sm leading-tight">
        <span className="text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-fg-subtle">{description}</span>}
      </label>
    </div>
  );
}
