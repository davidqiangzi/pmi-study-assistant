const host = /^https:\/\/(?:www\.)?projectmanagement\.com\//
const course = /^https:\/\/(?:www\.)?projectmanagement\.com\/videos\/\d+(?:\/|$)/
const listing = /^https:\/\/(?:www\.)?projectmanagement\.com\/webinars\/webinarmainondemand\.cfm(?:[?#]|$)/
const courseId = url => course.test(url || '') ? new URL(url).pathname.split('/')[2] : undefined
const popupUrl = chrome.runtime.getURL('popup.html')
let queue = Promise.resolve()

const ratingSessions = new Map()

async function detachRating(tabId) {
  const session = ratingSessions.get(tabId)
  if (!session) return
  ratingSessions.delete(tabId)
  clearTimeout(session.timer)
  await chrome.debugger.detach({ tabId }).catch(() => {})
}

async function armRating(tabId, id) {
  const target = { tabId }
  await chrome.debugger.attach(target, '1.3')
  const session = { id, timer: setTimeout(() => detachRating(tabId), 90000) }
  ratingSessions.set(tabId, session)
  try {
    await chrome.debugger.sendCommand(target, 'Page.enable')
  } catch (error) {
    await detachRating(tabId)
    throw error
  }
}

chrome.debugger.onEvent.addListener((source, method, dialog) => {
  const session = ratingSessions.get(source.tabId)
  if (!session || method !== 'Page.javascriptDialogOpening'
    || !['alert', 'confirm'].includes(dialog?.type)
    || courseId(dialog.url) !== session.id
    || !/^\s*Thanks for rating!\s*$/i.test(dialog.message)) return

  queue = queue.then(async () => {
    const { workflow } = await chrome.storage.session.get('workflow')
    if (ratingSessions.get(source.tabId) !== session || !workflow?.active
      || workflow.tabId !== source.tabId || workflow.courseId !== session.id
      || workflow.phase !== 'rating') return
    await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true })
    await detachRating(source.tabId)
  }).catch(error => console.warn('无法自动确认评分提示，请在 Chrome 中处理', error))
})

chrome.debugger.onDetach.addListener(source => {
  clearTimeout(ratingSessions.get(source.tabId)?.timer)
  ratingSessions.delete(source.tabId)
})

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
    await detachRating(flow?.tabId)
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
    if (sender.documentId === flow.previousDocumentId
      || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return {}
    if (flow.documentId && flow.documentId !== sender.documentId) {
      // A queued message can arrive from a document Chrome has already replaced.
      const [live] = await chrome.scripting.executeScript({
        target: { tabId: flow.tabId, frameIds: [0] },
        func: () => true,
      }).catch(() => [])
      if (live?.documentId !== sender.documentId) return {}
      if (!['watch', 'listing'].includes(flow.phase)) {
        flow.active = false
        flow.status = '评分期间页面已重新加载，请核对原课程后继续'
        await detachRating(flow.tabId)
        await chrome.storage.session.set({ workflow: flow })
        return {}
      }
      flow.previousDocumentId = flow.documentId
      delete flow.documentId
      flow.status = id ? '课程页面已重新加载，正在恢复播放' : '列表已重新加载，正在恢复筛选'
    }
    if (!flow.documentId) {
      flow.documentId = sender.documentId
      if (id && sender.tab.title) flow.target = sender.tab.title
      await chrome.storage.session.set({ workflow: flow })
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
    await detachRating(sender.tab.id)
  }
  if (message.action === 'rating') {
    if (flow.phase !== 'watch' || !id) throw new Error('当前课程不在可评分阶段')
    flow.phase = 'rating'
    flow.status = '正在核对五星评分。若 Chrome 弹出提示，请点击「确定」'
    await chrome.storage.session.set({ workflow: flow })
    await chrome.storage.local.set({ pendingRating: sender.url })
    try {
      await armRating(sender.tab.id, id)
    } catch {
      flow.status = '自动确认未连接。如有 Chrome 评分提示，请点击「确定」'
      await chrome.storage.session.set({ workflow: flow })
    }

  }
  if (message.action === 'rated') {
    if (!id || !['watch', 'rating', 'recover'].includes(flow.phase)) throw new Error('评分确认阶段不匹配')
    const { pendingRating } = await chrome.storage.local.get('pendingRating')
    if (flow.phase !== 'watch' && courseId(pendingRating) !== id) throw new Error('待核对评分不匹配')
    await detachRating(sender.tab.id)
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
      await detachRating(tabId)
      await chrome.storage.session.set({ workflow: flow })
    }
  }).catch(error => console.warn('PMI 学习助手无法更新标签页状态', error))
}

chrome.tabs.onRemoved.addListener(tabId => stopOwnedTab(tabId, '接管的标签页已关闭'))
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) stopOwnedTab(tabId, '已离开接管页面，请重新接管', change.url)
})
