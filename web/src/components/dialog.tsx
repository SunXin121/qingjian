import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { IconCheck, IconClose } from './icons'
import { Button, cn, inputClass } from './ui'

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

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps keyboard focus inside `ref` while it is mounted (Tab wraps around) and gives it
 * back to whatever had it before once the element goes away.
 */
export function useFocusTrap(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const before = document.activeElement as HTMLElement | null
    // children with autoFocus already took focus; otherwise start on the panel itself
    if (!el.contains(document.activeElement)) el.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (!items.length) return e.preventDefault()
      const first = items[0]
      const last = items[items.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || !el.contains(cur))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (cur === last || !el.contains(cur))) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [ref])
}

export function Modal({ title, children, onClose, wide, className }: { title?: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(ref)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    // no backdrop-filter: re-blurring the viewport on every frame of the fade made dialogs stutter
    <div
      className="fixed inset-0 z-[200] flex animate-fade items-end justify-center bg-scrim p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className={cn(
          'modal relative flex max-h-[calc(100dvh-24px)] w-full animate-modal flex-col overflow-hidden rounded-t-2xl bg-overlay shadow-modal sm:max-h-[calc(100dvh-48px)] sm:rounded-xl',
          wide ? 'sm:max-w-[640px]' : 'sm:max-w-[420px]',
          className,
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {title && (
          <div className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-1">
            <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink" id={titleId}>
              {title}
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="-mr-1.5 grid size-8 place-items-center rounded-md text-ink-3 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink md:size-7"
            >
              <IconClose width={16} height={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/** Scrollable body of a modal. */
export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-3 text-[13px] leading-relaxed text-ink-2', className)}>{children}</div>
}

/** Button row at the bottom of a modal. */
export function ModalActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pt-2 pb-[calc(16px+var(--safe-b))] sm:pb-4', className)}>{children}</div>
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
          <ModalBody>{message}</ModalBody>
          <ModalActions>
            <Button onClick={() => done(false)}>取消</Button>
            <Button variant={opts.danger ? 'danger' : 'primary'} autoFocus onClick={() => done(true)}>
              {opts.okText ?? '确定'}
            </Button>
          </ModalActions>
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
        <ModalBody className="flex flex-col gap-3.5">
          {fields.map((f, i) => (
            <label key={f.name} className="flex flex-col gap-1.5">
              {f.label && <span className="text-[12px] font-medium text-ink-2">{f.label}</span>}
              {f.multiline ? (
                <textarea
                  rows={3}
                  className={cn(inputClass, 'resize-y py-2 leading-relaxed')}
                  value={values[f.name]}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              ) : (
                <input
                  ref={i === 0 ? first : undefined}
                  className={cn(inputClass, 'h-10 md:h-9')}
                  value={values[f.name]}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </label>
          ))}
        </ModalBody>
        <ModalActions>
          <Button onClick={() => onDone(null)}>取消</Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {okText}
          </Button>
        </ModalActions>
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
    toastHost.className = 'pointer-events-none fixed bottom-[calc(28px+var(--safe-b))] left-1/2 z-[300] flex -translate-x-1/2 flex-col items-center gap-2'
    // announced by screen readers without moving focus
    toastHost.setAttribute('role', 'status')
    toastHost.setAttribute('aria-live', 'polite')
    document.body.appendChild(toastHost)
  }
  const el = document.createElement('div')
  el.className =
    'max-w-[min(440px,calc(100vw-32px))] animate-rise rounded-lg bg-[color-mix(in_oklab,var(--text-primary)_94%,transparent)] px-4 py-2 text-center text-[12.5px] leading-relaxed font-medium text-ink-inverse shadow-pop transition-[opacity,transform] duration-(--dur-base) ease-out'
  el.textContent = message
  toastHost.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateY(4px)'
    setTimeout(() => el.remove(), 260)
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
  /** show a check mark (for option lists) */
  checked?: boolean
  disabled?: boolean
}

export type Anchor = HTMLElement | { left: number; top: number; right: number; bottom: number }

const anchorRect = (a: Anchor) => (a instanceof HTMLElement ? a.getBoundingClientRect() : a)

export function openMenu(anchor: Anchor, items: MenuItem[], opts: { align?: 'left' | 'right'; width?: number } = {}) {
  const rect = anchorRect(anchor)
  mount((close) => <MenuFrame rect={rect} items={items.filter((i) => !i.hidden)} opts={opts} close={close} />)
}

function MenuFrame({ rect, items, opts, close }: { rect: { left: number; right: number; top: number; bottom: number }; items: MenuItem[]; opts: { align?: 'left' | 'right'; width?: number }; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = opts.width ?? 196
  const x = opts.align === 'left' ? rect.left : rect.right - width
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const estH = items.length * 34 + items.filter((i) => i.divider).length * 9 + 12
  const top = rect.bottom + estH > window.innerHeight - 8 ? Math.max(8, rect.top - estH - 4) : rect.bottom + 4
  // focus moves into the menu so the keyboard works, and returns to the trigger on close
  // (before the chosen item runs, so an action that focuses something else still wins)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not(:disabled)') ?? [])]
    const cur = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      return close()
    } else if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % buttons.length
    else if (e.key === 'ArrowUp') next = cur < 0 ? buttons.length - 1 : (cur - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    else return
    e.preventDefault()
    buttons[next]?.focus()
  }
  const fromAbove = top < rect.top
  return (
    <div
      className="fixed inset-0 z-[210]"
      onMouseDown={close}
      onTouchStart={(e) => e.target === e.currentTarget && close()}
      onContextMenu={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div
        ref={ref}
        className="fixed animate-pop overflow-y-auto rounded-lg border border-line-subtle bg-overlay p-1 shadow-pop outline-none"
        role="menu"
        tabIndex={-1}
        style={{ left, top, width, maxHeight: window.innerHeight - 16, transformOrigin: `${fromAbove ? 'bottom' : 'top'} ${opts.align === 'left' ? 'left' : 'right'}` }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {items.map((it, i) => (
          <Fragment key={it.label + i}>
            {it.divider && i > 0 && <div className="mx-1.5 my-1 h-px bg-line-subtle" role="separator" />}
            <button
              data-menu-item
              className={cn(
                'group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none md:h-8',
                'transition-colors duration-(--dur-fast) disabled:pointer-events-none disabled:opacity-45',
                it.danger ? 'text-danger hover:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)]' : 'text-ink hover:bg-hover focus-visible:bg-hover',
              )}
              role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined}
              disabled={it.disabled}
              onClick={() => {
                close()
                it.onClick()
              }}
            >
              {it.icon && (
                <span className={cn('inline-flex shrink-0 [&_svg]:size-[15px]', it.danger ? 'text-danger' : 'text-ink-3 group-hover:text-ink-2')}>{it.icon}</span>
              )}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.checked && <IconCheck width={14} height={14} className="shrink-0 text-accent" />}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** A floating panel anchored to an element; closes on outside click or Escape. */
export function openPopover(anchor: Anchor, render: (close: () => void) => ReactNode, opts: { width?: number; align?: 'left' | 'right'; className?: string; onClose?: () => void } = {}) {
  const rect = anchorRect(anchor)
  mount((unmount) => {
    const close = () => {
      unmount()
      opts.onClose?.()
    }
    return <PopoverFrame rect={rect} opts={opts} close={close}>{render(close)}</PopoverFrame>
  })
}

function PopoverFrame({ rect, opts, close, children }: { rect: { left: number; right: number; top: number; bottom: number }; opts: { width?: number; align?: 'left' | 'right'; className?: string }; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = Math.min(opts.width ?? 320, window.innerWidth - 16)
  const x = opts.align === 'right' ? rect.right - width : rect.left
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const [top, setTop] = useState(rect.bottom + 6)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])
  // flip above the anchor when there is no room below
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    if (rect.bottom + 6 + h > window.innerHeight - 8 && rect.top - 6 - h > 8) setTop(rect.top - 6 - h)
  })
  return (
    <div className="fixed inset-0 z-[210]" onMouseDown={(e) => e.target === e.currentTarget && close()} onTouchStart={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className={'popover ' + (opts.className ?? '')} style={{ left, top, width, maxHeight: `calc(100vh - ${Math.max(16, top + 8)}px)` }}>
        {children}
      </div>
    </div>
  )
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
