// Token Keeper (based on Cache Keeper by Nate Herk): watches this session's
// prompt cache, keeps a big cache warm on request, asks before a cold send,
// and hands a big chat off to a fresh one.
//
// Why: each request re-reads the whole context. From the cache that costs about
// a tenth of normal input. Once the cache expires (1 hour idle on a subscription,
// 5 minutes on the default API TTL), the next message writes the whole context
// again at 1.25x to 2x input. A cache read also restarts the timer, so a tiny
// ping before expiry costs a fraction of a rewrite.

import { rewriteCost, requestCost, totalInput, cachedShare, priceFor, writeRate } from './pricing.mjs'
import { tokens, usd, minutes, clock, clip, basename } from './fmt.mjs'

const MIN = 60000
const TICK_EVERY = 30000
const TODAY_EVERY = 10 * MIN
const MAX_READ = 4 * 1024 * 1024 // $.fs.read refuses larger files
// The default cold-send threshold: below a rewrite of about $1 a dialog
// bothers more than the rewrite costs (about 125k tokens on Opus 5.5, 1h TTL)
const BIG_USD = 1
// What a handoff costs besides one read of the context: its output, and a fresh
// chat's start (system prompt, tools, memory files). Both are measured; these
// stand in until they are
const HANDOFF_OUT = 3000
const FRESH_START = 20000
// The default context size from which a handoff is suggested (a rule of thumb:
// past about 140k a model loses track more often), and how much more the
// context grows before the next reminder
const HANDOFF_AT = 140000
const HANDOFF_STEP = 100000

// This session
const S = {
  id: '',
  cwd: '',
  model: '',
  lastActivity: 0, // last main-loop request or keep-warm ping that touched the cache
  ctx: 0,
  lastTotal: 0, // the last main-loop request's prompt size, what its cache entry holds
  window: 0,
  costUsd: 0,
  ttlMin: 60,
  ttlSource: 'default',
  ttlWritten: 0, // the TTL of the last main-loop cache write, in minutes (0: none since /cache ttl)
  ttlWarned: false, // said once that Claude Code does not write the TTL /cache ttl set
  coldRestarts: [],
  working: false,
  turnId: '', // the main loop's running (or last) turn
  keepWarm: false,
  keepWarmUntil: 0,
  pings: 0,
  pingUsd: 0,
  pingsSinceTurn: 0, // keep-warm pings since the last main-loop request
  rateLimits: [],
  cacheBreaks: [], // rewrites while the cache was still warm
  effort: '',
  todayUsd: null, // every session's spend since local midnight
  todayPartial: false, // a transcript was too big to read, so todayUsd is a lower bound
  startTokens: 0, // what a fresh chat starts with, as /context counts it (0: not measured)
  handoffOuts: [], // output tokens of the last few handoffs, kept across sessions
  handoffNextAt: 0, // the size of the next handoff reminder (0: /cache handoff)
}

const settings = { bigUsd: BIG_USD, guard: true, ttlMin: 0, alerts: true, handoffAt: HANDOFF_AT }
const names = { cache: 'cache', keepwarm: 'keepwarm', handoff: 'handoff' }

let now = 0
let home = ''
let warnedFor = 0 // the lastActivity the cooling warning was shown for
let justCompacted = false
let ttlSwitched = false // /cache ttl changed while the cache was warm: the next request rewrites
let handoffPending = false
let envPrior // CLAUDE_CODE_PROMPT_CACHE_TTL before /cache ttl set it

// The handoff flow. When /session-handoff runs (the band's button, /handoff, a
// typed command, or Claude calling the skill), the answer of the turn it starts
// is captured and saved to a file. "clear and continue" then runs /clear and
// sends the handoff as the fresh chat's first prompt.
const HANDOFF_SKILL = /(^|:)session-handoff$/
const H = {
  armed: false,
  outTokens: 0, // output of the handoff turn so far
  notTurn: '', // a turn already running when the handoff was queued: not the handoff's
  askAfter: false, // /handoff asks "clear and continue?" once the handoff is in
  text: '',
  path: '',
  continuing: false,
}

function armHandoff(insideTurn) {
  H.armed = true
  H.outTokens = 0
  H.notTurn = insideTurn ? '' : S.working ? S.turnId : ''
}

// The handoff without any preamble Claude put before its heading
function handoffBody(answer) {
  const text = String(answer || '').trim()
  const i = text.indexOf('# Session Handoff')
  return i > 0 ? text.slice(i) : text
}

function fileStamp(ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

function dataDir() {
  return `${home || '.'}/.claude/mods-data/token-keeper`.replace(/\\/g, '/')
}

async function saveHandoff($, text) {
  const project = basename(S.cwd).replace(/[^A-Za-z0-9-]+/g, '-') || 'session'
  const path = `${dataDir()}/handoffs/${fileStamp(now)}-${project}-${S.id.slice(0, 8)}.md`
  await $.fs.write(path, text + '\n')
  return path
}

async function captureHandoff($, e) {
  H.armed = false
  H.notTurn = ''
  const askAfter = H.askAfter
  H.askAfter = false
  const body = e.reason === 'answer' ? handoffBody(e.answer) : ''
  if (body.length < 200) {
    warn($, 'The handoff turn ended without a handoff, so nothing was saved.')
    return
  }
  H.text = body
  if (H.outTokens > 0) {
    S.handoffOuts = [...S.handoffOuts, H.outTokens].slice(-5)
    await $.store.set('handoffOuts', S.handoffOuts).catch(() => {})
  }
  try {
    H.path = await saveHandoff($, body)
  } catch {
    H.path = ''
  }
  const saved = H.path ? `Handoff saved to ${H.path}.` : 'Handoff captured (the backup file could not be written).'
  note($, `${saved} Press c on the band or type /${names.handoff} continue to clear and continue.`)
  // Off the hook: the turn is ending, and a dialog would hold it open
  if (askAfter) $.clock.after(300, () => offerContinue($).catch(() => {}))
}

async function offerContinue($) {
  if (!H.text) return
  let answer = ''
  try {
    answer = await $.ui.ask('Handoff saved. Clear this chat and continue with it in a fresh context?', ['Clear and continue', 'Keep this chat'])
  } catch {
    return // dismissed: the band button and /handoff continue still work
  }
  if (answer === 'Clear and continue') await clearAndContinue($)
}

function continuationPrompt() {
  const where = H.path ? ` (saved at ${H.path})` : ''
  return `Handoff from my previous session${where}:\n\n${H.text}`
}

async function clearAndContinue($) {
  if (H.continuing) return
  if (!H.text) {
    note($, `No handoff ready. Press h on the band or type /${names.handoff} first.`)
    return
  }
  if (S.working) {
    note($, 'Claude is still working. Clear and continue once this turn ends.')
    return
  }
  const text = continuationPrompt()
  const path = H.path
  H.continuing = true
  $.ui.invalidate('ui.render')
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    H.continuing = false
    $.ui.invalidate('ui.render')
    warn($, 'Could not run /clear: ' + clip(String((err && err.message) || err), 100) + (path ? ` The handoff is saved at ${path}.` : ''))
    return
  }
  H.text = ''
  H.path = ''
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    // Not sent: leave it in the prompt box for one Enter
    let filled = false
    try {
      filled = !!(await $.prompt.fill({ text })).isFilled
    } catch {
      filled = false
    }
    if (filled) note($, 'Cleared. The handoff is in the prompt box: press Enter to send it.')
    else warn($, `Cleared, but the handoff could not be sent.${path ? ` It's saved at ${path}.` : ''}`)
  } finally {
    H.continuing = false
    $.ui.invalidate('ui.render')
  }
}

