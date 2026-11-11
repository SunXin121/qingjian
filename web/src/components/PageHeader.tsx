import type { ReactNode } from 'react'
import { useStore } from '../store'
import { IconMenu } from './icons'

/** Sticky page header; on mobile it carries the sidebar toggle. */
export default function PageHeader({ children }: { children?: ReactNode }) {
  const { setSidebarOpen } = useStore()
  return (
    <header className="page-header">
      <button className="icon-btn mobile-only" title="菜单" aria-label="菜单" onClick={() => setSidebarOpen(true)}>
        <IconMenu />
      </button>
      {children}
    </header>
  )
}
