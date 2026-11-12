import { clipServer } from '../../web/src/clipper.ts'

const serverInput = document.querySelector('#server')
const modeInput = document.querySelector('#mode')
const status = document.querySelector('#status')
const submit = document.querySelector('#submit')
const retry = document.querySelector('#retry')
const clear = document.querySelector('#clear')
const activeTab = chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab)

chrome.storage.local.get(['server', 'mode', 'lastClip', 'clipError']).then((saved) => {
  serverInput.value = saved.server || ''
  modeInput.value = saved.mode || 'article'
  retry.hidden = clear.hidden = !saved.lastClip
  status.textContent = saved.clipError || ''
}).catch((error) => { status.textContent = error.message })

async function send(type) {
  try {
    const server = clipServer(serverInput.value)
    // Request synchronously from the click handler to retain the user gesture.
    const granted = await chrome.permissions.request({ origins: [server.permission] })
    if (!granted) throw new Error('需要允许访问你的青简站点，才能交接剪藏草稿')
    submit.disabled = retry.disabled = true
    status.textContent = '正在提取，请稍候…'
    await chrome.storage.local.set({ server: server.url, mode: modeInput.value })
    const tab = await activeTab
    const result = await chrome.runtime.sendMessage({ type, server: server.url, tabId: tab?.id, mode: modeInput.value })
    if (result?.error) throw new Error(result.error)
    window.close()
  } catch (error) {
    status.textContent = error.message || '剪藏失败，请重试'
    submit.disabled = retry.disabled = false
  }
}

document.querySelector('#clip-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void send('qj-clip')
})
retry.addEventListener('click', () => { void send('qj-retry') })
clear.addEventListener('click', async () => {
  await chrome.storage.local.remove(['lastClip', 'clipError'])
  retry.hidden = clear.hidden = true
  status.textContent = '已清除扩展中的草稿副本'
})
