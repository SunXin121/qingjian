// Code block language as an input: type a language (name or alias, e.g. "py") or pick it
// from the filtered list that opens under the input. Replaces Crepe's language button and
// its separate search popup; the stock code-block view is otherwise unchanged.

import type { EditorView } from '@milkdown/kit/prose/view'

interface LangInfo {
  name: string
  alias: string[]
}

/** The parts of Milkdown's CodeMirrorBlock used here (its members are declared private). */
interface StockView {
  dom: HTMLElement
  node: { attrs: { language?: string } }
  setLanguage: (language: string) => void
  getAllLanguages: () => LangInfo[]
  createApp: () => { mount: (el: Element) => unknown; unmount: () => void }
}

const norm = (s: string) => s.trim().toLowerCase()

const svg = (path: string, cls: string) =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
const CHEVRON = svg('<path d="m6 9 6 6 6-6"/>', 'ink-lang-caret')
const CHECK = svg('<path d="M20 6 9 17l-5-5"/>', 'ink-lang-check')

/**
 * Adds the language input to a stock code-block node view, every time its Vue UI is
 * mounted (it is torn down while off screen). Returns a function that brings the input
 * in line with the node's language after an update.
 */
export function withLangInput(nv: StockView, view: EditorView): () => void {
  let ui: { input: HTMLInputElement; close: () => void } | null = null

  const attach = () => {
    const tools = nv.dom.querySelector<HTMLElement>(':scope > .tools')
    if (!tools || tools.querySelector('.ink-lang')) return
    // Crepe's own button and popup are replaced (and hidden by CSS). Taken out of the page:
    // on every mount the popup positions itself under the button (floating-ui), which reads
    // their style and layout, forcing a layout of the whole page per code block.
    for (const el of tools.querySelectorAll(':scope > .language-button, :scope > .language-picker')) el.remove()
    ui = mountInput(tools, nv, view)
  }
  const detach = () => {
    ui?.close()
    ui = null
  }

  const createApp = nv.createApp
  nv.createApp = () => {
    const app = createApp()
    const mount = app.mount.bind(app)
    const unmount = app.unmount.bind(app)
    app.mount = (el: Element) => {
      const r = mount(el)
      attach()
      return r
    }
    app.unmount = () => {
      detach()
      unmount()
    }
    return app
  }
  // already mounted (the view may set itself up right away)
  attach()

  return () => {
    if (ui && document.activeElement !== ui.input) ui.input.value = nv.node.attrs.language ?? ''
    if (ui) fit(ui.input)
  }
}

/** Width in `ch` of a text: CJK characters take two. */
const textWidth = (s: string) => [...s].reduce((n, c) => n + (/[\u2e80-\uffff]/.test(c) ? 2 : 1), 0)

function fit(input: HTMLInputElement) {
  const n = Math.max(textWidth(input.value || input.placeholder), 2)
  input.style.width = `calc(${n}ch + 2px)`
}

