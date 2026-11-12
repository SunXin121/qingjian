// Import a pinned snapshot; existing original files must still match their hashes.
// Local integration belongs outside the vendored source tree.
import { cp, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PIN = '8fc9851c0b6a8e764b74a835237b2920c3b5120f'
const source = resolve(process.argv[2] || '')
const target = fileURLToPath(new URL('../vendor/edgeever/', import.meta.url))
if (!process.argv[2] || execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== PIN) throw new Error(`Expected EdgeEver checkout at ${PIN}`)
const sourcePaths = ['apps/extension', 'packages/shared', 'apps/web/src/components/ui', 'apps/web/src/lib/utils.ts', 'patches/@joplin%2Fturndown-plugin-gfm@1.0.68.patch', 'LICENSE', 'tsconfig.json']
if (execFileSync('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths], { encoding: 'utf8' }).trim()) throw new Error('Upstream source contains local changes; refusing to label it an unchanged snapshot')
try {
  const previous = JSON.parse(await readFile(join(target, 'UPSTREAM.json'), 'utf8'))
  if (previous.commit !== PIN) throw new Error('Vendor revision changed; refusing to overwrite')
  for (const [path, hash] of Object.entries(previous.files)) {
    if (createHash('sha256').update(await readFile(join(target, path))).digest('hex') !== hash) throw new Error(`Locally modified vendor file: ${path}`)
  }
} catch (error) { if (error.code !== 'ENOENT') throw error }
const copied = new Set()
async function copyFile(path) {
  if (copied.has(path)) return
  const from = resolve(source, path)
  if (!from.startsWith(`${source}/`)) throw new Error('Source escaped checkout')
  await mkdir(dirname(join(target, path)), { recursive: true })
  await cp(from, join(target, path))
  copied.add(path)
}
async function copyTree(path) {
  for (const item of await readdir(join(source, path), { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-firefox', 'store-assets', 'web-ext-artifacts'].includes(item.name)) continue
    const name = `${path}/${item.name}`
    if (item.isDirectory()) await copyTree(name)
    else if (item.isFile()) await copyFile(name)
    else throw new Error(`Unexpected source entry: ${name}`)
  }
}
await copyTree('apps/extension')
for (const path of ['LICENSE', 'tsconfig.json', 'packages/shared/package.json', 'patches/@joplin%2Fturndown-plugin-gfm@1.0.68.patch']) await copyFile(path)
const queue = [
  'apps/web/src/components/ui/button.tsx', 'apps/web/src/components/ui/input.tsx',
  'packages/shared/src/ai-generation.ts', 'packages/shared/src/provider-event-stream.ts',
  'packages/shared/src/video-outline.ts', 'packages/shared/src/content.ts',
]
const visited = new Set()
async function resolveSource(path) {
  for (const suffix of ['', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']) {
    try { await access(join(source, path + suffix)); return path + suffix } catch { /* try next source suffix */ }
  }
  throw new Error(`Missing upstream dependency: ${path}`)
}
while (queue.length) {
  const path = await resolveSource(queue.shift())
  if (visited.has(path)) continue
  visited.add(path)
  await copyFile(path)
  if (!/\.[cm]?[jt]sx?$/.test(path)) continue
  const text = await readFile(join(source, path), 'utf8')
  const imports = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g
  for (const match of text.matchAll(imports)) {
    const name = match[1] || match[2]
    if (name.startsWith('.')) queue.push(relative(source, resolve(source, dirname(path), name)))
    else if (name.startsWith('@/')) queue.push(`apps/web/src/${name.slice(2)}`)
    else if (name.startsWith('@edgeever/shared/')) queue.push(`packages/shared/src/${name.slice('@edgeever/shared/'.length)}`)
  }
}
const files = {}
for (const path of [...copied].sort()) files[path] = createHash('sha256').update(await readFile(join(target, path))).digest('hex')
await writeFile(join(target, 'UPSTREAM.json'), JSON.stringify({ repository: 'https://github.com/tianma-if/edgeever', commit: PIN, license: 'AGPL-3.0-only', files }, null, 2) + '\n')
console.log(`Imported ${copied.size} unchanged upstream files at ${PIN}`)
