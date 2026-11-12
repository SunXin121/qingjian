import { symlink, lstat, readlink, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Upstream bundle tests resolve tools from the original monorepo root. Keep the
// source tree unchanged and point that root at this extension's installed tools.
const path = fileURLToPath(new URL('../vendor/edgeever/node_modules', import.meta.url))
try {
  const stat = await lstat(path)
  if (!stat.isSymbolicLink() || await readlink(path) !== '../../node_modules') throw new Error('Unexpected vendor node_modules; refusing to overwrite')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await symlink('../../node_modules', path, 'junction')
}

// npm ignores Bun's patchedDependencies and silently breaks rich table capture.
const gfm = await readFile(new URL('../node_modules/@joplin/turndown-plugin-gfm/lib/turndown-plugin-gfm.cjs.js', import.meta.url), 'utf8')
if (!gfm.includes('options.preserveTableHtml === false')) throw new Error('Missing upstream GFM fix: install extension dependencies with bun install --frozen-lockfile')
