import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminPasswordAuthorization } from '../src/adminPassword.ts'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const bundled = await build({
  stdin: { contents: 'export { getSettings, saveSettings, edgeEverRequest, edgeEverFormRequest } from "./vendor/edgeever/apps/extension/src/extension.ts"; export { postVideoOutline } from "./vendor/edgeever/apps/extension/src/video/video-note.ts";', resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
})
const { getSettings, saveSettings, edgeEverRequest, edgeEverFormRequest, postVideoOutline } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const settings = { instanceUrl: 'https://notes.example', password: ' 管理:剪藏密码 ', notebookId: 'notes' }
const expectedAuth = `Basic ${Buffer.from(`admin:${settings.password}`, 'utf8').toString('base64')}`

test('admin password authentication preserves UTF-8, colons and surrounding spaces', () => {
  assert.equal(adminPasswordAuthorization(settings.password), expectedAuth)
})

test('settings persist only address, admin password and destination', async () => {
  const previous = globalThis.chrome
  let saved
  globalThis.chrome = { storage: { local: {
    get: async () => ({ ...settings }),
    set: async (value) => { saved = value },
  } } }
  try {
    assert.deepEqual(await getSettings(), settings)
    await saveSettings(settings)
    assert.deepEqual(saved, settings)
    assert.deepEqual(Object.keys(saved).sort(), ['instanceUrl', 'notebookId', 'password'])
  } finally { globalThis.chrome = previous }
})

test('JSON and multipart requests use the same admin password without cookies', async () => {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    assert.equal(new Headers(init.headers).get('Authorization'), expectedAuth)
    assert.equal(init.credentials, 'omit')
    return Response.json({ ok: true })
  }
  try {
    await edgeEverRequest(settings, '/api/v1/notebooks')
    const form = new FormData()
    form.append('file', new Blob(['image']), 'image.png')
    await edgeEverFormRequest(settings, '/api/v1/memos/doc/resources', form)
    assert.equal(calls.length, 2)
    assert.equal(new Headers(calls[1].init.headers).has('Content-Type'), false)
  } finally { globalThis.fetch = previous }
})

test('video summary preparation authenticates directly with the admin password', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://notes.example/api/v1/ai/video-outline/prepare')
    assert.equal(new Headers(init.headers).get('Authorization'), expectedAuth)
    return Response.json({ error: { code: 'ai_not_configured' } }, { status: 409 })
  }
  try {
    const result = await postVideoOutline(settings, { platform: 'youtube', title: 'video', author: '', duration: 60, hasChapters: false, blocks: [{ start: 0, text: '字幕' }] })
    assert.deepEqual(result, { ok: false, reason: 'not_configured' })
  } finally { globalThis.fetch = previous }
})
