// ccPet bridge: a Claude Code mod that links this session with the ccPet desktop pet (https://github.com/S1NexZ/ccPet).
//
// What it does, and nothing else:
//  - asks the pet's local receiver (127.0.0.1, a port and a token the pet keeps in a 0600 file in your home folder) whether you
//    wrote something to this session in the pet, and submits it as your own message, exactly as if you had typed it;
//  - when Claude Code's plan-limit figures change, writes them to ~/.claude-pet/usage.json, the file the pet's limits ring reads.
// It sends nothing anywhere else, calls no model, and changes no tool call or prompt.

const MARKER = /\[(?:ccPet|Claude Pet) message\]\s*/
const POLL_WAIT_S = 20     // one $.http.fetch lasts 30 s at most: the receiver answers well before that
const RETRY_MS = 60_000    // the pet is not running (or its file is unreadable): look again in a minute

let hub = null             // { base, token } of the pet's receiver
let hubCheckedAt = 0
let polling = false
let sessionId = ''
let cwd = ''
let entrypoint = ''
let pending = null         // a message the session refused (the user had just stopped a turn): submitted again after the next turn

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
      if (!hub) return
    }
    const q = 'via=mod&wait=' + POLL_WAIT_S + '&cwd=' + encodeURIComponent(cwd) + (entrypoint ? '&src=' + entrypoint : '')
    const r = await $.http.fetch(hub.base + '/mailbox/' + hub.token + '/' + encodeURIComponent(sessionId) + '?' + q)
    if (r.status === 200 && r.text) {
      const text = userText(r.text)
      if (text) submit($, text)
    } else if (r.status !== 204) {
      // 404: a stale token (the pet was reinstalled), 409: another client for this session: look again later
      hub = null
      hubCheckedAt = await $.clock.now()
    }
  } catch {
    hub = null // the pet is not running: the next look is a minute away
    hubCheckedAt = await $.clock.now()
  } finally {
    polling = false
  }
}

/** Plan limits as the pet's status-line file holds them (percent used, reset time in Unix seconds). */
async function writeUsage($, rateLimits) {
  const win = (kind) => {
    const w = (rateLimits || []).find((x) => x && x.kind === kind)
    const resets = w && w.resetsAt ? Math.round(Date.parse(w.resetsAt) / 1000) : NaN
    return w && Number.isFinite(Number(w.percentUsed)) && Number.isFinite(resets) ? { used_percentage: Number(w.percentUsed), resets_at: resets } : null
  }
  const five = win('five_hour')
  const seven = win('seven_day')
  if (!five && !seven) return
  const appData = await $.env.get('APPDATA')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  if (!home) return
  const path = appData ? home + '\\.claude-pet\\usage.json' : home + '/.claude-pet/usage.json'
  try {
    await $.fs.write(path, JSON.stringify({ version: 1, updatedAt: await $.clock.now(), five_hour: five, seven_day: seven, source: 'ccpet-plugin' }))
  } catch {
    // no pet data folder writable: nothing to share
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    cwd = await $.session.cwd()
    const ep = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) || ''
    entrypoint = /^[a-z0-9-]{1,32}$/.test(ep) ? ep : ''
    hub = null
    hubCheckedAt = 0
    // one poll at a time; a new one starts within a second of the last answer
    $.clock.every(1000, () => poll($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (Array.isArray(e.changed) && e.changed.includes('rateLimits')) await writeUsage($, e.rateLimits)
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
}
