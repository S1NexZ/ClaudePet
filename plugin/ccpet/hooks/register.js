// ccPet bridge: a Claude Code mod that links this session with the ccPet desktop pet (https://github.com/S1NexZ/ccPet).
//
// What it does, and nothing else:
//  - asks the pet's local receiver (127.0.0.1, a port and a token the pet keeps in a 0600 file in your home folder) whether you
//    wrote something to this session in the pet, and submits it as your own message, exactly as if you had typed it;
//  - when Claude Code's plan-limit figures change, writes them to ~/.claude-pet/usage.json, the file the pet's limits ring reads;
//  - draws the pet (a few terminal cells) next to the spinner while a turn runs, and a row above the prompt with your plan limits.
// It sends nothing anywhere else, calls no model, and changes no tool call or prompt. `/ccpet` turns the pet and the row on or off.
import { atom, read, update } from 'claude-code'
import { COLS, ROWS, FRAMES } from './sprites.js'

const MARKER = /\[(?:ccPet|Claude Pet) message\]\s*/
const POLL_WAIT_S = 20     // one $.http.fetch lasts 30 s at most: the receiver answers well before that
const RETRY_MS = 60_000    // the pet is not running (or its file is unreadable): look again in a minute
const FRAME_MS = 220       // the pet's pace next to the spinner
const ORANGE = '#d97757'

const limits = atom({ plugin: 'ccpet', key: 'limits' }, null)
const bandHidden = atom({ plugin: 'ccpet', key: 'bandHidden' }, false)
const spinnerPet = atom({ plugin: 'ccpet', key: 'spinnerPet' }, true)
const linked = atom({ plugin: 'ccpet', key: 'linked' }, false)

let hub = null             // { base, token } of the pet's receiver
let hubCheckedAt = 0
let polling = false
let sessionId = ''
let cwd = ''
let entrypoint = ''
let pending = null         // a message the session refused (the user had just stopped a turn): submitted again after the next turn
let ru = false
let lastTool = ''
let spinKind = 'think'
let frame = 0
const spinners = new Set() // requestIds of the spinners this plugin drew the pet in
let samples = []           // { t, pct } of the 5-hour window, for the forecast

// ---- the pet's receiver: messages written in the pet ----

/** The receiver this session's pet listens on: the Windows app's file first, then the one in the home folder (WSL, macOS, Linux). */
async function readHub($) {
  const appData = await $.env.get('APPDATA')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  const files = []
  if (appData) files.push({ path: appData + '\\Claude Pet\\hub.json', port: 47821 })
  if (home) files.push({ path: home + '/.claude-pet/hub.json', port: 0 })
  for (const f of files) {
    try {
      if (!(await $.fs.exists(f.path))) continue
      const j = JSON.parse(await $.fs.read(f.path))
      const port = Number(j && j.port) || f.port
      if (port > 0 && port < 65536 && typeof j.token === 'string' && /^[0-9a-f]{16,128}$/.test(j.token)) {
        return { base: 'http://127.0.0.1:' + port, token: j.token }
      }
    } catch {
      // unreadable or half-written: try the next one
    }
  }
  return null
}

/** The user's own words out of what the pet queued (several messages arrive joined, each after the pet's marker). */
function userText(raw) {
  const parts = String(raw).split(MARKER)
  if (parts.length < 2) return String(raw).trim()
  return parts.slice(1).map((p) => p.replace(/<\/system-reminder>[\s\S]*$/, '').trim()).filter(Boolean).join('\n\n')
}

async function submit($, text) {
  let reason = ''
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    reason = (r && r.drop) || ''
  } catch (err) {
    reason = String((err && err.message) || err)
  }
  if (reason.includes('the session was stopped and nobody has sent input since') || reason.includes('was removed from the queue before it ran')) {
    pending = pending ? pending + '\n\n' + text : text
  }
}

async function setLinked($, on) {
  if ((await read($, linked)) !== on) await update($, linked, () => on)
}

/** One long-poll for this session; a message is submitted as the user's (not awaited: submit resolves only when its turn starts). */
async function poll($) {
  if (polling || !sessionId) return
  polling = true
  try {
    const now = await $.clock.now()
    if (!hub) {
      if (now - hubCheckedAt < RETRY_MS && hubCheckedAt > 0) return
      hubCheckedAt = now
      hub = await readHub($)
      if (!hub) { await setLinked($, false); return }
    }
    const q = 'via=mod&wait=' + POLL_WAIT_S + '&cwd=' + encodeURIComponent(cwd) + (entrypoint ? '&src=' + entrypoint : '')
    const r = await $.http.fetch(hub.base + '/mailbox/' + hub.token + '/' + encodeURIComponent(sessionId) + '?' + q)
    if (r.status === 200 || r.status === 204 || r.status === 409) await setLinked($, true) // 409: the pet is there, another client of this session polls it
    if (r.status === 200 && r.text) {
      const text = userText(r.text)
      if (text) submit($, text)
    } else if (r.status !== 204) {
      // 404: a stale token (the pet was reinstalled), 409: another client for this session: look again later
      hub = null
      hubCheckedAt = await $.clock.now()
      if (r.status === 404) await setLinked($, false)
    }
  } catch {
    hub = null // the pet is not running: the next look is a minute away
    hubCheckedAt = await $.clock.now()
    await setLinked($, false)
  } finally {
    polling = false
  }
}

