import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

// Imperative dialogs (confirm / prompt) and toasts, mounted outside the React tree.

export function mount(render: (close: () => void) => ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => {
    root.unmount()
    host.remove()
  }
  root.render(render(close))
}

export function Modal({ title, children, onClose, wide }: { title?: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog">
        {title && <div className="modal-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}

interface ConfirmOpts {
  okText?: string
  danger?: boolean
  title?: string
}

export function confirmDialog(message: ReactNode, opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    mount((close) => {
      const done = (v: boolean) => {
        close()
        resolve(v)
      }
      return (
        <Modal title={opts.title ?? '请确认'} onClose={() => done(false)}>
          <div className="modal-body">{message}</div>
          <div className="modal-actions">
            <button className="btn" onClick={() => done(false)}>
              取消
            </button>
            <button className={'btn ' + (opts.danger ? 'danger' : 'primary')} autoFocus onClick={() => done(true)}>
              {opts.okText ?? '确定'}
            </button>
          </div>
        </Modal>
      )
    })
  })
}

interface PromptField {
  name: string
  label: string
  value?: string
  placeholder?: string
  multiline?: boolean
  required?: boolean
}

function PromptForm({ title, fields, okText, onDone }: { title: string; fields: PromptField[]; okText: string; onDone: (v: Record<string, string> | null) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value ?? ''])))
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    first.current?.focus()
    first.current?.select()
  }, [])
  const valid = fields.every((f) => !f.required || values[f.name].trim())
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onDone(values)
        }}
      >
        <div className="modal-body form">
          {fields.map((f, i) => (
            <label key={f.name} className="field">
              <span>{f.label}</span>
              {f.multiline ? (
                <textarea rows={3} value={values[f.name]} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
              ) : (
                <input
                  ref={i === 0 ? first : undefined}
                  value={values[f.name]}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onDone(null)}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            {okText}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function promptForm(title: string, fields: PromptField[], okText = '确定'): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    mount((close) => (
      <PromptForm
        title={title}
        fields={fields}
        okText={okText}
        onDone={(v) => {
          close()
          resolve(v)
        }}
      />
    ))
  })
}

export async function promptText(title: string, value = '', placeholder = ''): Promise<string | null> {
  const r = await promptForm(title, [{ name: 'v', label: '', value, placeholder, required: true }])
  return r ? r.v.trim() : null
}

let toastHost: HTMLDivElement | null = null
export function toast(message: string, ms = 2600) {
  if (!toastHost) {
    toastHost = document.createElement('div')
    toastHost.className = 'toast-host'
    document.body.appendChild(toastHost)
  }
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  toastHost.appendChild(el)
  setTimeout(() => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 300)
  }, ms)
}

/** Simple dropdown menu anchored to a trigger element. */
export interface MenuItem {
  label: string
  onClick: () => void
  icon?: ReactNode
  danger?: boolean
  hidden?: boolean
  /** draw a separator line above this item */
  divider?: boolean
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  const rect = anchor.getBoundingClientRect()
  mount((close) => {
    const visible = items.filter((i) => !i.hidden)
    const width = 196
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const estH = visible.length * 40 + visible.filter((i) => i.divider).length * 9 + 12
    const top = rect.bottom + estH > window.innerHeight - 8 ? Math.max(8, rect.top - estH - 4) : rect.bottom + 4
    return (
      <div className="menu-backdrop" onMouseDown={close} onTouchStart={(e) => e.target === e.currentTarget && close()}>
        <div className="menu" style={{ left, top, width }} onMouseDown={(e) => e.stopPropagation()}>
          {visible.map((it, i) => (
            <Fragment key={it.label}>
              {it.divider && i > 0 && <div className="menu-sep" />}
              <button
                className={'menu-item' + (it.danger ? ' danger' : '')}
                onClick={() => {
                  close()
                  it.onClick()
                }}
              >
                {it.icon && <span className="menu-icon">{it.icon}</span>}
                <span className="ellipsis">{it.label}</span>
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    )
  })
}

/** Copy text to the clipboard; falls back to execCommand on plain-HTTP origins. */
export async function copyText(text: string, done = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (!ok) return toast('复制失败，请手动复制')
  }
  toast(done)
}
