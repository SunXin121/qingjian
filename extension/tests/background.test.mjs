import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const bundle = await build({ entryPoints: [new URL('../src/background.js', import.meta.url).pathname], bundle: true, write: false, format: 'iife' })
const draft = { version: 1, title: '测试文章', url: 'https://source.example/article', markdown: '**正文**', mode: 'article', capturedAt: '2026-06-01T00:00:00Z' }
const settle = () => new Promise((resolve) => setImmediate(resolve))

function harness() {
  const local = {}, session = {}, scripts = [], navigations = []
  let onMessage, onUpdated
  let nextTab = 20
  let failInjection = false
  const storage = (data) => ({
    get: async (key) => ({ [key]: data[key] }),
    set: async (values) => Object.assign(data, values),
    remove: async (key) => { delete data[key] },
  })
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener: (fn) => { onMessage = fn } } },
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      onUpdated: { addListener: (fn) => { onUpdated = fn } },
      onRemoved: { addListener: () => {} },
      get: async () => ({ id: 1, url: draft.url, title: draft.title }),
      create: async () => ({ id: nextTab++ }),
      update: async (id, options) => { navigations.push({ id, ...options }) },
      sendMessage: async () => ({ draft }),
    },
    scripting: { executeScript: async (script) => {
      scripts.push(script)
      if (script.func && failInjection) throw new Error('权限不足')
      return [{ result: true }]
    } },
  }
  runInNewContext(bundle.outputFiles[0].text, { chrome, URL, TextEncoder, console })
  return {
    local, session, scripts, navigations,
    failInjection: () => { failInjection = true },
    send: (message) => new Promise((resolve) => onMessage(message, { id: chrome.runtime.id }, resolve)),
    complete: async (tabId, url) => { onUpdated(tabId, { status: 'complete' }, { url }); await settle(); await settle() },
  }
}

test('草稿交接在目标页加载后执行，清除待办并保留恢复副本', async () => {
  const h = harness()
  assert.equal((await h.send({ type: 'qj-clip', tabId: 1, mode: 'article', server: 'https://notes.example' })).ok, true)
  assert.equal(h.navigations[0].url, 'https://notes.example/clip')
  assert.ok(h.session['pending:20'])
  await h.complete(20, 'https://notes.example/clip')
  assert.equal(h.session['pending:20'], undefined)
  const delivery = h.scripts.find((script) => script.func)
  assert.equal(delivery.args[0].markdown, draft.markdown)
  assert.equal(delivery.args[1], 'qj.clip.draft')
  assert.equal(h.local.lastClip.title, draft.title)
})

test('未登录时可把草稿交给登录页；不同标签页分别排队', async () => {
  const h = harness()
  for (let i = 0; i < 2; i++) await h.send({ type: 'qj-clip', tabId: 1, mode: 'link', server: 'http://localhost:8080' })
  await h.complete(20, 'http://localhost:8080/login?next=%2Fclip')
  assert.equal(h.session['pending:20'], undefined)
  assert.ok(h.session['pending:21'])
  await h.complete(21, 'http://localhost:8080/clip')
  assert.equal(h.session['pending:21'], undefined)
})

test('跳到其他来源时不注入，报告错误且可恢复', async () => {
  const h = harness()
  await h.send({ type: 'qj-clip', tabId: 1, mode: 'article', server: 'https://notes.example' })
  const before = h.scripts.length
  await h.complete(20, 'https://elsewhere.example/clip')
  assert.equal(h.scripts.length, before)
  assert.match(h.local.clipError, /意外跳转/)
  assert.ok(h.session['pending:20'])
  assert.equal((await h.send({ type: 'qj-retry', server: 'https://notes.example' })).ok, true)
})

test('注入函数再次核对来源，权限失败不丢草稿', async () => {
  const h = harness()
  await h.send({ type: 'qj-clip', tabId: 1, mode: 'article', server: 'https://notes.example' })
  h.failInjection()
  await h.complete(20, 'https://notes.example/clip')
  assert.match(h.local.clipError, /权限不足/)
  assert.ok(h.local.lastClip)
  const delivery = h.scripts.find((script) => script.func)
  const result = runInNewContext(`(${delivery.func.toString()})(...args)`, { args: delivery.args, location: { origin: 'https://other.example', pathname: '/clip' } })
  assert.equal(result, false)
})
