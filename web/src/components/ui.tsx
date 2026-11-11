// Shared UI primitives (Tailwind). Colours, radii and motion come from the design tokens
// (styles/tokens.css) through the Tailwind theme in styles/app.css.
import { clsx, type ClassValue } from 'clsx'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { twMerge } from 'tailwind-merge'

export const cn = (...v: ClassValue[]) => twMerge(clsx(v))

type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'danger-ghost'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover shadow-[0_1px_2px_rgb(0_0_0/0.14)]',
  secondary: 'border border-line bg-surface text-ink shadow-sm hover:bg-hover hover:border-line-strong',
  ghost: 'text-ink-2 hover:bg-hover hover:text-ink',
  subtle: 'bg-active text-ink hover:bg-[color-mix(in_oklab,var(--bg-active)_100%,var(--bg-hover))]',
  danger: 'bg-danger text-white hover:brightness-110 shadow-[0_1px_2px_rgb(0_0_0/0.14)]',
  'danger-ghost': 'text-danger hover:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)]',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-[12px] gap-1.5 rounded-sm md:h-7',
  md: 'h-9 px-3 text-[13px] gap-1.5 rounded-md md:h-8',
  lg: 'h-11 px-4 text-[14px] gap-2 rounded-md md:h-10',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  trailing?: ReactNode
  block?: boolean
  loading?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'secondary', size = 'md', icon, trailing, block, loading, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,opacity,transform] duration-(--dur-fast) ease-out',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
    >
      {loading ? <Spinner size={size === 'lg' ? 15 : 13} /> : icon}
      {children != null && children !== false && <span className="truncate">{children}</span>}
      {trailing}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  label: string
  size?: Size
  variant?: Variant
  active?: boolean
  /** show the label as a native tooltip (default true) */
  tip?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({ label, size = 'md', variant = 'ghost', active, tip = true, className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={tip ? label : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md',
        'transition-[background-color,color,transform] duration-(--dur-fast) ease-out',
        'active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-8 md:size-6 rounded-sm' : size === 'lg' ? 'size-10 md:size-9' : 'size-9 md:size-7',
        active ? 'bg-accent-soft text-accent' : variant === 'ghost' ? 'text-ink-3 hover:bg-hover hover:text-ink' : VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('shrink-0 animate-spin', className)} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-[3px]', className)}>
      {keys.map((k, i) => (
        <kbd key={k + i} className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-raised px-[5px] text-[10.5px] leading-none font-medium text-ink-3">
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'md',
  label,
}: {
  value: T
  options: { value: T; label?: ReactNode; icon?: ReactNode; title?: string }[]
  onChange: (v: T) => void
  className?: string
  size?: 'sm' | 'md'
  label?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-md border border-line-subtle bg-inset p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            aria-label={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-(--dur-fast) ease-out',
              size === 'sm' ? 'h-7 px-2 text-[12px] md:h-6' : 'h-8 px-3 text-[12.5px] md:h-7',
              on ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--border-subtle)]' : 'text-ink-3 hover:text-ink',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-(--dur-base) ease-out disabled:opacity-45',
        checked ? 'bg-accent' : 'bg-line-strong',
        className,
      )}
    >
      <span
        className={cn(
          'absolute left-[2px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-(--dur-base) ease-spring',
          checked && 'translate-x-[12px]',
        )}
      />
    </button>
  )
}

export const inputClass = cn(
  'w-full rounded-md border border-line bg-surface px-3 text-[13px] text-ink shadow-[inset_0_1px_1px_rgb(0_0_0/0.02)]',
  'transition-[border-color,box-shadow] duration-(--dur-fast) ease-out placeholder:text-ink-4',
  'hover:border-line-strong focus:border-[color-mix(in_oklab,var(--accent)_50%,var(--border-strong))] focus:shadow-[0_0_0_3px_var(--accent-softer)] focus:outline-none',
  'disabled:opacity-60',
)

export function Input({ className, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} {...rest} className={cn(inputClass, 'h-10 md:h-9', className)} />
}

export function Textarea({ className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} {...rest} className={cn(inputClass, 'min-h-20 resize-y py-2 leading-relaxed', className)} />
}

/** A labelled form control. */
export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      {label && <span className="text-[12px] font-medium text-ink-2">{label}</span>}
      {children}
      {hint && <span className="text-[11.5px] leading-relaxed text-ink-3">{hint}</span>}
    </label>
  )
}

/** Small uppercase-style section caption (sidebar groups, settings sections). */
export function Caption({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('flex h-7 items-center justify-between gap-2 px-2 text-[11.5px] font-medium tracking-wide text-ink-4', className)}>
      <span className="truncate">{children}</span>
      {action}
    </div>
  )
}

/** Empty / loading / error placeholder for a page or panel. */
export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex animate-rise flex-col items-center justify-center gap-2 px-6 py-16 text-center', className)}>
      {icon && <div className="mb-1 grid size-11 place-items-center rounded-xl bg-inset text-ink-3 [&_svg]:size-5">{icon}</div>}
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {children && <div className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function Loading({ className, label = '加载中…' }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex animate-fade items-center justify-center gap-2 py-24 text-[12.5px] text-ink-3 [animation-delay:180ms]', className)}>
      <Spinner size={14} />
      {label}
    </div>
  )
}

export type Tone = 'accent' | 'neutral' | 'warn' | 'success' | 'danger'
const TONES: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent',
  neutral: 'bg-active text-ink-3',
  warn: 'bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-warning',
  success: 'bg-[color-mix(in_oklab,var(--success)_13%,transparent)] text-success',
  danger: 'bg-[color-mix(in_oklab,var(--danger)_11%,transparent)] text-danger',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-none font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>
}