// Runs the /session-handoff skill as if you typed it. The engine queues it
// until Claude finishes the current turn.
async function runHandoff($) {
  if (handoffPending) {
    note($, 'Session handoff is already queued.')
    return
  }
  try {
    const commands = await $.command.list()
    const cmd = commands.find((c) => c.name === 'session-handoff') || commands.find((c) => HANDOFF_SKILL.test(c.name))
    if (!cmd) {
      H.askAfter = false
      warn($, 'No /session-handoff skill in this session.')
      return
    }
    handoffPending = true
    armHandoff(false)
    $.ui.invalidate('ui.render')
    note($, S.working ? 'Session handoff queued: it runs when Claude finishes this turn.' : 'Running /session-handoff.')
    await $.command.run({ command: cmd.name, args: '' })
  } catch (err) {
    H.armed = false
    H.askAfter = false
    warn($, 'Could not start /session-handoff: ' + clip(String((err && err.message) || err), 100))
  } finally {
    handoffPending = false
    $.ui.invalidate('ui.render')
  }
}

// What the cache really uses: the last write's TTL, else /cache ttl, else the estimate
function ttlMin() {
  return S.ttlWritten || settings.ttlMin || S.ttlMin
}

// The session's spend as Claude Code counts it, or null when it does not say
async function sessionUsd($) {
  try {
    const cost = (await $.session.usage()).cost
    return cost ? cost.usd : null
  } catch {
    return null
  }
}

// The TTL a cache write used: the usage's 1h/5m split when it has one; else the
// price that matches what Claude Code charged for the request, since its cost
// counts the TTL really written (0: too small to tell, or another request in between)
function writeTtl(u, written, charged) {
  if (u.cache_creation && written > 0) return (u.cache_creation.ephemeral_1h_input_tokens || 0) * 2 >= written ? 60 : 5
  if (charged === null || written < 1000) return 0
  const p5 = requestCost(u, u.model || S.model, 5)
  const p60 = requestCost(u, u.model || S.model, 60)
  const near = Math.abs(charged - p60) < Math.abs(charged - p5) ? 60 : 5
  return Math.abs(charged - (near === 60 ? p60 : p5)) < Math.abs(p60 - p5) / 4 ? near : 0
}

function ttlEnv(min) {
  return min === 5 ? '5m' : min === 60 ? '1h' : undefined
}

// Points Claude Code's own cache TTL at the /cache ttl choice; auto gives the
// variable back as it was before Token Keeper set it
async function applyTtl($) {
  // a refusal must not break /cache: the next write's TTL check reports it
  await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', settings.ttlMin ? ttlEnv(settings.ttlMin) : envPrior).catch(() => {})
}

function ttlSourceText() {
  if (!settings.ttlMin) return S.ttlSource
  if (!S.ttlWritten) return 'set by you'
  if (S.ttlWritten === settings.ttlMin) return 'set by you · confirmed'
  return `⚠️ you set ${settings.ttlMin} min, but Claude Code writes ${S.ttlWritten} min`
}

function ttlName(ttl) {
  return ttl >= 60 ? '1h TTL' : '5-min TTL'
}

// Plan limit windows as the API reports them: five_hour, seven_day, spend_limit
const LIMIT_LABEL = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

function limitsText(limits) {
  return limits.map((l) => `${LIMIT_LABEL[l.kind] || l.kind} ${Math.round(l.percentUsed)}%`).join(' · ')
}

function limitTone(limits, extra) {
  const top = Math.max(...limits.map((l) => l.percentUsed || 0))
  if (top >= 95) return { ...extra, color: 'red', bold: true }
  if (top >= 80) return { ...extra, color: 'yellow' }
  return { ...extra, dimColor: true }
}

// 'claude-opus-5-5' -> 'Opus 5.5'
function modelName(model) {
  const [family, ...ver] = priceFor(model).id.split('-')
  return family[0].toUpperCase() + family.slice(1) + ' ' + ver.join('.')
}

function msLeft(lastActivity, ttl) {
  if (!lastActivity) return null
  return ttl * MIN - (now - lastActivity)
}

function cacheState() {
  const left = msLeft(S.lastActivity, ttlMin())
  if (left === null) return { kind: 'unknown', left: 0 }
  if (S.keepWarm) return { kind: 'kept', left }
  if (left <= 0) return { kind: 'cold', left }
  // Cooling: from when a keep-warm ping would go out (5 minutes before on the 1h
  // TTL, 90s on the 5-minute one), so a 5-minute cache is not cooling right away
  const ttl = ttlMin()
  if (left <= Math.min(5 * MIN, ttl * MIN - pingEvery(ttl))) return { kind: 'cooling', left }
  return { kind: 'warm', left }
}

