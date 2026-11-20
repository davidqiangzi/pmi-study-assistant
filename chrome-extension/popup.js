const status = document.getElementById('status')
let busy = false
async function send(action) {
  if (busy) return
  busy = true
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const response = await chrome.runtime.sendMessage({ action, tabId: tab?.id })
    status.textContent = response?.status || '扩展未返回状态'
    if (action === 'status' || action === 'clearPending') {
      document.getElementById('clearPending').hidden = !response?.pending
    }
  } catch (error) {
    status.textContent = error.message
  } finally {
    busy = false
  }
}
document.getElementById('start').onclick = () => send('start')
document.getElementById('stop').onclick = () => send('stop')
document.getElementById('clearPending').onclick = () => {
  if (confirm('请先在原课程页核对评分。确认要解除待核对记录？此操作不修改网站评分。')) {
    send('clearPending')
  }
}
send('status')
setInterval(() => send('status'), 2000)
