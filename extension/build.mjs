import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true })
await mkdir(new URL('./dist/', import.meta.url), { recursive: true })
for (const name of ['manifest.json', 'popup.html', 'popup.css']) {
  await cp(new URL(`./${name}`, import.meta.url), new URL(`./dist/${name}`, import.meta.url))
}
await mkdir(new URL('./dist/licenses/', import.meta.url), { recursive: true })
for (const [pkg, name] of [['@mozilla/readability', 'LICENSE.md'], ['turndown', 'LICENSE'], ['turndown-plugin-gfm', 'LICENSE']]) {
  await cp(new URL(`./node_modules/${pkg}/${name}`, import.meta.url), new URL(`./dist/licenses/${pkg.replace('/', '-')}.txt`, import.meta.url))
}
await build({
  entryPoints: ['src/popup.js', 'src/background.js', 'src/capture.js'],
  absWorkingDir: new URL('.', import.meta.url).pathname,
  outdir: 'dist', bundle: true, format: 'iife', target: 'chrome120',
  minify: true, legalComments: 'eof',
})
console.log('扩展已构建到 extension/dist，可在 Chrome / Edge 中加载。')