// Big: rewriting this context costs at least the threshold, on this model and TTL
function isBig() {
  return rewriteCost(S.ctx, S.model, ttlMin()) >= settings.bigUsd
}

// "$1.00 (default) ≈ 125k tokens on Opus 5.5, 1h TTL"
function bigText() {
  const ttl = ttlMin()
  const atTokens = settings.bigUsd / (writeRate(S.model, ttl) / 1e6)
  return `${usd(settings.bigUsd)}${settings.bigUsd === BIG_USD ? ' (default)' : ''} ≈ ${tokens(atTokens)} tokens on ${modelName(S.model)}, ${ttlName(ttl)}`
}

// Keep warm pings this long after the last read, and every ping after it
function pingEvery(ttl) {
  return ttl * MIN - (ttl >= 60 ? 8 * MIN : 90000)
}

// How long pinging stays cheaper than one rewrite: a rewrite costs as much as
// (write price / read price) pings, whatever the context size
function breakEvenMs() {
  const ttl = ttlMin()
  return (writeRate(S.model, ttl) / priceFor(S.model).read) * pingEvery(ttl)
}

function defaultKeepWarmMs() {
  return ttlMin() >= 60 ? 4 * 60 * MIN : 30 * MIN
}

// "30m", "30min", "2h", "1.5" (hours); capped at 24 hours
function parseDuration(text) {
  const m = String(text || '').match(/^(\d+(?:\.\d+)?)\s*(m|min|h)?$/)
  if (!m || !(Number(m[1]) > 0)) return null
  const ms = Number(m[1]) * (m[2] === 'm' || m[2] === 'min' ? MIN : 60 * MIN)
  return Math.min(24 * 60 * MIN, ms)
}

// "300k", "1.5M", "300000"
function parseTokens(text) {
  const m = String(text || '').match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/)
  if (!m || !(Number(m[1]) > 0)) return null
  return Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1))
}

// What a fresh chat starts with: every /context row but the messages. A local
// estimate, no request
async function measureStart($) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const rows = (u.context && u.context.breakdown && u.context.breakdown.categories) || []
    const sum = rows.filter((r) => r.kind === 'used' && r.name !== 'Messages').reduce((a, r) => a + (r.tokens || 0), 0)
    if (sum > 0) S.startTokens = sum
  } catch {
    // no breakdown: keep the last figure or the default
  }
}

// When the context passes the handoff size: a notice, then a choice to hand
// off now, be reminded HANDOFF_STEP later, or turn the reminders off
function handoffStep($) {
  if (!settings.alerts || !settings.handoffAt) return
  const at = S.handoffNextAt || settings.handoffAt
  if (S.ctx < at) return
  let next = at + HANDOFF_STEP
  while (next <= S.ctx) next += HANDOFF_STEP
  S.handoffNextAt = next
  const c = keepWarmVsHandoff(0)
  // Quality is the reason; the saving is named only when the fresh chat is clearly smaller
  const saves = c.perTurn >= 0.01 ? `, and every turn after it re-reads about ${tokens(c.fresh)} instead of ${tokens(S.ctx)}: ${usd(c.perTurn)} less per turn` : ''
  note($, `This chat is at ${tokens(S.ctx)} tokens, and a long context gets less reliable. A /${names.handoff} or /compact (about ${usd(c.handoff)}, either) carries on in a fresh chat${saves}.`)
  // Off the hook: the turn is ending, and a dialog would hold it open
  $.clock.after(300, () => offerHandoff($, next).catch(() => {}))
}

async function offerHandoff($, next) {
  const remind = `Remind me after another ${tokens(HANDOFF_STEP)} (${tokens(next)})`
  let answer = ''
  try {
    answer = await $.ui.ask(`This chat is at ${tokens(S.ctx)} tokens. Hand it off to a fresh chat?`, ['Handoff now', remind, 'No more reminders'])
  } catch {
    return // dismissed: remind at the next step
  }
  if (answer === 'Handoff now') {
    H.askAfter = true
    await runHandoff($)
  } else if (answer === 'No more reminders') {
    settings.handoffAt = 0
    await $.store.set('settings', settings)
    note($, `Handoff reminders off. /${names.cache} handoff default turns them back on.`)
  }
}

function parseUsd(text) {
  const m = String(text || '').match(/^\$?(\d+(?:\.\d+)?)$/)
  return m && Number(m[1]) > 0 ? Number(m[1]) : null
}

// Lines in the chat (plain text, drawn dim): ⚠️ a warning, ℹ️ a notice
function warn($, text) {
  $.ui.log('⚠️ ' + text)
}

function note($, text) {
  $.ui.log('ℹ️ ' + text)
}

// Bold in a command's output, which draws markdown; plain in a chat line
function bolder(md) {
  return md ? (s) => `**${s}**` : (s) => s
}

// Keep warm for ms vs a handoff now, in dollars. A handoff reads the context
// once, writes the handoff, and the fresh chat writes its start; then no pings
// The handoff's output: the average of the last few, or the estimate
function handoffOut() {
  return S.handoffOuts.length ? S.handoffOuts.reduce((a, n) => a + n, 0) / S.handoffOuts.length : HANDOFF_OUT
}

// Keep warm for ms vs a handoff now, in dollars, and what each turn after the
// handoff saves on re-reading the context (a /compact costs about the same)
function keepWarmVsHandoff(ms) {
  const ttl = ttlMin()
  const p = priceFor(S.model)
  const ping = S.ctx * p.read / 1e6
  const start = S.startTokens || FRESH_START
  const fresh = start + handoffOut()
  return {
    ping,
    fresh,
    keepWarm: Math.floor(ms / pingEvery(ttl)) * ping, // a ping every pingEvery, none at the start
    handoff: ping + handoffOut() * p.output / 1e6 + start * writeRate(S.model, ttl) / 1e6,
    perTurn: Math.max(0, S.ctx - fresh) * p.read / 1e6,
  }
}

