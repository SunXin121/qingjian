import { CLIP_DRAFT_KEY, CLIP_EVENT, clipServer, parseClipDraft } from '../../web/src/clipper.ts'

const pendingKey = (tabId) => `pending:${tabId}`
const delivering = new Set()

async function deliver(tabId, tab) {
  if (delivering.has(tabId)) return
  delivering.add(tabId)
  try {
    const key = pendingKey(tabId)
    const job = (await chrome.storage.session.get(key))[key]
    if (!job) return
    const target = new URL(tab.url || '')
    // A server may redirect /clip to /login; both use the same sessionStorage.
    if (target.origin !== job.server || !['/clip', '/login'].includes(target.pathname)) throw new Error('青简页面发生了意外跳转，请检查站点地址并重试')
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (draft, key, event, expectedOrigin) => {
        if (location.origin !== expectedOrigin || !['/clip', '/login'].includes(location.pathname)) return false
        sessionStorage.setItem(key, JSON.stringify(draft))
        window.dispatchEvent(new Event(event))
        return true
      },
      args: [job.draft, CLIP_DRAFT_KEY, CLIP_EVENT, job.server],
    })
    if (!results[0]?.result) throw new Error('草稿交接失败，请在扩展中重试')
    await chrome.storage.session.remove(key)
    await chrome.storage.local.remove('clipError')
  } catch (error) {
    await chrome.storage.local.set({ clipError: error.message || '无法连接青简，请检查地址并重试' })
  } finally { delivering.delete(tabId) }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && /^https?:\/\//.test(tab.url || '')) void deliver(tabId, tab)
})
chrome.tabs.onRemoved.addListener((tabId) => { void chrome.storage.session.remove(pendingKey(tabId)) })

async function openDraft(serverInput, draftInput) {
  const { url: server } = clipServer(serverInput)
  const draft = parseClipDraft(draftInput)
  // Keep one local recovery copy in case navigation, permissions or login fails.
  await chrome.storage.local.set({ lastClip: draft, server, clipError: '' })
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false })
  await chrome.storage.session.set({ [pendingKey(tab.id)]: { server, draft } })
  try { await chrome.tabs.update(tab.id, { url: `${server}/clip`, active: true }) }
  catch (error) {
    await chrome.storage.session.remove(pendingKey(tab.id))
    throw error
  }
  return { ok: true }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || !['qj-clip', 'qj-retry'].includes(message.type)) return
  const run = async () => {
    if (message.type === 'qj-retry') {
      const { lastClip } = await chrome.storage.local.get('lastClip')
      if (!lastClip) throw new Error('没有可恢复的草稿')
      return openDraft(message.server, lastClip)
    }
    if (message.type !== 'qj-clip') throw new Error('未知操作')
    const tab = await chrome.tabs.get(message.tabId)
    if (!/^https?:\/\//.test(tab.url || '')) throw new Error('此页面不支持剪藏，请打开普通网页')
    let draft
    if (message.mode === 'link') {
      draft = { version: 1, title: tab.title || tab.url, url: tab.url, markdown: '', mode: 'link', capturedAt: new Date().toISOString() }
    } else {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] })
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'qj-capture', mode: message.mode })
      if (result?.error) throw new Error(result.error)
      draft = result?.draft
    }
    return openDraft(message.server, draft)
  }
  run().then(respond).catch((error) => respond({ error: error.message || '剪藏失败，请重试' }))
  return true
})