// ---- plan limits: the pet's file and the row above the prompt ----

/** One window of Claude Code's rate limits as { pct, resetsAt (ms) }, or null. */
function windowOf(rateLimits, kind) {
  const w = (rateLimits || []).find((x) => x && x.kind === kind)
  const resetsAt = w && w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return w && Number.isFinite(Number(w.percentUsed)) && Number.isFinite(resetsAt) ? { pct: Number(w.percentUsed), resetsAt } : null
}

/** When the 5-hour window runs out at the pace of the last half hour, if before it resets (ms from now), else null. */
function forecast(now, five) {
  if (!five) return null
  samples = samples.filter((s) => now - s.t < 30 * 60_000 && s.pct <= five.pct)
  if (!samples.length || samples[samples.length - 1].pct !== five.pct) samples.push({ t: now, pct: five.pct })
  const a = samples[0]
  const perMs = (five.pct - a.pct) / (now - a.t)
  if (now - a.t < 5 * 60_000 || five.pct - a.pct < 2 || !(perMs > 0)) return null
  const eta = (100 - five.pct) / perMs
  return eta < five.resetsAt - now ? eta : null
}

async function takeLimits($, rateLimits) {
  const five = windowOf(rateLimits, 'five_hour')
  const seven = windowOf(rateLimits, 'seven_day')
  if (!five && !seven) return
  const now = await $.clock.now()
  const etaMs = forecast(now, five)
  const prev = await read($, limits)
  if (JSON.stringify(prev) !== JSON.stringify({ five, seven, etaMs })) await update($, limits, () => ({ five, seven, etaMs }))
  await writeUsage($, five, seven)
}

/** Plan limits as the pet's status-line file holds them (percent used, reset time in Unix seconds). */
async function writeUsage($, five, seven) {
  const win = (w) => (w ? { used_percentage: w.pct, resets_at: Math.round(w.resetsAt / 1000) } : null)
  const appData = await $.env.get('APPDATA')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  if (!home) return
  const path = appData ? home + '\\.claude-pet\\usage.json' : home + '/.claude-pet/usage.json'
  try {
    await $.fs.write(path, JSON.stringify({ version: 1, updatedAt: await $.clock.now(), five_hour: win(five), seven_day: win(seven), source: 'ccpet-plugin' }))
  } catch {
    // no pet data folder writable: nothing to share
  }
}

const pad = (n) => String(n).padStart(2, '0')
const clock = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
const span = (ms) => {
  const m = Math.max(1, Math.round(ms / 60_000)), h = Math.floor(m / 60), r = m % 60
  return ru ? (h ? h + ' ч ' + (r ? r + ' мин' : '') : r + ' мин').trim() : (h ? h + 'h ' + (r ? r + 'm' : '') : r + 'm').trim()
}
const bar = (pct) => { const n = Math.max(0, Math.min(8, Math.round(pct / 12.5))); return '█'.repeat(n) + '░'.repeat(8 - n) }
const tone = (pct) => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

// ---- the pet next to the spinner ----

const READING = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS', 'NotebookRead'])
function kindFor(mode) {
  if (mode === 'tool-use' || mode === 'tool-input') return READING.has(lastTool) ? 'read' : 'think'
  return 'think'
}
const cellsOf = (kind, f) => { const list = FRAMES[kind] || FRAMES.think; return list[f % list.length] }