// Starts keeping the cache warm and says so, with ⚠️ past the break-even
function startKeepWarm(ms, isDefault, md) {
  // A new run counts its own pings; extending a running one keeps counting
  if (!S.keepWarm) {
    S.pings = 0
    S.pingUsd = 0
  }
  S.keepWarm = true
  S.keepWarmUntil = now + ms
  const b = bolder(md)
  const ttl = ttlMin()
  const be = breakEvenMs()
  const how = `${b(minutes(ms))}${isDefault ? `, the default on the ${ttlName(ttl)}` : ''}, until ${clock(S.keepWarmUntil)}`
  const on = `On ${modelName(S.model)} with the ${ttlName(ttl)}`
  if (ms > be) return `⚠️ Keeping this cache warm for ${how}. ${on} that only pays off up to ${b('~' + minutes(be))}: after that, one rewrite (${usd(rewriteCost(S.ctx, S.model, ttl))}) is cheaper. Better: ${b(`/${names.keepwarm} ${ttl >= 60 ? '4h' : '30m'}`)} (the default), ${b('/' + names.handoff)} now while the cache is warm, or ${b('/clear')}.`
  const c = keepWarmVsHandoff(ms)
  const vs = c.handoff < c.keepWarm ? ` A ${b('/' + names.handoff)} now is cheaper: about ${usd(c.handoff)} vs ${usd(c.keepWarm)} for ${minutes(ms)} of pings. After it, each turn re-reads about ${tokens(c.fresh)} instead of ${tokens(S.ctx)}, about ${usd(c.perTurn)} less.` : ''
  return `ℹ️ Keeping this cache warm for ${how}. ${on} it pays off up to ~${minutes(be)}.${vs}`
}

// Stops keeping the cache warm and says so ('' when it was off), ⚠️ for a problem
function stopKeepWarm(why, problem) {
  if (!S.keepWarm) return ''
  S.keepWarm = false
  return `${problem ? '⚠️' : 'ℹ️'} Keep warm off (${why}). ${S.pings} ping(s), ${usd(S.pingUsd)}.`
}

function log($, text) {
  if (text) $.ui.log(text)
}

async function keepWarmStep($) {
  if (!S.keepWarm) return
  if (now >= S.keepWarmUntil) return log($, stopKeepWarm('time limit reached'))
  if (S.working || !S.lastActivity) return
  const ttl = ttlMin()
  if (now - S.lastActivity < pingEvery(ttl)) return
  // Past the TTL the cache is gone (keep warm started late, or the machine slept):
  // a ping would only write it again
  if (now - S.lastActivity >= ttl * MIN) return log($, stopKeepWarm(`the cache already went cold ${minutes(now - S.lastActivity - ttl * MIN)} ago, so a ping would only write it again`, true))
  let reply = null
  try {
    reply = await $.model.fork({ prompt: 'token-keeper keep-alive ping. Reply with only: ok' })
  } catch {
    reply = null
  }
  if (!reply || !reply.usage) {
    return log($, stopKeepWarm('the ping got no answer, so the cache may already be cold', true))
  }
  const u = reply.usage
  const cost = requestCost(u, S.model, ttl)
  S.pings += 1
  S.pingUsd += cost
  addToday(cost)
  // The first ping after a turn may write the turn's tail (its prefix ends after the
  // reply, the main thread's entry before it); a later ping that writes much missed
  // the cache: stop paying for it
  const first = S.pingsSinceTurn === 0
  S.pingsSinceTurn += 1
  if (!first && (u.cache_creation_input_tokens || 0) > 0.1 * Math.max(1, u.cache_read_input_tokens || 0)) {
    return log($, stopKeepWarm(`the ping wrote ${tokens(u.cache_creation_input_tokens)} tokens instead of reading the cache`, true))
  }
  S.lastActivity = now
}

// Shortly before a big cache goes cold: keep it warm, or hand off while it's warm
function warnStep($) {
  if (!settings.alerts || S.keepWarm || !isBig()) return
  const st = cacheState()
  if (st.kind !== 'cooling' || warnedFor === S.lastActivity) return
  warnedFor = S.lastActivity
  const cost = usd(rewriteCost(S.ctx, S.model, ttlMin()))
  warn($, `This ${tokens(S.ctx)}-token cache goes cold in ${minutes(st.left)}. Rewriting it then costs about ${cost}. Back soon: /${names.keepwarm} (or press 1). Done for now: /${names.handoff} while it's still warm.`)
}

async function tick($) {
  now = await $.clock.now()
  await keepWarmStep($)
  warnStep($)
  if (now - todayAt > TODAY_EVERY) await refreshToday($).catch(() => {})
  $.ui.invalidate('ui.render')
}

// Today's spend at API list prices, every session's (subagents too). A cache
// file per day keeps each transcript's costs, so only transcripts that changed
// are read again. This session's own transcripts are read once, then its
// requests are counted live. Each response counts once across files.
let todayAt = 0
let todayDate = ''
let todayFiles = {} // path -> { mtimeMs, costs: { responseKey: usd } } or { mtimeMs, tooBig: true }
let othersUsd = 0
let othersPartial = false
const own = { scanned: false, base: 0, live: 0, partial: false }

function localDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function setToday() {
  S.todayUsd = othersUsd + own.base + own.live
  S.todayPartial = othersPartial || own.partial
}

// A request of this session: counted live once its transcripts were read
function addToday(cost) {
  if (!own.scanned) return // the first read finds it in the transcript
  own.live += cost
  setToday()
}

async function readCosts($, path, mtimeMs, size, date) {
  if (size > MAX_READ) return { mtimeMs, tooBig: true }
  const costs = {}
  const text = await $.fs.read(path).catch(() => null)
  if (text === null) return { mtimeMs, tooBig: true }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const msg = entry.message
    if (!msg || !msg.usage || !entry.timestamp || msg.model === '<synthetic>') continue
    if (localDate(Date.parse(entry.timestamp)) !== date) continue
    const cc = msg.usage.cache_creation || {}
    const w1h = cc.ephemeral_1h_input_tokens || 0
    const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (msg.usage.cache_creation_input_tokens || 0) - w1h)
    costs[`${msg.id}:${entry.requestId}`] = requestCost({ ...msg.usage, cache_creation_input_tokens: w1h }, msg.model, 60) + requestCost({ cache_creation_input_tokens: w5m }, msg.model, 5)
  }
  return { mtimeMs, costs }
}

