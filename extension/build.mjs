// Qingjian build for the directly adapted EdgeEver clipping sources.
import './scripts/prepare.mjs'
import { build as viteBuild, loadConfigFromFile, mergeConfig } from 'vite'
import { build as bundle } from 'esbuild'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { brandMessages } from './scripts/branding.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const firefox = process.argv.includes('--firefox')
if (firefox) process.env.EDGE_EVER_EXTENSION_TARGET = 'firefox'
const upstream = join(here, 'vendor/edgeever/apps/extension')
const out = join(here, firefox ? 'dist-firefox' : 'dist')
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(upstream, 'vite.config.ts'))
if (!loaded) throw new Error('Unable to load upstream extension build')
const config = mergeConfig(loaded.config, {
  configFile: false,
  build: { outDir: out },
  plugins: [{
    name: 'qingjian-links-and-legacy-entry',
    transform(code, id) {
      if (!id.endsWith('/src/ui/options.tsx')) return
      return code.replaceAll('https://github.com/tianma-if/edgeever', 'https://github.com/sunxin121/qingjian')
        .replace('"https://edgeever.org/privacy"', 'chrome.runtime.getURL("privacy.html")')
    },
    transformIndexHtml(html, context) {
      return context.filename.endsWith('/popup.html')
        ? html.replace('</body>', '<a href="legacy.html" style="display:block;padding:8px 16px;font-size:12px;text-align:center;color:#52675b">预览 / 整页 / 仅链接</a></body>')
        : html
    },
  }],
})
await viteBuild(config)

// Retain the first version's preview-before-save, whole-page and bookmark modes.
await bundle({ entryPoints: {
  'legacy': join(here, 'src/popup.js'), 'legacy-background': join(here, 'src/background.js'), 'capture': join(here, 'src/capture.js'),
}, outdir: out, bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'eof' })
await writeFile(join(out, 'legacy.html'), (await readFile(join(here, 'popup.html'), 'utf8')).replace('src="popup.js"', 'src="legacy.js"'))
await cp(join(here, 'popup.css'), join(out, 'popup.css'))
const background = join(out, 'assets/background.js')
await writeFile(background, `import "../legacy-background.js";\n${await readFile(background, 'utf8')}`)

// Rebrand generated assets only: no upstream source, tests or marks are modified.
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
manifest.version = pkg.version
manifest.homepage_url = 'https://github.com/sunxin121/qingjian'
if (manifest.browser_specific_settings?.gecko) manifest.browser_specific_settings.gecko.id = 'clipper@qingjian.local'
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
for (const locale of await readdir(join(out, '_locales'))) {
  const path = join(out, '_locales', locale, 'messages.json')
  const messages = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify(brandMessages(messages, locale), null, 2) + '\n')
}
const sourceIcon = PNG.sync.read(await readFile(join(here, '../web/public/icon-192.png')))
for (const size of [16, 32, 48, 128]) {
  const icon = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = (Math.floor(y * sourceIcon.height / size) * sourceIcon.width + Math.floor(x * sourceIcon.width / size)) * 4
    sourceIcon.data.copy(icon.data, (y * size + x) * 4, from, from + 4)
  }
  await writeFile(join(out, 'icons', `icon-${size}.png`), PNG.sync.write(icon))
}
await mkdir(join(out, 'licenses'), { recursive: true })
for (const [name, license] of [['@mozilla/readability', 'LICENSE.md'], ['turndown', 'LICENSE'], ['@joplin/turndown-plugin-gfm', 'LICENSE']]) {
  await cp(join(here, 'node_modules', name, license), join(out, 'licenses', `${name.replaceAll('/', '-')}.txt`))
}
await cp(join(here, 'vendor/edgeever/LICENSE'), join(out, 'LICENSE.txt'))
await cp(join(here, 'vendor/edgeever/UPSTREAM.json'), join(out, 'UPSTREAM.json'))
await cp(join(here, 'MODIFICATIONS.md'), join(out, 'MODIFICATIONS.md'))
await cp(join(here, 'privacy.html'), join(out, 'privacy.html'))
console.log(`青简完整剪藏扩展已构建：${out}`)