function mountInput(tools: HTMLElement, nv: StockView, view: EditorView) {
  const wrap = document.createElement('span')
  wrap.className = 'ink-lang'
  const input = document.createElement('input')
  input.className = 'ink-lang-input'
  input.placeholder = '纯文本'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.title = '代码语言：输入或从列表中选择'
  input.value = nv.node.attrs.language ?? ''
  input.readOnly = !view.editable
  wrap.appendChild(input)
  wrap.insertAdjacentHTML('beforeend', CHEVRON)
  // the whole chip focuses the input (the caret and padding included)
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === input || input.readOnly) return
    e.preventDefault()
    if (document.activeElement === input) closeMenu()
    else input.focus()
  })
  tools.insertBefore(wrap, tools.firstChild)
  fit(input)

  let menu: HTMLElement | null = null
  let items: LangInfo[] = []
  let active = -1

  const current = () => nv.node.attrs.language ?? ''

  const resolve = (text: string): string => {
    const q = norm(text)
    if (!q) return ''
    const hit = nv.getAllLanguages().find((l) => norm(l.name) === q || l.alias.some((a) => norm(a) === q))
    return hit ? hit.name : text.trim()
  }

  const commit = (name: string) => {
    closeMenu()
    // "js" and "JavaScript" are the same language: keep what the markdown says
    const same = name === current() || (name !== '' && resolve(current()) === name)
    input.value = same ? current() : name
    fit(input)
    if (!same) nv.setLanguage(name)
  }

  const highlight = (i: number) => {
    if (!menu) return
    active = i
    menu.querySelectorAll('.ink-lang-item').forEach((el, j) => el.classList.toggle('active', j === i))
    // scroll only the list, never the page
    const el = menu.querySelector<HTMLElement>('.ink-lang-item.active')
    if (!el) return
    const pad = 4
    if (el.offsetTop - pad < menu.scrollTop) menu.scrollTop = el.offsetTop - pad
    else if (el.offsetTop + el.offsetHeight + pad > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = el.offsetTop + el.offsetHeight + pad - menu.clientHeight
  }

  const render = (filter: string) => {
    if (!menu) return
    const q = norm(filter)
    const all = nv.getAllLanguages() ?? []
    items = q ? all.filter((l) => norm(l.name).includes(q) || l.alias.some((a) => norm(a).includes(q))) : all
    // exact matches (name or alias) first, then names starting with the text
    if (q) {
      const rank = (l: LangInfo) => (norm(l.name) === q || l.alias.some((a) => norm(a) === q) ? 0 : norm(l.name).startsWith(q) ? 1 : 2)
      items = [...items].sort((a, b) => rank(a) - rank(b))
    }
    menu.textContent = ''
    const cur = norm(resolve(current()))
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'ink-lang-empty'
      empty.textContent = q ? `使用「${filter.trim()}」` : '没有可选的语言'
      menu.appendChild(empty)
    }
    items.forEach((l, i) => {
      const el = document.createElement('div')
      const isCur = norm(l.name) === cur
      el.className = 'ink-lang-item' + (isCur ? ' current' : '')
      el.setAttribute('role', 'option')
      const name = document.createElement('span')
      name.className = 'ink-lang-name'
      name.textContent = l.name
      el.appendChild(name)
      // the shortest alias that differs from the name, as a typing hint
      const hint = l.alias.filter((a) => norm(a) !== norm(l.name)).sort((a, b) => a.length - b.length)[0]
      if (hint) {
        const al = document.createElement('span')
        al.className = 'ink-lang-alias'
        al.textContent = hint
        el.appendChild(al)
      }
      if (isCur) el.insertAdjacentHTML('beforeend', CHECK)
      el.addEventListener('mousedown', (e) => e.preventDefault())
      el.addEventListener('mousemove', () => active !== i && highlight(i))
      el.addEventListener('click', () => {
        commit(l.name)
        input.blur()
      })
      menu!.appendChild(el)
    })
    const i = q ? 0 : items.findIndex((l) => norm(l.name) === cur)
    highlight(items.length ? i : -1)
  }

  const place = () => {
    if (!menu) return
    const r = wrap.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`
    if (below < 280 && r.top > below) {
      menu.style.top = ''
      menu.style.bottom = `${window.innerHeight - r.top + 6}px`
    } else {
      menu.style.bottom = ''
      menu.style.top = `${r.bottom + 6}px`
    }
  }

  const openMenu = () => {
    if (menu || input.readOnly) return
    menu = document.createElement('div')
    menu.className = 'ink-lang-menu'
    menu.setAttribute('role', 'listbox')
    wrap.classList.add('open')
    document.body.appendChild(menu)
    render('')
    place()
    const cur = menu.querySelector<HTMLElement>('.ink-lang-item.current')
    if (cur) menu.scrollTop = cur.offsetTop - (menu.clientHeight - cur.offsetHeight) / 2
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
  }

  function closeMenu() {
    if (!menu) return
    menu.remove()
    menu = null
    wrap.classList.remove('open')
    active = -1
    window.removeEventListener('scroll', place, true)
    window.removeEventListener('resize', place)
  }

  input.addEventListener('focus', () => {
    if (input.readOnly) return
    input.select()
    openMenu()
  })
  input.addEventListener('mousedown', () => {
    if (document.activeElement === input) openMenu()
  })
  input.addEventListener('input', () => {
    fit(input)
    openMenu()
    render(input.value)
  })
  input.addEventListener('blur', () => {
    if (input.readOnly) return
    commit(resolve(input.value))
  })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    e.stopPropagation()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu()
      if (!items.length) return
      const d = e.key === 'ArrowDown' ? 1 : -1
      highlight(active < 0 ? (d > 0 ? 0 : items.length - 1) : (active + d + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // a highlighted entry wins, unless the text names a language exactly
      const typed = resolve(input.value)
      const exact = nv.getAllLanguages().some((l) => l.name === typed)
      commit(menu && active >= 0 && items[active] && !exact && input.value.trim() ? items[active].name : typed)
      input.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      input.value = current()
      closeMenu()
      input.blur()
    }
  })

  return {
    input,
    close: () => {
      closeMenu()
      wrap.remove()
    },
  }
}
