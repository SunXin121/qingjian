import { useEffect, useMemo, useRef, useState } from 'react'
import { IconSearch } from './icons'

/*
 * Icon picker in the spirit of SiYuan's emoji panel: every Unicode emoji (Chinese names
 * and keywords for search, by category) plus open-source icon sets from Iconify. The data
 * is generated at build time into /icons/ (web/scripts/build-icons.mjs) and loaded on
 * first use. Values: an emoji itself, or "prefix:name" for a library icon.
 */

interface SetInfo {
  prefix: string
  name: string
  license: string
  url: string
  total: number
}
type IconData = string | [body: string, width: number, height: number, left: number, top: number]
interface SetData {
  prefix: string
  width: number
  height: number
  icons: Record<string, IconData>
  categories: Record<string, string[]>
}
interface EmojiGroup {
  key: string
  name: string
  items: [emoji: string, keywords: string][]
}

const cache = new Map<string, Promise<unknown>>()
function load<T>(path: string): Promise<T> {
  let p = cache.get(path)
  if (!p) {
    p = fetch(path).then((r) => {
      if (!r.ok) throw new Error('图标数据加载失败')
      return r.json()
    })
    p.catch(() => cache.delete(path))
    cache.set(path, p)
  }
  return p as Promise<T>
}

const RECENT_KEY = 'qingjian.recentIcons'
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 24) : []
  } catch {
    return []
  }
}
function pushRecent(value: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([value, ...readRecent().filter((v) => v !== value)].slice(0, 24)))
  } catch {
    /* storage unavailable */
  }
}

const PAGE = 240
const SET_KEY = 'qingjian.iconSet'

function IconSvg({ set, name, size = 20 }: { set: SetData; name: string; size?: number }) {
  const v = set.icons[name]
  if (!v) return null
  const [body, w, h, l, t] = typeof v === 'string' ? [v, set.width, set.height, 0, 0] : v
  return <svg viewBox={`${l} ${t} ${w} ${h}`} width={size} height={size} aria-hidden dangerouslySetInnerHTML={{ __html: body }} />
}