async function refreshToday($) {
  todayAt = now
  const date = localDate(now)
  const cachePath = `${dataDir()}/today/${date}.json`
  if (date !== todayDate) {
    todayDate = date
    todayFiles = {}
    try {
      todayFiles = JSON.parse(await $.fs.read(cachePath)).files || {}
    } catch {
      // no cache file yet today
    }
    own.scanned = false
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const root = ((await $.env.get('CLAUDE_CONFIG_DIR')) || home + '/.claude') + '/projects'
  const files = []
  const walk = async (dir) => {
    for (const f of await $.fs.list(dir).catch(() => [])) {
      const p = dir + '/' + f.name
      if (f.kind === 'dir') await walk(p)
      else if (f.name.endsWith('.jsonl') && f.mtimeMs >= midnight) files.push({ p, mtimeMs: f.mtimeMs, size: f.size })
    }
  }
  await walk(root)
  const scanOwn = !own.scanned
  if (scanOwn) Object.assign(own, { base: 0, live: 0, partial: false })
  const seen = new Map()
  let partial = false
  let changed = false
  for (const { p, mtimeMs, size } of files) {
    const mine = !!S.id && p.includes(S.id) // the transcript and its subagents' folder
    if (mine && !scanOwn) continue
    let entry = todayFiles[p]
    if (!entry || entry.mtimeMs !== mtimeMs) {
      entry = await readCosts($, p, mtimeMs, size, date)
      todayFiles[p] = entry
      changed = true
    }
    if (entry.tooBig) {
      if (mine) own.partial = true
      else partial = true
    } else if (mine) {
      own.base += Object.values(entry.costs).reduce((a, v) => a + v, 0)
    } else {
      for (const [k, v] of Object.entries(entry.costs)) seen.set(k, v)
    }
  }
  own.scanned = true
  othersUsd = [...seen.values()].reduce((a, v) => a + v, 0)
  othersPartial = partial
  setToday()
  if (changed) await $.fs.write(cachePath, JSON.stringify({ files: todayFiles })).catch(() => {})
}

function todayText() {
  return (S.todayPartial ? '≥ ' : '') + usd(S.todayUsd)
}

async function loadSettings($) {
  const saved = await $.store.get('settings')
  if (!saved || typeof saved !== 'object') return
  for (const k of Object.keys(settings)) if (saved[k] !== undefined) settings[k] = saved[k]
}

function statusText() {
  const st = cacheState()
  const ttl = ttlMin()
  const rewrite = rewriteCost(S.ctx, S.model, ttl)
  const c = names.cache
  // Markdown, as a command's output draws: a bold label per line, the band's icons
  const lines = []
  lines.push(`**Token Keeper** · ${tokens(S.ctx)} tokens in context on **${modelName(S.model)}** · cache window **${ttl} min** (${ttlSourceText()})`)
  lines.push('')
  if (st.kind === 'unknown') lines.push('- – **Cache:** no request yet this session, so its state is unknown')
  if (st.kind === 'warm') lines.push(`- ● **Cache:** warm for about **${minutes(st.left)}** more`)
  if (st.kind === 'cooling') lines.push(`- ◐ **Cache:** ⚠️ cools in **${minutes(st.left)}**`)
  if (st.kind === 'cold') lines.push(`- ○ **Cache:** ⚠️ cold for ${minutes(-st.left)}, the next message rewrites it for about **${usd(rewrite)}**`)
  if (S.keepWarm) lines.push(`- ◆ **Keep warm:** on until **${clock(S.keepWarmUntil)}**, ${S.pings} ping(s), ${usd(S.pingUsd)} so far`)
  else lines.push(`- ◆ **Keep warm:** ${minutes(defaultKeepWarmMs())} by default on the ${ttlName(ttl)}, pays off up to **~${minutes(breakEvenMs())}** on ${modelName(S.model)}`)
  if (S.rateLimits.length) lines.push(`- **Plan limits:** ${S.rateLimits.some((l) => (l.percentUsed || 0) >= 80) ? '⚠️ ' : ''}${limitsText(S.rateLimits)}`)
  lines.push(`- **Cost:** session **${usd(S.costUsd)}**${S.todayUsd === null ? '' : ` · today **${todayText()}**`} (API list prices)`)
  let restarts = `- **Cold restarts:** ${S.coldRestarts.length} (${usd(S.coldRestarts.reduce((a, r) => a + r.usd, 0))})`
  if (S.cacheBreaks.length) restarts += ` · ⚠️ **Cache breaks:** ${S.cacheBreaks.length} (${usd(S.cacheBreaks.reduce((a, r) => a + r.usd, 0))}), last: ${S.cacheBreaks[S.cacheBreaks.length - 1].cause}`
  lines.push(restarts)
  lines.push(`- **Cold-send guard:** ${settings.guard ? 'on' : 'off'}, asks above **${bigText()}** · rewriting now ≈ ${usd(rewrite)}, ${isBig() ? 'above' : 'below'} that`)
  lines.push(`- **Handoff hint:** ${settings.handoffAt ? `from **${tokens(settings.handoffAt)}** tokens${settings.handoffAt === HANDOFF_AT ? ' (default)' : ''}, then every ${tokens(HANDOFF_STEP)} more` : 'off'} · a handoff costs about **${usd(keepWarmVsHandoff(0).handoff)}** now (fresh chat ${tokens(S.startTokens || FRESH_START)}${S.startTokens ? '' : ' estimated'}, handoff ${tokens(handoffOut())}${S.handoffOuts.length ? `, average of the last ${S.handoffOuts.length}` : ' estimated'})`)
  lines.push(`- **Alerts:** ${settings.alerts ? 'on' : 'off'}`)
  lines.push(`- **Settings:** \`/${c} ttl 5|60|auto\` · \`/${c} guard on|off\` · \`/${c} big $1|default\` · \`/${c} handoff 140k|off|default\` · \`/${c} alerts on|off\``)
  return lines.join('\n')
}

async function registerCommand($, name, description, argumentHint, immediate) {
  const spec = immediate ? { name, description, argumentHint, immediate: true } : { name, description, argumentHint }
  try {
    await $.command.register(spec)
    return name
  } catch {
    try {
      await $.command.register({ ...spec, name: 'tk-' + name })
      return 'tk-' + name
    } catch {
      return null
    }
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    S.model = await $.session.model()
    await loadSettings($)
    // Remember the variable as found, unless it is the value /cache ttl set (a reload)
    const prior = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
    envPrior = settings.ttlMin && prior === ttlEnv(settings.ttlMin) ? undefined : prior
    if (settings.ttlMin) await applyTtl($)
    const outs = await $.store.get('handoffOuts')
    S.handoffOuts = Array.isArray(outs) ? outs.filter((n) => n > 0).slice(-5) : []
    measureStart($).catch(() => {})
    names.cache = (await registerCommand($, 'cache', 'Token Keeper status and settings', '[ttl 5|60|auto] [guard on|off] [big $1|default] [handoff 140k|off|default] [alerts on|off]')) || names.cache
    names.keepwarm = (await registerCommand($, 'keepwarm', 'Keep this session\'s prompt cache warm (default 30m on the 5-min TTL, 4h on the 1h TTL), or /keepwarm off', '[30m|4h|off]', true)) || names.keepwarm
    names.handoff = (await registerCommand($, 'handoff', 'Session handoff, then clear this chat and continue with it (/handoff continue)', '[continue]')) || names.handoff
    $.clock.every(TICK_EVERY, () => tick($).catch(() => {}))
    refreshToday($).catch(() => {})
    return next(e)
  })

  // /clear, /resume and /branch start from an unknown cache. The process goes
  // on under a new session id, and no session.start fires for it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    S.lastActivity = 0
    S.keepWarm = false
    H.armed = false
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    // The old transcript is another session's now: read today's costs afresh
    own.scanned = false
    todayAt = 0
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    // A new message in this chat makes a waiting handoff out of date (its file stays)
    if (H.text && !H.continuing && e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')) {
      H.text = ''
      H.path = ''
      $.ui.invalidate('ui.render')
    }
    const ttl = ttlMin()
    const left = msLeft(S.lastActivity, ttl)
    const isCold = left !== null && left <= 0
    const fromUser = e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    if (!settings.guard || !fromUser || !isCold || !isBig() || e.turnId) return next(e)
    const cost = usd(rewriteCost(S.ctx, S.model, ttl))
    let answer = 'Send anyway'
    try {
      answer = await $.ui.ask(
        `Cache went cold ${minutes(-left)} ago. Sending now rewrites ${tokens(S.ctx)} tokens of context (about ${cost}). What should happen?`,
        ['Send anyway', 'Compact first, then send', 'Cancel'],
      )
    } catch {
      // nobody to ask (a -p run, or the dialog was dismissed): send as typed
      return next(e)
    }
    if (answer === 'Compact first, then send') {
      try {
        await $.session.compact()
      } catch {
        // compaction refused or failed: send anyway
      }
      return next(e)
    }
    if (answer === 'Send anyway') return next(e)
    // A handoff now would rewrite the cache too: it only saves while warm
    warn($, `Not sent. Next time, /${names.handoff} before the cache goes cold skips the rewrite.`)
    return { drop: 'Cancelled by token-keeper before a cold cache rewrite' }
  })

  on('turn.start', async ($, e, next) => {
    S.working = true
    if (e.turnId) S.turnId = e.turnId
    return next(e)
  })

  // Each request: what it cost today, and for the main loop, did it read the
  // cache or rewrite it?
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const usdBefore = e.agentId ? null : await sessionUsd($)
    const result = yield* next(e)
    if (!result || !result.usage) return result
    const u = result.usage
    addToday(requestCost(u, u.model || S.model, ttlMin()))
    if (e.agentId) return result
    now = await $.clock.now()
    const total = totalInput(u)
    const written = u.cache_creation_input_tokens || 0
    // Each write's TTL is the cache window, measured
    const usdAfter = usdBefore === null ? null : await sessionUsd($)
    const seen = writeTtl(u, written, usdAfter === null ? null : usdAfter - usdBefore)
    if (seen) {
      S.ttlWritten = seen
      if (!settings.ttlMin) {
        S.ttlMin = S.ttlWritten
        S.ttlSource = 'measured'
      } else if (S.ttlWritten !== settings.ttlMin && !S.ttlWarned) {
        S.ttlWarned = true
        if (settings.alerts) warn($, `You set the ${settings.ttlMin}-min cache TTL, but Claude Code still writes ${S.ttlWritten}-min entries. FORCE_PROMPT_CACHING_5M overrides it, and setting it needs Claude Code v2.1.242 or later.`)
      }
    }
    const gap = S.lastActivity ? startedAt - S.lastActivity : 0
    const prevModel = S.model
    S.model = u.model || S.model
    const afterCompact = justCompacted
    justCompacted = false
    const afterTtlSwitch = ttlSwitched
    ttlSwitched = false
    // What the cache lost: the part of the previous context this request did not read.
    // New content (a file read, a tool result) is written too, but that is no loss
    // (against the last request's own size: S.ctx may already count the new content)
    const lost = Math.max(0, S.lastTotal - (u.cache_read_input_tokens || 0))
    const lostMuch = S.lastActivity && S.lastTotal > 30000 && lost > 0.2 * S.lastTotal
    if (afterCompact) {
      // the first request after a compaction writes the new, shorter context: expected
    } else if (afterTtlSwitch) {
      // a /cache ttl switch while warm: the rewrite is expected, so say what it really cost
      if (written > 0) note($, `Switching to the ${ttlName(ttlMin())} rewrote ${tokens(written)} tokens for about ${usd(rewriteCost(written, S.model, ttlMin()))}.`)
    } else if (lostMuch && gap < 4.5 * MIN) {
      // Lost although the cache was still warm: something changed the prompt prefix
      const cause = prevModel && u.model && prevModel !== u.model ? `the model changed (${priceFor(prevModel).id} → ${priceFor(u.model).id})` : 'the prompt prefix changed (CLAUDE.md, MCP tools, settings, effort, or system prompt)'
      const cost = rewriteCost(lost, S.model, ttlMin())
      S.cacheBreaks.push({ at: now, tokens: lost, usd: cost, cause })
      if (settings.alerts) warn($, `Cache broken while warm: ${cause}. Rewrote ${tokens(lost)} tokens for about ${usd(cost)}.`)
    } else if (lostMuch) {
      // Cold: a fifth or more of the previous context was not read after a pause (the
      // system prompt part often stays warm through other sessions).
      // A rewrite after 5-60 idle minutes means this session runs on the 5-minute TTL
      if (!settings.ttlMin && gap > 5.5 * MIN && gap < S.ttlMin * MIN) {
        S.ttlMin = 5
        S.ttlSource = 'measured'
      }
      S.coldRestarts.push({ at: now, tokens: lost, usd: rewriteCost(lost, S.model, ttlMin()), gapMin: Math.round(gap / MIN) })
    } else if (S.lastActivity && total > 30000 && gap > 5.5 * MIN && cachedShare(u) > 0.8) {
      // A hit after more than 5 idle minutes proves the 1-hour TTL
      if (!settings.ttlMin) {
        S.ttlMin = 60
        S.ttlSource = 'measured'
      }
    }
    if (H.armed) H.outTokens += u.output_tokens || 0
    S.ctx = total
    S.lastTotal = total
    S.lastActivity = now
    S.pingsSinceTurn = 0
    if (e.effort) S.effort = String(e.effort)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    now = await $.clock.now()
    S.working = false
    try {
      const usage = await $.session.usage()
      if (usage.context && usage.context.tokens) S.ctx = usage.context.tokens
      if (usage.context && usage.context.window) S.window = usage.context.window
      if (usage.cost) S.costUsd = usage.cost.usd
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length) S.rateLimits = usage.rateLimits
    } catch {
      // usage unavailable: keep the per-request figures
    }
    if (H.armed && e.turnId !== H.notTurn) await captureHandoff($, e)
    else handoffStep($)
    $.ui.invalidate('ui.render')
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    justCompacted = true
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens) S.ctx = e.context.tokens
    if (e.context && e.context.window) S.window = e.context.window
    if (e.cost) S.costUsd = e.cost.usd
    if (Array.isArray(e.rateLimits) && e.rateLimits.length) S.rateLimits = e.rateLimits
    return next(e)
  })

  // Claude calling the handoff skill itself: this turn's answer is the handoff
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (!e.agentId && HANDOFF_SKILL.test(String(e.skill || ''))) armHandoff(true)
    return next(e)
  })

  // /session-handoff from anywhere (typed, the band, /handoff): watch for its answer
  on('command.run', async ($, e, next) => {
    if (HANDOFF_SKILL.test(String(e.command || ''))) armHandoff(false)
    return next(e)
  })

  // /handoff runs the handoff and then asks to clear and continue (the band's
  // buttons draw only in the terminal); /handoff continue does the second half.
  // Both run off the hook: a command started inside a hook the session is
  // waiting on is refused.
  on('command.run', { command: ['handoff', 'tk-handoff'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'continue' || arg === 'go') {
      if (!H.text) return { text: `No handoff ready yet. Type /${names.handoff} to make one.` }
      $.clock.after(50, () => clearAndContinue($).catch(() => {}))
      return { text: 'Clearing this chat and continuing with the handoff.' }
    }
    H.askAfter = true
    $.clock.after(50, () => runHandoff($).catch(() => {}))
    return { text: 'Running the session handoff. When it finishes, you can clear this chat and continue with it.' }
  })

  on('command.run', { command: ['cache', 'tk-cache'] }, async ($, e) => {
    now = await $.clock.now()
    const [key, value] = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (key === 'ttl') {
      const want = value === '5' ? 5 : value === '60' ? 60 : 0
      // While the cache is warm, the next request rewrites what was cached under
      // the old TTL; once it is cold that rewrite happens anyway, so no question
      const st = cacheState()
      if (want && want !== ttlMin() && ['warm', 'cooling', 'kept'].includes(st.kind) && S.ctx > 30000) {
        const cost = usd(rewriteCost(S.ctx, S.model, want))
        const keep = `Keep the ${ttlName(ttlMin())}`
        let answer = keep
        try {
          answer = await $.ui.ask(`The cache is warm. Switching to the ${ttlName(want)} makes your next message rewrite up to ${tokens(S.ctx)} tokens (about ${cost}). Once the cache is cold, switching costs nothing extra. Switch now?`, ['Switch now', keep])
        } catch {
          // dismissed, or nobody to ask: keep the TTL
        }
        if (answer !== 'Switch now') return { text: `Cache TTL unchanged: ${ttlName(ttlMin())}. Switching now would rewrite up to ${tokens(S.ctx)} tokens (about ${cost}); after the cache goes cold it is free.` }
      }
      if (want !== settings.ttlMin && ['warm', 'cooling', 'kept'].includes(st.kind)) ttlSwitched = true
      settings.ttlMin = want
      S.ttlWritten = 0
      S.ttlWarned = false
      await applyTtl($)
    } else if (key === 'guard' || key === 'alerts') {
      settings[key] = value !== 'off'
    } else if (key === 'big') {
      const n = value === 'default' ? BIG_USD : parseUsd(value)
      if (!n) return { text: `Usage: \`/${names.cache} big $1\` (a dollar amount), or \`/${names.cache} big default\`.` }
      settings.bigUsd = n
    } else if (key === 'handoff') {
      const n = value === 'default' ? HANDOFF_AT : value === 'off' ? 0 : parseTokens(value)
      if (n === null) return { text: `Usage: \`/${names.cache} handoff 140k\` (a context size in tokens), \`off\`, or \`default\`.` }
      settings.handoffAt = n
      S.handoffNextAt = 0
    }
    if (key) {
      await $.store.set('settings', settings)
      $.ui.invalidate('ui.render')
    }
    return { text: statusText() }
  })

  on('command.run', { command: ['keepwarm', 'tk-keepwarm'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    let text
    if (arg === 'off' || (arg === '' && S.keepWarm)) {
      text = stopKeepWarm('turned off') || 'ℹ️ Keep warm is already off.'
    } else if (arg === '') {
      await measureStart($)
      text = startKeepWarm(defaultKeepWarmMs(), true, true)
    } else {
      const ms = parseDuration(arg)
      if (!ms) return { text: `Usage: \`/${names.keepwarm} 30m\`, \`/${names.keepwarm} 4h\`, or \`/${names.keepwarm} off\`.` }
      await measureStart($)
      text = startKeepWarm(ms, false, true)
    }
    $.ui.invalidate('ui.render')
    return { text }
  })

  // The band above the prompt: this session's cache at a glance
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    if (!S.lastActivity && !S.keepWarm) return below
    const mine = drawBand($, e)
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: below ? [mine, below] : [mine] })
  })

  // The band is terminal-only. The footer also draws in the Desktop app, so it
  // carries a short label, only when there's something to act on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = footerLabel()
    if (!label) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: [...modes, label] } })
  })
}

