const { readFileSync, mkdirSync, appendFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { randomInt } = require('node:crypto')
const { parseArgs } = require('node:util')
const { createInterface } = require('node:readline/promises')
const { setTimeout: sleep } = require('node:timers/promises')

const listing = 'https://www.projectmanagement.com/webinars/webinarmainondemand.cfm'
const origin = new URL(listing).origin
const stateDir = join(__dirname, 'state')
const journal = join(stateDir, 'runs.jsonl')
const { values } = parseArgs({ options: {
  help: { type: 'boolean' },
  inspect: { type: 'boolean' },
  run: { type: 'boolean' },
  limit: { type: 'string' },
  attach: { type: 'boolean' },
  course: { type: 'string' },
} })

function log(status, details = {}) {
  const entry = JSON.stringify({ time: new Date().toISOString(), status, ...details })
  appendFileSync(journal, entry + '\n', { mode: 0o600, flush: true })
  console.log(entry)
}

function previousRatings() {
  try {
    const ratings = new Map()
    for (const line of readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      if (['rating_started', 'rated'].includes(entry.status)) ratings.set(entry.id, entry.status)
    }
    return ratings
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
}

async function visible(locator) {
  return locator.count().then(count => count === 1 && locator.isVisible())
}

async function open(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
  const title = await page.title()
  if (!response?.ok() || /^Error\s*\|\s*PMI$/i.test(title)) {
    throw new Error('PMI 页面加载失败，HTTP ' + (response?.status() ?? '未知') + '，页面标题 ' + title)
  }
}

const unviewed = /^(?:Not Viewed|未查看)$/i
const fiveStarName = /^5\s*(?:stars?\b|星)/i
const playName = /^(?:Play(?: Video)?|播放(?:视频)?)$/i

function loginMarker(page, site) {
  return site.signedIn ? page.locator(site.signedIn) : page.getByRole('checkbox', { name: unviewed })
}

async function readRows(results, site) {
  if (!site.courseCard) {
    return results.locator('h2 a[href*="/videos/"], h3 a[href*="/videos/"], h4 a[href*="/videos/"]').evaluateAll(links =>
      links.filter(link => link.origin === location.origin && link.getClientRects().length).map(link => {
        for (let card = link.parentElement; card && card !== document.body; card = card.parentElement) {
          const amounts = [...card.innerText.matchAll(/\bPDUs?\s*[:：]\s*([0-9]+(?:[.,][0-9]+)?)/gi)]
          if (amounts.length > 1) break
          if (amounts.length === 1) return { url: link.href, title: link.innerText.trim(), pdu: amounts[0][1] }
        }
        return { url: link.href, title: link.innerText.trim() }
      }))
  }
  return results.locator(site.courseCard).evaluateAll((cards, pduSelector) =>
    cards.map(card => {
      const link = [...card.querySelectorAll('a[href]')].find(item =>
        item.origin === window.location.origin && /^\/videos\/\d+(?:\/|$)/.test(item.pathname)
        && item.innerText.trim())
      return { url: link?.href, title: link?.innerText.trim(), pdu: card.querySelector(pduSelector)?.textContent.trim() }
    }), site.pdu)
}

async function filters(page, site) {
  const selected = []
  for (const name of [/^PMP\/PgMP(?:\s*[（(][\d,]+[）)])?$/i, /^(?:Free|免费)(?:\s*[（(][\d,]+[）)])?$/i, site.unviewedLabel?.startsWith('regex:') ? new RegExp(site.unviewedLabel.slice(6), 'i') : site.unviewedLabel || unviewed]) {
    const option = page.getByRole('checkbox', { name, exact: typeof name === 'string' })
    await option.check()
    selected.push(option)
  }
  const results = page.locator(site.results || 'body')
  await results.waitFor({ state: 'visible' })
  // The results selector must identify the settled results panel.
  await page.waitForLoadState('networkidle')
  for (const option of selected) {
    if (!await option.isChecked()) throw new Error('筛选条件在列表更新后失效')
  }
  if (!await visible(loginMarker(page, site))) throw new Error('登录状态已变化')
  const courses = new Map()
  const rows = await readRows(results, site)
  for (const { url, title, pdu } of rows) {
    const id = url && new URL(url).pathname.match(/^\/videos\/(\d+)(?:\/|$)/)?.[1]
    const amount = pdu?.match(/\bPDUs?\s*[:：]\s*([0-9]+(?:[.,][0-9]+)?)/i)?.[1]
      ?? pdu?.match(/^([0-9]+(?:[.,][0-9]+)?)(?:\s*PDUs?)?$/i)?.[1]
    if (!id || amount === undefined) throw new Error('课程链接或 PDU 数值无法识别，请核对选择器')
    courses.set(id, { id, url, title, pdu: Number(amount.replace(',', '.')) })
  }
  if (!courses.size && !await visible(site.empty ? page.locator(site.empty) : page.getByText(/^(?:0 (?:results|webinars)|No (?:results|webinars) found|0\s*场?研讨会)$/i))) {
    throw new Error('没有找到课程链接或明确的空结果提示，请核对 results 和 empty')
  }
  return [...courses.values()].sort((left, right) => right.pdu - left.pdu)
}

async function watch(page, site) {
  const deadline = Date.now() + 4 * 60 * 60 * 1000
  console.log('请在打开的课程页完整观看，结束后脚本会检查播放覆盖范围。')
  let resumeAttempts = 0
  let missingPlaySince
  while (Date.now() < deadline) {
    if (site.signedIn && !await visible(loginMarker(page, site))) throw new Error('课程页无法确认登录状态')
    const states = await Promise.all(page.frames().map(async frame => {
      const videos = await frame.locator(site.video || 'video:visible').evaluateAll(elements => elements.map(video => {
        if (!(video instanceof HTMLVideoElement)) throw new Error('video 必须定位到 HTMLVideoElement')
        const { duration, ended, paused, played, seeking, loop } = video
        const hasDuration = Number.isFinite(duration) && duration > 0
        return {
          ended,
          paused: paused && !ended && !seeking,
          complete: ended && !loop && hasDuration
            && played.length === 1 && played.start(0) <= 0.05
            && played.end(0) >= duration - 0.05,
        }
      }))
      return videos.map(video => ({ ...video, frame }))
    }))
    const videos = states.flat()
    if (videos.length > 1) throw new Error('存在多个匹配的播放器，无法确认课程视频')
    const video = videos[0]
    if (video?.complete) return
    if (video?.ended) throw new Error('视频已结束，但播放记录未完整覆盖课程')
    if (video?.paused || !video) {
      if (resumeAttempts >= 3) throw new Error('尝试恢复播放三次后，视频仍处于暂停状态')
      const player = video?.frame || page
      const play = site.play ? player.locator(site.play) : player.getByRole('button', { name: playName })
      const entry = page.getByRole('button', { name: /^(?:Play Video|播放视频)$/i })
      const button = await visible(play) ? play : entry
      if (await visible(button)) {
        missingPlaySince = undefined
        log('resuming_playback', { attempt: ++resumeAttempts })
        await button.click()
        await sleep(1500)
      } else {
        missingPlaySince ??= Date.now()
        if (Date.now() - missingPlaySince >= 15000) {
          throw new Error('视频处于暂停状态，但无法找到唯一可见的播放按钮')
        }
      }
    } else {
      missingPlaySince = undefined
      if (video) resumeAttempts = 0
    }
    await sleep(1500)
  }
  throw new Error('等待完整播放超时')
}

async function main() {
  if (values.help) {
    console.log('npm start -- [--inspect | --run [--limit N]] [--attach --course ID]')
    return
  }
  if (values.attach !== Boolean(values.course) && (values.attach || values.course)) {
    throw new Error('--attach 与 --course ID 必须一起使用')
  }
  if (values.course && !/^\d+$/.test(values.course)) throw new Error('课程 ID 必须是数字')
  if (values.inspect && values.run) throw new Error('--inspect 和 --run 不能同时使用')
  const limit = values.limit === undefined ? Infinity : Number(values.limit)
  if (values.limit !== undefined && (!values.run || !Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('--limit 必须与 --run 一起使用，数值为正整数')
  }
  let site = {}
  try {
    site = JSON.parse(readFileSync(join(__dirname, 'site.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (site.courseCard && !site.pdu) throw new Error('自定义 courseCard 时须同时配置 pdu')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(__dirname, '.profile'), { recursive: true, mode: 0o700 })
  const { chromium } = require('playwright')
  let connection
  let browser
  let current
  let page
  if (values.attach) {
    const marker = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort')
    let endpoint
    try {
      endpoint = readFileSync(marker, 'utf8').trim().split(/\r?\n/)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      throw new Error('未找到 Chrome 调试端点，请在 Chrome 中开启 Remote Debugging')
    }
    const [port, websocket] = endpoint
    if (!/^\d+$/.test(port) || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(websocket || '')) {
      throw new Error('Chrome 调试端点无效')
    }
    connection = await chromium.connectOverCDP('ws://127.0.0.1:' + port + websocket, { timeout: 60000 })
  } else {
    browser = await chromium.launchPersistentContext(join(__dirname, '.profile'), {
      channel: 'chrome', headless: false, timeout: 20000,
    })
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (connection) {
      const matches = connection.contexts().flatMap(context => context.pages()).filter(tab => {
        const url = new URL(tab.url())
        return url.protocol === 'https:' && /^(?:www\.)?projectmanagement\.com$/i.test(url.hostname)
          && url.pathname.match(/^\/videos\/(\d+)(?:\/|$)/)?.[1] === values.course
      })
      if (matches.length !== 1) throw new Error('指定课程标签页必须唯一，找到 ' + matches.length + ' 个')
      const tab = matches[0]
      log('attached', { id: values.course, title: await tab.title() })
      if (!values.run) {
        const playback = (await Promise.all(tab.frames().map(frame =>
          frame.locator(site.video || 'video:visible').evaluateAll(videos => videos.map(video => ({
            currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended,
          }))),
        ))).flat()
        log('playback_status', { id: values.course, playback })
        return
      }
      browser = tab.context()
      current = { id: values.course, url: tab.url(), title: await tab.title(), tab }
      page = await browser.newPage()
    } else {
      page = browser.pages()[0] ?? await browser.newPage()
    }
    page.setDefaultTimeout(15000)
    if (values.inspect) {
      try {
        await open(page, listing)
      } catch (error) {
        log('inspection_blocked', { reason: error.message })
        if (!process.stdin.isTTY) throw error
        console.log('浏览器会保持打开。你可以在页面手动完成站点验证或尝试刷新。')
      }
      await terminal.question('可在浏览器登录并检查页面控件。检查完成后按回车关闭浏览器。')
      return
    }
    await open(page, listing)
    if (!await visible(loginMarker(page, site))) {
      await terminal.question('请在浏览器登录 PMI，完成后按回车。')
      await open(page, listing)
      await loginMarker(page, site).waitFor({ state: 'visible' })
    }
    if (!values.run) {
      const courses = await filters(page, site)
      log('dry_run', { courses })
      return
    }

    const ratings = previousRatings()
    for (let count = 0; count < limit; count++) {
      const courses = current ? [] : await filters(page, site)
      const course = current || courses.find(({ id }) => ratings.get(id) !== 'rated')
      if (!course) {
        log('queue_empty')
        return
      }
      const { tab, ...details } = course
      current = undefined
      log('opened', details)
      const video = tab || await browser.newPage()
      video.setDefaultTimeout(15000)
      if (!tab) {
        await open(video, course.url)
        if (new URL(video.url()).origin !== origin) throw new Error('课程页跳转到站外')
      }
      if (site.signedIn) await video.locator(site.signedIn).waitFor({ state: 'visible' })
      const rated = site.rated ? video.locator(site.rated) : video.getByText(/YOUR RATING:\s*5 STARS|您的评分\s*[:：]?\s*5\s*星/i).last()
      if (!await visible(rated)) {
        if (ratings.get(course.id) === 'rating_started') {
          throw new Error('上次评分结果待核对，课程 ID ' + course.id)
        }
        await watch(video, site)
        log('playback_completed', details)
        if (!await visible(rated)) {
          const stars = site.fiveStars ? video.locator(site.fiveStars) : video.getByRole('radio', { name: fiveStarName })
          await stars.waitFor({ state: 'visible' })
          log('rating_started', details)
          await stars.click()
          const confirmationName = /^(?:Confirm|OK|Submit|确认|确定|提交)$/i
          const confirm = site.confirm ? video.locator(site.confirm) : video.getByRole('dialog').getByRole('button', { name: confirmationName })
          await rated.or(confirm).filter({ visible: true }).first().waitFor({ state: 'visible' })
          if (!await visible(rated)) await confirm.click()
          await rated.waitFor({ state: 'visible' })
        }
      }
      log('rated', details)
      ratings.set(course.id, 'rated')
      await video.close()
      if (count + 1 < limit) {
        const delaySeconds = randomInt(3, 19)
        log('waiting_for_next_course', { delaySeconds })
        await sleep(delaySeconds * 1000)
        await open(page, listing)
      }
    }
  } catch (error) {
    log('stopped', { reason: error.message })
    if (process.stdin.isTTY) await terminal.question('流程已暂停，浏览器仍然打开。完成排查后按回车退出。')
    process.exitCode = 1
  } finally {
    terminal.close()
    if (connection) await connection.close()
    else await browser.close()
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
