import { extractPage } from './extract.js'

// A fresh popup can inject again into the same page without accumulating listeners.
if (!globalThis.__qingjianClipper) {
  globalThis.__qingjianClipper = true
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'qj-capture') return
    try { respond({ draft: extractPage(document, message.mode) }) }
    catch (error) { respond({ error: error.message || '网页提取失败' }) }
  })
}