function drawBand($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const st = cacheState()
  const ttl = ttlMin()
  const big = isBig()
  const rewrite = usd(rewriteCost(S.ctx, S.model, ttl))
  const parts = []
  if (st.kind === 'kept') parts.push(Text({ color: 'cyan', children: [`◆ kept warm · ${S.pings} ping${S.pings === 1 ? '' : 's'} ${usd(S.pingUsd)} · until ${clock(S.keepWarmUntil)}`] }))
  else if (st.kind === 'warm') parts.push(Text({ color: 'green', children: [`● cache warm ${minutes(st.left)}`] }))
  else if (st.kind === 'cooling') parts.push(Text({ color: 'yellow', bold: true, children: [`◐ cache cools in ${minutes(st.left)}`] }))
  else if (st.kind === 'cold') parts.push(Text(big ? { color: 'red', bold: true, children: [`○ cache cold ${minutes(-st.left)}`] } : { dimColor: true, children: [`○ cache cold ${minutes(-st.left)}`] }))
  const pct = S.window ? Math.floor((S.ctx / S.window) * 100) : null
  const ctxText = ` │ ctx ${tokens(S.ctx)}${pct === null ? '' : `/${tokens(S.window)} ${pct}%`}`
  parts.push(Text(pct >= 80 ? { color: 'red', children: [ctxText] } : pct >= 50 ? { color: 'yellow', children: [ctxText] } : { dimColor: true, children: [ctxText] }))
  if (st.kind === 'cold' && big) parts.push(Text({ color: 'red', children: [` │ next send rewrites it ≈ ${rewrite}`] }))
  else parts.push(Text({ dimColor: true, children: [` │ rewrite ≈ ${rewrite}`] }))
  if (S.rateLimits.length) parts.push(Text(limitTone(S.rateLimits, { children: [' │ ' + limitsText(S.rateLimits)] })))
  if (S.coldRestarts.length) parts.push(Text({ dimColor: true, children: [` │ ${S.coldRestarts.length} cold restart${S.coldRestarts.length === 1 ? '' : 's'} ${usd(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}`] }))
  if (S.cacheBreaks.length) parts.push(Text({ color: 'yellow', children: [` │ ${S.cacheBreaks.length} cache break${S.cacheBreaks.length === 1 ? '' : 's'} ${usd(S.cacheBreaks.reduce((a, c) => a + c.usd, 0))}`] }))
  const row = [Box({ flexDirection: 'row', children: parts })]
  if (st.kind === 'cooling' && big) {
    row.push(Button({ key: 'keepwarm', label: 'keep warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); log($, startKeepWarm(defaultKeepWarmMs(), true, false)); $.ui.invalidate('ui.render') } }))
  } else if (st.kind === 'kept') {
    row.push(Button({ key: 'keepwarm', label: 'stop warm', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); log($, stopKeepWarm('turned off')); $.ui.invalidate('ui.render') } }))
  }
  const left = Box({ flexDirection: 'row', columnGap: 2, children: row })
  // Right edge: one click runs /session-handoff (h while the band has the focus;
  // a letter never fires from the prompt box, unlike a digit). Once a handoff
  // is in, c clears this chat and sends it as the fresh chat's first prompt.
  const busy = handoffPending || H.armed
  const handoff = Button({ key: 'handoff', label: handoffPending ? 'handoff queued' : H.armed ? 'handoff running' : 'handoff', hotkey: 'h', variant: 'primary', dimColor: busy, onPress: () => runHandoff($) })
  let right = handoff
  if (H.text || H.continuing) {
    const go = Button({ key: 'continue', label: H.continuing ? 'clearing' : 'clear and continue', hotkey: 'c', plain: true, onPress: () => clearAndContinue($) })
    right = Box({ flexDirection: 'row', columnGap: 2, children: [go, handoff] })
  }
  const top = Box({ flexDirection: 'row', justifyContent: 'space-between', width: '100%', columnGap: 2, children: [left, right] })
  // Second row: the model and what it costs
  const info = [Text({ color: 'magenta', children: [modelName(S.model)] })]
  if (S.effort) info.push(Text({ dimColor: true, children: [` · ${S.effort}`] }))
  info.push(Text({ dimColor: true, children: [` │ session ${usd(S.costUsd)}`] }))
  if (S.todayUsd !== null) info.push(Text({ dimColor: true, children: [` · today ${todayText()}`] }))
  return Box({ flexDirection: 'column', width: '100%', children: [top, Box({ flexDirection: 'row', children: info })] })
}

function footerLabel() {
  const parts = []
  const st = cacheState()
  const big = isBig()
  if (st.kind === 'kept') parts.push('cache kept warm')
  else if (st.kind === 'cooling' && big) parts.push(`cache cools in ${minutes(st.left)} · /${names.keepwarm} or /${names.handoff}`)
  else if (st.kind === 'cold' && big) parts.push(`cache cold · rewrite ≈ ${usd(rewriteCost(S.ctx, S.model, ttlMin()))}`)
  const high = S.rateLimits.filter((l) => (l.percentUsed || 0) >= 80)
  if (high.length) parts.push(limitsText(high))
  if (H.text) parts.push(`handoff ready · /${names.handoff} continue`)
  return parts.join(' · ')
}
