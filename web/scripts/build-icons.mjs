// Turns the icon and emoji packages into compact JSON files under public/icons/, loaded
// on demand by the icon picker; the server renders single icons from the same files
// (GET /icons/{set}/{name}.svg).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
const read = (p) => JSON.parse(readFileSync(require.resolve(p), 'utf8'))

// icon sets: Iconify package name → shown in the picker in this order
const SETS = ['lucide', 'tabler', 'ri']

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const index = []
for (const prefix of SETS) {
  const data = read(`@iconify-json/${prefix}/icons.json`)
  const info = read(`@iconify-json/${prefix}/info.json`)
  let meta = {}
  try {
    meta = read(`@iconify-json/${prefix}/metadata.json`)
  } catch {
    /* optional */
  }
  const w = data.width ?? 16
  const h = data.height ?? 16
  const icons = {}
  for (const [name, icon] of Object.entries(data.icons)) {
    if (icon.hidden) continue
    const iw = icon.width ?? w
    const ih = icon.height ?? h
    icons[name] = iw === w && ih === h && !icon.left && !icon.top ? icon.body : [icon.body, iw, ih, icon.left ?? 0, icon.top ?? 0]
  }
  const categories = {}
  for (const [cat, names] of Object.entries(meta.categories ?? {})) {
    const kept = names.filter((n) => n in icons)
    if (kept.length) categories[cat] = kept
  }
  writeFileSync(join(out, `${prefix}.json`), JSON.stringify({ prefix, width: w, height: h, icons, categories }))
  index.push({ prefix, name: info.name, license: info.license?.title ?? '', url: info.author?.url ?? '', total: Object.keys(icons).length })
}

// emoji: Unicode emoji with Chinese names and keywords, by category
const groups = read('emojibase-data/zh/messages.json').groups
const emoji = groups
  .filter((g) => g.key !== 'component')
  .map((g) => ({ key: g.key, name: g.message, items: [] }))
const byOrder = new Map(groups.map((g) => [g.order, emoji.find((e) => e.key === g.key)]))
for (const e of read('emojibase-data/zh/compact.json').sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
  const group = byOrder.get(e.group)
  if (!group) continue
  group.items.push([e.unicode, [e.label, ...(e.tags ?? [])].join(' ')])
}
writeFileSync(join(out, 'emoji.json'), JSON.stringify(emoji))
writeFileSync(join(out, 'index.json'), JSON.stringify(index))
console.log(`icons: ${index.map((s) => `${s.prefix} ${s.total}`).join(', ')}; emoji ${emoji.reduce((n, g) => n + g.items.length, 0)}`)
