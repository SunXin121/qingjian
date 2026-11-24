// Layout pieces shared by the list-style pages (home, knowledge base, trash, shares,
// settings): the centred body, section headings, row lists and header breadcrumbs.
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { IconChevron } from './icons'
import { cn } from './ui'

export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={cn('mx-auto w-full animate-rise px-4 pt-6 pb-24 outline-none md:px-8 md:pt-10', wide ? 'max-w-[1080px]' : 'max-w-[940px]', className)}
    >
      {children}
    </main>
  )
}

export function PageTitle({ children, sub, action, className }: { children: ReactNode; sub?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink md:text-[25px]">{children}</h1>
        {sub && <p className="mt-1.5 mb-0 max-w-2xl text-[13px] leading-relaxed text-ink-3">{sub}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

export function Section({ title, icon, count, action, children, className }: { title: ReactNode; icon?: ReactNode; count?: number; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-9 first:mt-0', className)}>
      <div className="mb-3 flex min-h-7 flex-wrap items-center gap-2">
        {icon && <span className="flex shrink-0 text-ink-3 [&_svg]:size-4">{icon}</span>}
        <h2 className="m-0 text-[13.5px] leading-6 font-semibold tracking-[-0.005em] text-ink">{title}</h2>
        {!!count && <span className="tabular rounded-full bg-active px-2 py-0.5 text-[11px] font-medium text-ink-3">{count}</span>}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}

/** Bordered list of rows (recent documents, trash, shares). */
export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-xl border border-line-subtle bg-surface shadow-card', className)}>{children}</div>
}

export const rowClass = cn(
  'group flex min-h-12 items-center gap-3 px-4 py-2.5 text-[13px] text-ink transition-colors duration-(--dur-fast)',
  'border-b border-line-subtle last:border-b-0 hover:bg-hover',
)

/** The small icon tile at the start of a row. */
export function RowIcon({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-(--dur-fast) [&_svg]:size-[15px]',
        accent ? 'bg-accent-softer text-accent' : 'bg-inset text-ink-3 group-hover:bg-active group-hover:text-ink-2',
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
          className="-ml-1 inline-flex max-w-[32vw] min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink md:max-w-[200px]"
        >
          {inner}
        </Link>
        <IconChevron width={13} height={13} className="shrink-0 text-ink-4 max-md:hidden" />
      </>
    )
  return (
    <span
      aria-current={current ? 'page' : undefined}
      className={cn('inline-flex min-w-0 items-center gap-1.5 truncate px-0.5', current ? 'max-w-[280px] font-semibold text-ink max-md:hidden' : 'font-semibold text-ink')}
    >
      {inner}
    </span>
  )
}
