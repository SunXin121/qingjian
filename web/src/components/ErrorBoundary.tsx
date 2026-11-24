import { Component, type ErrorInfo, type ReactNode } from 'react'
import { IconRefresh } from './icons'
import { Button } from './ui'

interface Props {
  children: ReactNode
  /** Changing this value (the route) clears a shown error, so navigating away recovers. */
  resetKey?: string
}

/**
 * Catches render errors of a page so a failing editor, diagram or table view leaves the
 * sidebar usable instead of blanking the whole app.
 */
export default class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('page crashed:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    // a chunk of an older build that the server no longer has: only a reload helps
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message)
    return (
      <div className="flex min-h-[70dvh] flex-col items-center justify-center px-6 py-16 text-center" role="alert">
        <div className="max-w-md rounded-2xl border border-line-subtle bg-surface p-6 shadow-card">
          <strong className="block text-[16px] font-semibold text-ink">{stale ? '应用已更新' : '页面出错了'}</strong>
          <p className="mt-2 mb-0 text-[13px] leading-relaxed text-ink-3">
            {stale ? '请重新加载页面以使用新版本。' : '这个页面渲染时出现了问题，已保存的内容不受影响。'}
          </p>
          {!stale && (
            <pre className="mt-3.5 max-h-32 overflow-auto rounded-lg border border-line-subtle bg-inset p-3 text-left font-mono text-[11.5px] whitespace-pre-wrap break-words text-ink-2">
              {error.message}
            </pre>
          )}
          <div className="mt-5 flex justify-center gap-2">
            {!stale && <Button onClick={() => this.setState({ error: null })}>重试</Button>}
            <Button variant="primary" icon={<IconRefresh width={14} height={14} />} onClick={() => location.reload()}>
              重新加载
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