function tick($) {
  if (!spinners.size) return
  frame++
  for (const requestId of [...spinners]) {
    $.ui.blit({ requestId, key: 'ccpet-pet', cells: cellsOf(spinKind, frame) })
      .then((r) => { if (r && r.deny) spinners.delete(requestId) })
      .catch(() => spinners.delete(requestId))
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    cwd = await $.session.cwd()
    const ep = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) || ''
    entrypoint = /^[a-z0-9-]{1,32}$/.test(ep) ? ep : ''
    const lang = ((await $.env.get('LC_ALL')) || (await $.env.get('LANG')) || '') + ' ' + (Intl.DateTimeFormat().resolvedOptions().locale || '')
    ru = /(^|\s)ru/i.test(lang)
    hub = null
    hubCheckedAt = 0
    samples = []
    const stored = await $.store.get('prefs')
    if (stored && typeof stored === 'object') {
      if (stored.lang === 'ru' || stored.lang === 'en') ru = stored.lang === 'ru'
      if (typeof stored.spinnerPet === 'boolean') await update($, spinnerPet, () => stored.spinnerPet)
      if (typeof stored.bandHidden === 'boolean') await update($, bandHidden, () => stored.bandHidden)
    }
    await $.command.register({ name: 'ccpet', description: 'ccPet: pet | limits (turn the pet by the spinner or the limits row on or off), ru | en (language of the row)' })
    // one poll at a time; a new one starts within a second of the last answer
    $.clock.every(1000, () => poll($))
    $.clock.every(FRAME_MS, () => tick($))
    // limits as the status line has them (free: no query); session.measure brings each change in between
    const refresh = async () => { try { const u = await $.session.usage(); await takeLimits($, u.rateLimits) } catch { /* not on a subscription */ } }
    void refresh()
    $.clock.every(60_000, () => void refresh())
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (Array.isArray(e.changed) && e.changed.includes('rateLimits')) await takeLimits($, e.rateLimits)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!e.agentId) lastTool = e.tool
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (pending !== null && e.agentId === undefined) {
      const text = pending
      pending = null
      submit($, text) // not awaited: the hook would wait for the new turn to start
    }
    return next(e)
  })

  on('command.run', { command: 'ccpet' }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    const stored = (await $.store.get('prefs')) || {}
    let lang = stored.lang
    if (arg === 'pet' || arg === 'spinner') await update($, spinnerPet, (v) => !v)
    else if (arg === 'limits' || arg === 'band') await update($, bandHidden, (v) => !v)
    else if (arg === 'ru' || arg === 'en') { lang = arg; ru = arg === 'ru'; await update($, limits, (v) => (v ? { ...v } : v)) } // redraw the row in the new language
    else return { text: 'ccPet: /ccpet pet (the pet next to the spinner) or /ccpet limits (the row above the prompt) turns it on or off; /ccpet ru or /ccpet en sets the row\'s language.' }
    const prefs = { spinnerPet: await read($, spinnerPet), bandHidden: await read($, bandHidden), ...(lang ? { lang } : {}) }
    await $.store.set('prefs', prefs)
    const on2 = (v) => (v ? (ru ? 'вкл' : 'on') : (ru ? 'выкл' : 'off'))
    return { text: ru ? 'питомец у спиннера: ' + on2(prefs.spinnerPet) + ', строка лимитов: ' + on2(!prefs.bandHidden) : 'pet by the spinner: ' + on2(prefs.spinnerPet) + ', limits row: ' + on2(!prefs.bandHidden) }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !(await read($, spinnerPet))) return next(e)
    const line = await next(e)
    if (!line) return line
    spinKind = kindFor(e.props.mode)
    spinners.add(e.requestId)
    const { Box, Raster } = $.ui.resolve(e)
    return h(Box, { flexDirection: 'row', alignItems: 'center', gap: 1 },
      h(Raster, { key: 'ccpet-pet', columns: COLS, rows: ROWS, cells: cellsOf(spinKind, frame) }),
      h(Box, { flexDirection: 'column', flexGrow: 1 }, line))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, limits)
    const isLinked = await read($, linked)
    if (e.props.hasSurvey || (await read($, bandHidden)) || (!l && !isLinked)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const parts = [h(Text, { key: 'name', color: ORANGE, bold: true }, 'ccPet')]
    if (l && l.five) {
      parts.push(h(Text, { key: 'f' },
        h(Text, { dimColor: true }, ru ? '5 ч ' : '5h '),
        h(Text, { color: tone(l.five.pct) }, bar(l.five.pct)),
        ' ' + Math.round(l.five.pct) + '%',
        h(Text, { dimColor: true }, (ru ? ' · сброс ' : ' · resets ') + clock(l.five.resetsAt))))
    }
    if (l && l.seven) {
      parts.push(h(Text, { key: 's' }, h(Text, { dimColor: true }, ru ? 'неделя ' : 'week '), h(Text, { color: tone(l.seven.pct) }, Math.round(l.seven.pct) + '%')))
    }
    if (l && l.etaMs && l.five && now < l.five.resetsAt) {
      parts.push(h(Text, { key: 'eta', color: 'yellow' }, (ru ? '⚠ в таком темпе хватит на ' : '⚠ at this pace it runs out in ') + span(l.etaMs)))
    }
    if (!isLinked) parts.push(h(Text, { key: 'off', dimColor: true }, ru ? 'питомец не запущен' : 'pet not running'))
    return h(Box, { flexDirection: 'row', gap: 3, flexWrap: 'wrap' }, ...parts)
  })
}
