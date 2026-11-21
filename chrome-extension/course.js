(() => {
  if (globalThis.pmiStudyAssistantInstalled) return
  globalThis.pmiStudyAssistantInstalled = true
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const send = async (action, status) => {
    const result = await chrome.runtime.sendMessage({ action, status })
    if (result?.error) throw new Error(result.error)
    return result
  }
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
  const label = element => (element.getAttribute('aria-label') || element.getAttribute('title')
    || element.innerText || [...(element.labels || [])].map(item => item.innerText).join(' ')).trim()
  const clickable = element => visible(element) ? element : [...(element.labels || [])].find(visible)
  const find = (selector, name, root = document) => {
    const matches = [...root.querySelectorAll(selector)].filter(element => clickable(element) && name.test(label(element)))
    return matches.length === 1 ? matches[0] : undefined
  }
  async function current() {
    const result = await send('current')
    return result?.active ? result : undefined
  }
  async function until(check, timeout = 15000, reason = '未能确认页面状态，已停止') {
    const deadline = Date.now() + timeout
    while (await current()) {
      const value = check()
      if (value) return value
      if (Date.now() >= deadline) break
      await wait(300)
    }
    throw new Error(reason)
  }
  const rated = () => /YOUR RATING:\s*5 STARS|您的评分\s*[:：]?\s*5\s*星/i.test(document.body.innerText)
  const buttons = 'button,[role="button"]'
  async function watch() {
    const initial = await current()
    if (!initial) return
    if (initial.phase === 'recover') {
      try {
        await until(rated)
      } catch {
        throw new Error('未找到已保存的 5 星评分。请在网站核对后处理待确认记录')
      }
    }
    let attempts = 0
    let waitingSince
    let lastReport = -Infinity
    let lastPosition
    let lastAdvance = Date.now()
    while (initial.phase !== 'recover' && await current()) {
      const videos = [...document.querySelectorAll('video')].filter(visible)
      const primary = videos.filter(item => item.closest('.video-js') && !item.closest('.ima-ad-container'))
      const candidates = primary.length === 1 ? primary : videos
      if (candidates.length > 1) throw new Error('存在多个可见视频，无法确认课程播放器')
      const video = candidates[0]
      if (video?.ended) {
        if (rated()) break
        const played = video.played
        if (!Number.isFinite(video.duration) || played.length !== 1 || played.start(0) > 0.1
          || played.end(0) < video.duration - 0.1) throw new Error('播放覆盖不完整，请核对课程进度')
        break
      }
      if (!video || (video.paused && !video.seeking)) {
        waitingSince ??= Date.now()
        if (Date.now() - waitingSince >= 60000) throw new Error('60 秒内未能启动或恢复播放，请检查播放器')
        const player = video?.closest('.video-js')
        const start = /^(?:Play Video|播放视频)$/i
        const resume = /^(?:Play|播放)$/i
        const play = (player && (find(buttons, start, player) || find(buttons, resume, player)))
          || find(buttons, start) || find(buttons, resume)
        if (play && attempts < 5) {
          await send('progress', video ? '正在恢复暂停的课程' : '正在启动课程播放器')
          if (!await current()) return
          attempts++
          if (play.isConnected && visible(play)) play.click()
        }
        lastAdvance = Date.now()
      } else if (video) {
        attempts = 0
        waitingSince = undefined
        if (lastPosition !== video.currentTime || video.seeking) lastAdvance = Date.now()
        if (Date.now() - lastAdvance >= 120000) throw new Error('播放器进度连续两分钟未推进，请检查缓冲或网络')
        lastPosition = video.currentTime
        if (Date.now() - lastReport >= 15000) {
          lastReport = Date.now()
          const minutes = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')
          const total = Number.isFinite(video.duration) ? ' / ' + minutes(video.duration) : ''
          await send('progress', '正在播放 ' + minutes(video.currentTime) + total)
        }
      }
      await wait(3000)
    }
    if (!await current()) return
    if (!rated()) {
      const star = await until(() => find('[role="radio"],input[type="radio"]', /^5\s*(?:stars?\b|星)/i))
      const target = clickable(star)
      if (!target || !target.isConnected) throw new Error('五星评分控件已变化，请重新接管')
      await send('rating')
      if (!await current()) return
      if (!target.isConnected) throw new Error('评分控件已变化，请在原课程核对评分')
      target.click()
      await until(() => {
        const dialog = [...document.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"]')]
          .find(element => visible(element) && /rat(?:e|ing)|评分|打分/i.test(element.innerText))
        if (!dialog) return rated()
        const confirm = find(buttons, /^(?:OK|Confirm|Submit|确认|确定|提交)$/i, dialog)
        if (confirm && !confirm.disabled && !confirm.dataset.pmiClicked) {
          confirm.dataset.pmiClicked = '1'
          confirm.click()
        }
        return false
      }, 300000, '评分结果待核对。请关闭 Chrome 评分提示，回原课选择「核对评分并继续」')
    }
    await send('rated')
    await wait((3 + Math.floor(Math.random() * 16)) * 1000)
    if (await current()) await send('list')
  }
  function rows() {
    return [...document.querySelectorAll('h2 a[href*="/videos/"],h3 a[href*="/videos/"],h4 a[href*="/videos/"]')]
      .filter(link => link.origin === location.origin && visible(link)).map(link => {
        for (let card = link.parentElement; card && card !== document.body; card = card.parentElement) {
          const amounts = [...card.innerText.matchAll(/\bPDUs?\s*[:：]\s*(\d+(?:[.,]\d+)?)/gi)]
          if (amounts.length > 1) break
          if (amounts.length === 1) return { url: link.href, pdu: Number(amounts[0][1].replace(',', '.')) }
        }
        throw new Error('无法辨认列表中的 PDU，已停止')
      })
  }
  async function choose() {
    const filters = [/^PMP\/PgMP(?:\s*[（(][\d,]+[）)])?$/i, /^(?:Free|免费|自由的)(?:\s*[（(][\d,]+[）)])?$/i, /^(?:Not Viewed|未查看)$/i]
    const resolve = name => find('input[type="checkbox"],[role="checkbox"]', name)
    const checked = control => control?.checked || control?.getAttribute('aria-checked') === 'true'
    const settled = () => ![...document.querySelectorAll('img[src*="cf_loading"]')].some(visible)
    const filterNames = ['PMP/PgMP', '免费', '未查看']
    let page
    try {
      for (const [index, name] of filters.entries()) {
        await send('progress', '正在应用筛选：' + filterNames[index])
        const control = await until(() => resolve(name), 15000, '找不到筛选：' + filterNames[index])
        if (!checked(control)) {
          await until(settled, 12000, '列表加载超时')
          if (!await current()) return
          const refreshed = resolve(name)
          if (!refreshed) throw new Error('筛选控件已变化：' + filterNames[index])
          if (!checked(refreshed)) clickable(refreshed)?.click()
          await until(() => checked(resolve(name)), 8000, '无法应用筛选：' + filterNames[index])
          await wait(700)
        }
      }
      await send('progress', '正在等待当前页课程')
      page = await until(() => {
        if (!settled() || !filters.every(name => checked(resolve(name)))) return
        const items = rows()
        return items.length ? items : undefined
      }, 15000, '列表加载超时')
    } catch (error) {
      if (error.message !== '列表加载超时' || !await current()) throw error
      await send('retryList')
      return
    }
    await send('progress', '正在比较当前页课程的 PDU')
    const state = await current()
    if (!state) return
    const best = page.filter(entry => !state.seen.includes(new URL(entry.url).pathname.split('/')[2]))
      .sort((left, right) => right.pdu - left.pdu)[0]
    if (!best) throw new Error('没有可继续的未查看课程')
    await send('select', best.url)
  }
  const disconnected = error => /Extension context invalidated|Receiving end does not exist|message port closed/i.test(error.message)
  async function run() {
    try {
      if (await current()) {
        if (location.pathname.startsWith('/videos/')) await watch()
        else await choose()
      }
    } catch (error) {
      if (disconnected(error)) return
      try {
        await send('failed', error.message)
      } catch (reportError) {
        if (!disconnected(reportError)) console.warn('PMI 学习助手无法报告状态', reportError)
        return
      }
    }
    setTimeout(run, 1500)
  }
  run()
})()
