import type { ReactNode } from 'react'
import { useStore, useStoreUI } from '../store'
import { IconMenu, IconSidebarOpen } from './icons'
import { cn, IconButton } from './ui'

/** Sticky page header; carries the mobile drawer toggle and desktop sidebar expand button. */
export default function PageHeader({ children, className }: { children?: ReactNode; className?: string }) {
  const { setSidebarOpen, setSidebarCollapsed } = useStore()
  const { sidebarCollapsed } = useStoreUI()
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-[calc(var(--header-h)+var(--safe-t))] shrink-0 items-center gap-1 border-b border-line-subtle px-2 pt-(--safe-t) md:gap-2 md:px-4',
        'bg-[color-mix(in_oklab,var(--bg-editor)_88%,transparent)] backdrop-blur-md backdrop-saturate-150',
        className,
      )}
    >
      <IconButton label="打开导航菜单" className="md:hidden" onClick={() => setSidebarOpen(true)}>
        <IconMenu width={18} height={18} />
      </IconButton>
      {sidebarCollapsed && (
        <IconButton label="展开侧边栏 (Ctrl+\\)" className="max-md:hidden" onClick={() => setSidebarCollapsed(false)}>
          <IconSidebarOpen width={17} height={17} />
        </IconButton>
      )}
      {children}
    </header>
  )
}

/** Breadcrumb trail for the page header: earlier items link back, the last one is current. */
export function Crumbs({ children }: { children: ReactNode }) {
  return (
    <nav aria-label="面包屑导航" className="flex min-w-0 flex-1 items-center gap-1 text-[13px]">
      {children}
    </nav>
  )
}
