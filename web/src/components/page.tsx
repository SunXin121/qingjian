// Layout pieces shared by the list-style pages (home, knowledge base, trash, shares,
// settings): the centred body, section headings, row lists and header breadcrumbs.
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { IconChevron } from './icons'
import { cn } from './ui'

export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className={cn('mx-auto w-full animate-rise px-4 pt-6 pb-24 md:px-8 md:pt-10', wide ? 'max-w-[1080px]' : 'max-w-[920px]', className)}>
      {children}
    </div>
  )
}

export function PageTitle({ children, sub, className }: { children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-6', className)}>
      <h1 className="m-0 text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink md:text-[24px]">{children}</h1>
      {sub && <p className="mt-1.5 mb-0 text-[13px] text-ink-3">{sub}</p>}
    </div>
  )
}

export function Section({ title, icon, count, action, children, className }: { title: ReactNode; icon?: ReactNode; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-9 first:mt-0', className)}>
      <div className="mb-3 flex items-center gap-2">
        {icon && <span className="text-ink-3 [&_svg]:size-4">{icon}</span>}
        <h2 className="m-0 text-[13.5px] font-semibold text-ink">{title}</h2>
        {!!count && <span className="tabular rounded-full bg-active px-1.5 py-px text-[11px] font-medium text-ink-3">{count}</span>}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}

/** Bordered list of rows (recent documents, trash, shares). */
export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-card', className)}>{children}</div>
}

export const rowClass = cn(
  'group flex min-h-12 items-center gap-3 px-3.5 py-2 text-[13px] text-ink transition-colors duration-(--dur-fast)',
  'border-b border-line-subtle last:border-b-0 hover:bg-hover',
)

/** The small icon tile at the start of a row. */
export function RowIcon({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-[15px]',
        accent ? 'bg-accent-softer text-accent' : 'bg-inset text-ink-3 group-hover:text-ink-2',
      )}
    >
      {children}
    </span>
  )
}

/** Header breadcrumbs: links for the ancestors, plain text for the current page. */
export function Crumb({ to, icon, children, current }: { to?: string; icon?: ReactNode; children: ReactNode; current?: boolean }) {
  const inner = (
    <>
      {icon}
      <span className="truncate">{children}</span>
    </>
  )
  if (to)
    return (
      <>
        <Link
          to={to}
          className="-ml-1 inline-flex max-w-[30vw] min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink md:max-w-[220px]"
        >
          {inner}
        </Link>
        <IconChevron width={13} height={13} className="shrink-0 text-ink-4 max-md:hidden" />
      </>
    )
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 truncate px-0.5', current ? 'max-w-[280px] font-semibold text-ink max-md:hidden' : 'font-medium text-ink-2')}>
      {inner}
    </span>
  )
}
