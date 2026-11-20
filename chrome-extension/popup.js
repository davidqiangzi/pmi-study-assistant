const elements = Object.fromEntries(['state', 'phase', 'target', 'status', 'action', 'hint', 'recovery', 'clearPending', 'clearDialog', 'error']
  .map(id => [id, document.getElementById(id)]))
const listingUrl = 'https://www.projectmanagement.com/webinars/webinarmainondemand.cfm'
const phaseLabels = {
  watch: '播放阶段',
  rating: '等待评分确认',
  recover: '核对评分',
  rated: '准备切课',
  listing: '筛选课程',
}
let model
let busy = false
let refreshing = false

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value
}

function showError(message = '') {
  setText(elements.error, message)
  elements.error.hidden = !message
}

function render(data) {
  const { active, phase, pending, pendingHere, tabKind, tabTitle, target, status } = data
  const course = tabKind === 'course'
  const outside = tabKind === 'other'
  const rawTitle = active ? target : course ? tabTitle : ''
  const title = rawTitle?.replace(/^ProjectManagement\.com\s*(?:[-–—|:]\s*)?/i, '').trim() || rawTitle
  elements.state.dataset.tone = active ? 'live' : pending || status ? 'warning' : 'neutral'
  setText(elements.phase, active ? phaseLabels[phase] || '正在运行' : pending ? '评分待核对' : '自动流程未运行')
  setText(elements.target, title || '')
  elements.target.title = title || ''
  elements.target.hidden = !title
  setText(elements.status, status || (pending ? '请回原课程页查看是否已保存评分。' : course ? '可以从当前播放位置开始。' : outside ? '请打开 PMI 点播列表或课程页。' : '可以在当前筛选结果页选择课程。'))
  elements.action.disabled = busy
  setText(elements.action, active ? '停止自动流程' : pending ? pendingHere ? '核对评分并继续' : '打开原课程' : outside ? '打开点播列表' : course ? '从当前课程开始' : '从当前列表选课')
  const hint = active ? '关闭此面板后流程会继续运行。' : pending ? '核对只读取原课程的评分状态。'
    : outside ? '' : '请完整观看。播完后会自动提交 5 星评分并切课。'
  setText(elements.hint, hint)
  elements.hint.hidden = !hint
  elements.recovery.hidden = active || !pending
  elements.clearPending.disabled = busy
}

async function request(action, tab) {
  const result = await chrome.runtime.sendMessage({ action, tabId: tab?.id })
  if (!result || result.error) throw new Error(result?.error || '助手未响应，请关闭面板后重试。')
  return result
}

async function refresh() {
  if (busy || refreshing) return
  refreshing = true
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    model = { ...await request('status', tab), tab }
    render(model)
  } catch (error) {
    showError(error.message)
  } finally {
    refreshing = false
  }
}

async function perform(operation) {
  if (busy || !model) return
  busy = true
  showError()
  render(model)
  try {
    await operation(model)
  } catch (error) {
    showError(error.message)
  } finally {
    busy = false
    render(model)
    await refresh()
  }
}

elements.action.onclick = () => perform(data => {
  if (data.active) return request('stop')
  if (data.pending && !data.pendingHere) {
    if (!data.pendingUrl) throw new Error('无法定位原课程，请核对后解除待核对记录。')
    return chrome.tabs.create({ url: data.pendingUrl })
  }
  if (data.tabKind === 'other') return chrome.tabs.create({ url: listingUrl })
  return request('start', data.tab)
})

elements.clearPending.onclick = () => elements.clearDialog.showModal()
elements.clearDialog.onclose = () => {
  if (elements.clearDialog.returnValue === 'clear') perform(() => request('clearPending'))
  elements.clearDialog.returnValue = ''
}
refresh()
setInterval(refresh, 2000)
