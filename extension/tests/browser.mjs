// Full Chromium extension + real Qingjian API smoke test. Only the test manifest
// grants localhost up front; distributed manifests retain normal permission UI.
import assert from 'node:assert/strict'
import { chromium, request } from 'playwright'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = fileURLToPath(new URL('..', import.meta.url))
const projectRoot = resolve(extensionRoot, '..')
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'qingjian-clipper-browser-'))
const image = await readFile(join(projectRoot, 'web/public/icon-192.png'))
const fixture = createServer((req, res) => {
  if (req.url === '/photo.png') { res.setHeader('Content-Type', 'image/png'); res.end(image); return }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><html lang="zh-CN"><head><title>剪藏端到端测试</title></head><body>
    <nav>这段导航不应进入正文</nav><article><h1>剪藏端到端测试</h1>
    ${'<p>文章正文，验证真实浏览器中的剪藏、中文格式以及图片附件保存。这篇文章有充分的正文信息。</p>'.repeat(12)}
    <p id="selected">唯一选区文字 <strong>保留强调</strong></p>
    <section><p id="region-target">只保存这个区域：区域内容验收。</p></section>
    <figure><img src="/photo.png" alt="验收图片"><figcaption>图片说明</figcaption></figure>
    <table><tr><th>字段</th><th>值</th></tr><tr><td>表格</td><td>正文</td></tr></table>
    </article><footer>页脚不应进入正文</footer></body></html>`)
})
await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
const sourceURL = `http://127.0.0.1:${fixture.address().port}`
const reservation = createServer()
await new Promise((done) => reservation.listen(0, '127.0.0.1', done))
const serverPort = reservation.address().port
await new Promise((done) => reservation.close(done))
const serverURL = `http://127.0.0.1:${serverPort}`
const localPassword = ' 管理:剪藏密码 '
let serverLog = ''
const server = spawn('go', ['run', './cmd/qingjian'], {
  cwd: projectRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QINGJIAN_ADDR: `127.0.0.1:${serverPort}`, QINGJIAN_DATA: join(temp, 'data'), QINGJIAN_ADMIN_PASSWORD: localPassword },
})
server.stdout.on('data', (data) => { serverLog += data.toString() })
server.stderr.on('data', (data) => { serverLog += data.toString() })
let browser, admin, options
const checks = []
try {
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(`${serverURL}/healthz`)).ok) { ready = true; break } } catch { /* server still compiling */ }
    if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`)
    await new Promise((done) => setTimeout(done, 200))
  }
  assert.ok(ready, `Fixture server did not start: ${serverLog}`)
  admin = await request.newContext({ baseURL: serverURL })
  const json = async (method, path, data) => {
    const response = await admin.fetch(path, { method, data })
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`)
    return response.json()
  }
  await json('POST', '/api/auth/login', { password: localPassword })
  const repo = await json('POST', '/api/repos', { name: '扩展浏览器验收' })
  const testExtension = join(temp, 'extension')
  await cp(join(extensionRoot, 'dist'), testExtension, { recursive: true })
  const manifestPath = join(testExtension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.host_permissions = [...(manifest.host_permissions || []), 'http://127.0.0.1/*']
  await writeFile(manifestPath, JSON.stringify(manifest))
  browser = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`, '--no-sandbox'],
  })
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 20000 })
  const extensionId = new URL(worker.url()).host
  await browser.addCookies((await admin.storageState()).cookies)
  const setup = await browser.newPage()
  await setup.goto(`${serverURL}/clip`)
  await setup.waitForURL(`${serverURL}/`)
  assert.equal(await setup.locator('a[href="/clip"]').count(), 0)
  assert.equal(await setup.getByText('视频摘要模型', { exact: true }).count(), 0)
  assert.equal((await admin.get('/api/clipper/settings')).status(), 404)
  checks.push('removed clip page redirects home without clip navigation or model settings')
  await setup.close()
  options = await browser.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await options.locator('#instance-url').waitFor()
  await options.locator('#instance-url').fill(serverURL)
  await options.locator('#password').fill(localPassword)
  await options.locator('#test').click()
  await options.waitForFunction(() => document.querySelector('#status')?.getAttribute('data-kind') === 'success')
  await options.locator('#notebook-id').selectOption(repo.id)
  await options.locator('#save').click()
  await options.waitForFunction(() => document.querySelector('#status')?.getAttribute('data-kind') === 'success')
  // Wait for the persisted settings rather than a previous success label.
  await options.waitForFunction(async (repoId) => (await chrome.storage.local.get('notebookId')).notebookId === repoId, repo.id)
  checks.push('extension settings UI connects and persists destination')
  const page = await browser.newPage()
  await page.goto(`${sourceURL}/article`)
  const send = async (type) => {
    await page.bringToFront()
    const result = await options.evaluate((type) => chrome.runtime.sendMessage({ type }), type)
    assert.equal(result?.ok, true, result?.message || `${type} failed`)
    return result
  }
  const docs = async () => (await json('GET', `/api/repos/${repo.id}/tree`)).filter((node) => node.type === 'doc')
  await send('captureCurrentPage')
  let notes = await docs()
  assert.equal(notes.length, 1)
  let doc = await json('GET', `/api/docs/${notes[0].id}`)
  assert.match(doc.markdown, /文章正文/)
  assert.doesNotMatch(doc.markdown, /这段导航不应进入正文|页脚不应进入正文/)
  assert.match(doc.markdown, /\/files\//)
  assert.doesNotMatch(doc.markdown, /\/api\/v1\/resources\/|EDGEVERRESOURCEID/)
  const storedImage = doc.markdown.match(/\/files\/[^)\s>]+/)?.[0]
  assert.ok(storedImage)
  assert.equal((await admin.get(storedImage)).status(), 200)
  checks.push('real worker captures article and localizes image to native attachment')
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#selected'))
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  })
  await send('captureCurrentPage')
  notes = await docs()
  assert.equal(notes.length, 2)
  doc = await json('GET', `/api/docs/${notes.find((node) => node.id !== doc.id).id}`)
  assert.match(doc.markdown, /唯一选区文字/)
  assert.doesNotMatch(doc.markdown, /文章正文，验证/)
  checks.push('selected content takes priority over article')
  await page.evaluate(() => getSelection().removeAllRanges())
  await send('startRegionClip')
  await page.locator('#edgeever-region-picker').waitFor()
  await page.locator('#region-target').click()
  await page.locator('#edgeever-region-picker').locator('#region-save').click()
  await page.locator('#edgeever-region-picker').waitFor({ state: 'detached', timeout: 20000 })
  notes = await docs()
  assert.equal(notes.length, 3)
  const regionDocs = await Promise.all(notes.map((node) => json('GET', `/api/docs/${node.id}`)))
  assert.ok(regionDocs.some((item) => item.markdown.includes('只保存这个区域') && !item.markdown.includes('文章正文，验证') && !item.markdown.includes('唯一选区文字')))
  checks.push('real shadow-DOM region picker saves only chosen region')
  await send('startRegionClip')
  await page.locator('#edgeever-region-picker').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('#edgeever-region-picker').waitFor({ state: 'detached' })
  assert.equal((await docs()).length, 3)
  checks.push('Escape cancels without creating a note')
  const otherRepo = await json('POST', '/api/repos', { name: '另一个目标笔记本' })
  const folder = await json('POST', '/api/nodes', { repo_id: otherRepo.id, type: 'group', title: '剪藏目录' })
  await options.evaluate((notebookId) => chrome.storage.local.set({ notebookId }), `${otherRepo.id}:${folder.id}`)
  const pageCount = browser.pages().length
  await send('captureCurrentPage')
  const otherDocs = (await json('GET', `/api/repos/${otherRepo.id}/tree`)).filter((node) => node.type === 'doc')
  assert.equal(otherDocs.length, 1)
  assert.equal(otherDocs[0].parent_id, folder.id)
  assert.equal((await docs()).length, 3)
  assert.equal(browser.pages().length, pageCount)
  checks.push('changed destination saves directly into selected notebook group without a preview tab')
  await options.evaluate(() => chrome.storage.local.set({ password: 'incorrect-password' }))
  await page.bringToFront()
  const rejected = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'captureCurrentPage' }))
  assert.equal(rejected?.ok, false)
  assert.equal((await docs()).length, 3)
  checks.push('wrong admin password prevents extension writes')
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2))
} finally {
  await browser?.close()
  await admin?.dispose()
  try { process.kill(-server.pid, 'SIGTERM') } catch { /* process already exited */ }
  await new Promise((done) => fixture.close(done))
  await rm(temp, { recursive: true, force: true })
}