export default function IconPicker({ value, disabled, onSelect }: { value: string; disabled?: boolean; onSelect: (value: string) => void }) {
  const [tab, setTab] = useState<'emoji' | 'icon'>(() => (/^[a-z0-9-]+:/.test(value) ? 'icon' : 'emoji'))
  const [query, setQuery] = useState('')
  const [emoji, setEmoji] = useState<EmojiGroup[] | null>(null)
  const [sets, setSets] = useState<SetInfo[] | null>(null)
  const [prefix, setPrefix] = useState(() => {
    if (/^[a-z0-9-]+:/.test(value)) return value.split(':')[0]
    try {
      return localStorage.getItem(SET_KEY) || 'lucide'
    } catch {
      return 'lucide'
    }
  })
  const [setData, setSetData] = useState<SetData | null>(null)
  const [category, setCategory] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [error, setError] = useState('')
  const [recent, setRecent] = useState(readRecent)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (tab === 'emoji' && !emoji) load<EmojiGroup[]>('/icons/emoji.json').then(setEmoji, (e) => setError(e.message))
    if (tab === 'icon' && !sets) load<SetInfo[]>('/icons/index.json').then(setSets, (e) => setError(e.message))
  }, [tab, emoji, sets])

  useEffect(() => {
    if (tab !== 'icon' || !sets) return
    const p = sets.some((s) => s.prefix === prefix) ? prefix : sets[0]?.prefix
    if (!p) return
    if (p !== prefix) {
      setPrefix(p)
      return
    }
    let live = true
    setSetData(null)
    load<SetData>(`/icons/${p}.json`).then(
      (d) => live && setSetData(d),
      (e) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [tab, sets, prefix])

  // a new filter starts at the top
  useEffect(() => {
    setLimit(PAGE)
    scroller.current?.scrollTo({ top: 0 })
  }, [tab, query, prefix, category])

  const q = query.trim().toLowerCase()
  const emojiHits = useMemo(() => {
    if (!emoji || !q) return null
    const words = q.split(/\s+/)
    return emoji.flatMap((g) => g.items).filter(([e, k]) => e === q || words.every((w) => k.toLowerCase().includes(w)))
  }, [emoji, q])

  const iconNames = useMemo(() => {
    if (!setData) return []
    let names = category ? setData.categories[category] ?? [] : Object.keys(setData.icons)
    if (q) {
      const words = q.split(/[\s-]+/).filter(Boolean)
      names = names.filter((n) => words.every((w) => n.includes(w)))
    }
    return names
  }, [setData, category, q])

  const pick = (v: string) => {
    pushRecent(v)
    setRecent(readRecent())
    onSelect(v)
  }

  const random = () => {
    if (tab === 'emoji' && emoji) {
      const all = emojiHits ?? emoji.flatMap((g) => g.items)
      if (all.length) pick(all[Math.floor(Math.random() * all.length)][0])
    } else if (tab === 'icon' && iconNames.length) {
      pick(`${prefix}:${iconNames[Math.floor(Math.random() * iconNames.length)]}`)
    }
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 120) setLimit((l) => l + PAGE)
  }

  const emojiButton = (e: string, label?: string) => (
    <button
      key={e}
      type="button"
      className={'icon-pick emoji' + (value === e ? ' selected' : '')}
      title={label?.split(' ')[0]}
      aria-label={label?.split(' ')[0] ?? e}
      aria-pressed={value === e}
      disabled={disabled}
      onClick={() => pick(e)}
    >
      {e}
    </button>
  )

  const recentRow = !q && recent.length > 0 && (tab === 'emoji' || setData) && (
    <section>
      <h4>最近使用</h4>
      <div className="icon-grid">
        {recent.map((v) => {
          const [p, n] = v.split(':')
          if (n === undefined) return emojiButton(v)
          return (
            <button key={v} type="button" className={'icon-pick' + (value === v ? ' selected' : '')} title={n} aria-label={n} aria-pressed={value === v} disabled={disabled} onClick={() => pick(v)}>
              {p === setData?.prefix ? <IconSvg set={setData} name={n} /> : <span className="repo-mark-icon" style={{ '--icon': `url("/icons/${p}/${n}.svg")` } as React.CSSProperties} />}
            </button>
          )
        })}
      </div>
    </section>
  )

  const jump = (key: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-group="${key}"]`)
    if (el) scroller.current?.scrollTo({ top: el.offsetTop })
  }

  const info = sets?.find((s) => s.prefix === prefix)
  return (
    <div className="icon-picker">
      <div className="icon-picker-head">
        <div className="seg" role="tablist" aria-label="图标类型">
          <button type="button" role="tab" aria-selected={tab === 'emoji'} className={tab === 'emoji' ? 'active' : ''} onClick={() => setTab('emoji')}>
            表情
          </button>
          <button type="button" role="tab" aria-selected={tab === 'icon'} className={tab === 'icon' ? 'active' : ''} onClick={() => setTab('icon')}>
            图标
          </button>
        </div>
        <label className="icon-search">
          <IconSearch width={14} height={14} />
          <input value={query} placeholder={tab === 'emoji' ? '搜索表情，如：书、星星' : '搜索英文名，如 book'} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="button" className="btn sm ghost" disabled={disabled} onClick={random} title="随机选一个">
          随机
        </button>
      </div>

      {tab === 'icon' && sets && (
        <div className="icon-picker-sets">
          {sets.map((s) => (
            <button
              key={s.prefix}
              type="button"
              className={'chip' + (s.prefix === prefix ? ' active' : '')}
              aria-pressed={s.prefix === prefix}
              onClick={() => {
                setPrefix(s.prefix)
                setCategory('')
                try {
                  localStorage.setItem(SET_KEY, s.prefix)
                } catch {
                  /* ignore */
                }
              }}
            >
              {s.name}
            </button>
          ))}
          {setData && Object.keys(setData.categories).length > 0 && (
            <select value={category} aria-label="分类" onChange={(e) => setCategory(e.target.value)}>
              <option value="">全部分类</option>
              {Object.keys(setData.categories).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {tab === 'emoji' && emoji && !q && (
        <div className="icon-picker-sets emoji-nav" role="group" aria-label="表情分类">
          {emoji.map((g) => (
            <button key={g.key} type="button" className="icon-pick emoji" title={g.name} aria-label={g.name} onClick={() => jump(g.key)}>
              {g.items[0]?.[0]}
            </button>
          ))}
        </div>
      )}

      <div className="icon-picker-body" ref={scroller} onScroll={onScroll}>
        {error ? (
          <div className="icon-picker-empty error">{error}</div>
        ) : tab === 'emoji' ? (
          !emoji ? (
            <div className="icon-picker-empty">加载中…</div>
          ) : emojiHits ? (
            emojiHits.length ? <div className="icon-grid">{emojiHits.slice(0, limit).map(([e, k]) => emojiButton(e, k))}</div> : <div className="icon-picker-empty">没有匹配的表情</div>
          ) : (
            <>
              {recentRow}
              {emoji.map((g) => (
                <section key={g.key} data-group={g.key}>
                  <h4>{g.name}</h4>
                  <div className="icon-grid">{g.items.map(([e, k]) => emojiButton(e, k))}</div>
                </section>
              ))}
            </>
          )
        ) : !setData ? (
          <div className="icon-picker-empty">加载中…</div>
        ) : (
          <>
            {recentRow}
            {iconNames.length ? (
              <section>
                {!q && recentRow && <h4>{category || info?.name}</h4>}
                <div className="icon-grid">
                  {iconNames.slice(0, limit).map((n) => {
                    const v = `${prefix}:${n}`
                    return (
                      <button key={n} type="button" className={'icon-pick' + (value === v ? ' selected' : '')} title={n} aria-label={n} aria-pressed={value === v} disabled={disabled} onClick={() => pick(v)}>
                        <IconSvg set={setData} name={n} />
                      </button>
                    )
                  })}
                </div>
              </section>
            ) : (
              <div className="icon-picker-empty">没有匹配的图标</div>
            )}
          </>
        )}
      </div>
      {tab === 'icon' && info && (
        <div className="icon-picker-foot">
          {iconNames.length} 个图标 ·{' '}
          <a href={info.url} target="_blank" rel="noreferrer">
            {info.name}
          </a>{' '}
          · {info.license}
        </div>
      )}
    </div>
  )
}
