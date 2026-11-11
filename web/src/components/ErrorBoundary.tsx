import { Component, type ErrorInfo, type ReactNode } from 'react'

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
      <div className="page">
        <div className="empty-state error-state" role="alert">
          <strong>{stale ? '应用已更新' : '页面出错了'}</strong>
          <p className="muted">{stale ? '请重新加载页面以使用新版本。' : '这个页面渲染时出现了问题，已保存的内容不受影响。'}</p>
          {!stale && <pre className="error-detail">{error.message}</pre>}
          <div className="error-actions">
            {!stale && (
              <button className="btn" onClick={() => this.setState({ error: null })}>
                重试
              </button>
            )}
            <button className="btn primary" onClick={() => location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    )
  }
}
