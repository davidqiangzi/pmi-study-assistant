const host = /^https:\/\/(?:www\.)?projectmanagement\.com\//
const course = /^https:\/\/(?:www\.)?projectmanagement\.com\/videos\/\d+(?:\/|$)/
const listing = /^https:\/\/(?:www\.)?projectmanagement\.com\/webinars\/webinarmainondemand\.cfm(?:[?#]|$)/
const courseId = url => course.test(url || '') ? new URL(url).pathname.split('/')[2] : undefined
const popupUrl = chrome.runtime.getURL('popup.html')
let queue = Promise.resolve()

async function handle(message, sender) {
  const { workflow: flow } = await chrome.storage.session.get('workflow')
  if (sender.url === popupUrl && message.action === 'status') {
    const { pendingRating } = await chrome.storage.local.get('pendingRating')
    const tab = Number.isInteger(message.tabId) ? await chrome.tabs.get(message.tabId).catch(() => undefined) : undefined
    const id = courseId(tab?.url)
    return {
      status: flow?.status || '',
      active: Boolean(flow?.active),
      phase: flow?.phase,
      target: flow?.target || '',
      tabKind: id ? 'course' : listing.test(tab?.url || '') ? 'listing' : 'other',
      tabTitle: id ? tab.title : '',
      pending: Boolean(pendingRating),
      pendingHere: Boolean(id && id === courseId(pendingRating)),
      pendingUrl: courseId(pendingRating) ? pendingRating : '',
    }
  }
  if (sender.url === popupUrl && message.action === 'clearPending') {
    if (flow?.active) throw new Error('请先停止接管')
    await chrome.storage.local.remove('pendingRating')
    return { status: '已解除待核对记录，可以重新接管' }
  }
  if (sender.url === popupUrl && message.action === 'stop') {
    await chrome.storage.session.remove('workflow')
    return { status: '已停止接管' }
  }
  if (sender.url === popupUrl && message.action === 'start') {
    const tab = await chrome.tabs.get(message.tabId)
    if (!course.test(tab.url) && !listing.test(tab.url)) throw new Error('请先打开已登录的 PMI 视频页或点播列表')
    if (flow?.active) throw new Error('已有运行中的课程，请先停止接管')
    const pending = (await chrome.storage.local.get('pendingRating')).pendingRating
    const id = courseId(tab.url)
    if (pending && (!id || id !== courseId(pending))) {
      throw new Error('请在原课程页恢复并核对评分')
    }
    await chrome.storage.session.set({ workflow: {
      active: true, tabId: tab.id, courseId: id, phase: pending ? 'recover' : id ? 'watch' : 'listing',
      status: pending ? '正在核对原课程的评分状态' : id ? '正在读取播放器状态' : '正在读取课程列表',
      target: id ? tab.title : '', seen: [],
    } })
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['course.js'] })
    } catch (error) {
      await chrome.storage.session.remove('workflow')
      throw error
    }
    return { status: '已接管当前课程' }
  }
  if (!flow?.active || sender.tab?.id !== flow.tabId || sender.frameId !== 0
    || !sender.documentId || !host.test(sender.url || '')) return {}
  const id = courseId(sender.url)
  if (flow.courseId ? id !== flow.courseId : !listing.test(sender.url)) return {}
  if (message.action === 'current') {
    if (sender.documentId === flow.previousDocumentId) return {}
    if (!flow.documentId) {
      flow.documentId = sender.documentId
      if (id && sender.tab.title) flow.target = sender.tab.title
      await chrome.storage.session.set({ workflow: flow })
    }
    if (flow.documentId !== sender.documentId) {
      if (sender.documentLifecycle === 'cached' || sender.documentLifecycle === 'pending_deletion') return {}
      flow.active = false
      flow.status = '页面已重新加载，请重新接管'
      await chrome.storage.session.set({ workflow: flow })
      return {}
    }
    return { active: true, seen: flow.seen, phase: flow.phase }
  }
  if (flow.documentId !== sender.documentId) return {}
  if (message.action === 'progress' && ['watch', 'listing'].includes(flow.phase)) {
    flow.status = String(message.status).slice(0, 120)
  }
  if (message.action === 'failed') {
    flow.status = message.status
    flow.active = false
  }
  if (message.action === 'rating') {
    if (flow.phase !== 'watch' || !id) throw new Error('当前课程不在可评分阶段')
    flow.phase = 'rating'
    flow.status = '正在等待网站确认五星评分'
    await chrome.storage.session.set({ workflow: flow })
    await chrome.storage.local.set({ pendingRating: sender.url })
    await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: 'MAIN',
      func: () => {
        const alert = window.alert
        const confirm = window.confirm
        const isRatingReceipt = message =>
          /^\s*(?:Thanks for rating|Thank you for rating)[!.！。]?\s*$/i.test(String(message))
        function restore() {
          if (window.alert === ratingAlert) window.alert = alert
          if (window.confirm === ratingConfirm) window.confirm = confirm
        }
        function ratingAlert(message) {
          if (!isRatingReceipt(message)) return alert.call(window, message)
          restore()
        }
        function ratingConfirm(message) {
          if (!isRatingReceipt(message)) return confirm.call(window, message)
          restore()
          return true
        }
        window.alert = ratingAlert
        window.confirm = ratingConfirm
        setTimeout(restore, 90000)
      },
    })
  }
  if (message.action === 'rated') {
    if (!id || !['watch', 'rating', 'recover'].includes(flow.phase)) throw new Error('评分确认阶段不匹配')
    const { pendingRating } = await chrome.storage.local.get('pendingRating')
    if (flow.phase !== 'watch' && courseId(pendingRating) !== id) throw new Error('待核对评分不匹配')
    if (courseId(pendingRating) === id) await chrome.storage.local.remove('pendingRating')
    flow.phase = 'rated'
    flow.status = '已确认 5 星，等待切课'
    if (!flow.seen.includes(id)) flow.seen.push(id)
  }
  if (message.action === 'retryList') {
    if (flow.phase !== 'listing') throw new Error('当前阶段无法重试列表')
    if (flow.listRetried) throw new Error('重新加载后仍未读取到课程，请检查 PMI 登录或列表加载状态')
    flow.listRetried = true
    flow.previousDocumentId = flow.documentId
    delete flow.documentId
    flow.status = '列表加载超时，正在重新加载一次'
    await chrome.storage.session.set({ workflow: flow })
    try {
      await chrome.tabs.reload(flow.tabId)
    } catch (error) {
      flow.active = false
      flow.status = '课程列表重新加载失败'
      await chrome.storage.session.set({ workflow: flow })
      throw error
    }
    return {}
  }
  if (message.action === 'select') {
    const selected = courseId(message.status)
    if (flow.phase !== 'listing' || !selected || flow.seen.includes(selected)) {
      throw new Error('候选课程或选课阶段不匹配')
    }
    flow.phase = 'watch'
    flow.courseId = selected
    delete flow.documentId
    flow.status = '已选中下一门课程，正在打开'
    delete flow.target
    await chrome.storage.session.set({ workflow: flow })
    try {
      await chrome.tabs.update(flow.tabId, { url: message.status })
    } catch (error) {
      flow.active = false
      flow.status = '打开候选课程失败'
      await chrome.storage.session.set({ workflow: flow })
      throw error
    }
    return {}
  }
  if (message.action === 'list') {
    if (!id || flow.phase !== 'rated') throw new Error('评分尚未确认，无法切课')
    flow.status = '正在筛选下一门课程'
    delete flow.target
    const list = new URL('/webinars/webinarmainondemand.cfm', sender.url)
    const tab = await chrome.tabs.create({ url: list.href, active: true, windowId: sender.tab.windowId })
    flow.tabId = tab.id
    flow.phase = 'listing'
    delete flow.listRetried
    delete flow.courseId
    delete flow.documentId
    await chrome.storage.session.set({ workflow: flow })
    await chrome.tabs.remove(sender.tab.id)
    return {}
  }
  await chrome.storage.session.set({ workflow: flow })
  return { status: flow.status }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const task = queue.then(() => handle(message, sender))
  queue = task.catch(() => {})
  task.then(respond, error => respond({ error: error.message, status: error.message }))
  return true
})

function stopOwnedTab(tabId, status, url) {
  queue = queue.then(async () => {
    const { workflow: flow } = await chrome.storage.session.get('workflow')
    if (flow?.active && flow.tabId === tabId
      && (!url || (flow.courseId ? courseId(url) !== flow.courseId : !listing.test(url)))) {
      flow.active = false
      flow.status = status
      await chrome.storage.session.set({ workflow: flow })
    }
  }).catch(error => console.warn('PMI 学习助手无法更新标签页状态', error))
}

chrome.tabs.onRemoved.addListener(tabId => stopOwnedTab(tabId, '接管的标签页已关闭'))
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) stopOwnedTab(tabId, '已离开接管页面，请重新接管', change.url)
})
