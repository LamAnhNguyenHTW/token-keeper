import { test, expect, mock } from 'claude-code/testing'

test('/keepwarm uses the TTL default and says so', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const r = await $.command.run({ command: 'keepwarm', args: '' })
  expect(r.text).toContain('ℹ️ Keeping this cache warm for **4h00m**, the default on the 1h TTL')
  expect(r.text).toContain('pays off up to ~34h40m')
})

test('/keepwarm past the break-even warns and points to handoff', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  await $.command.run({ command: 'cache', args: 'ttl 5' })
  const r = await $.command.run({ command: 'keepwarm', args: '3h' })
  expect(r.text?.startsWith('⚠️')).toBe(true)
  expect(r.text).toContain('only pays off up to **~1h28m**')
  expect(r.text).toContain('Better: **/keepwarm 30m** (the default), **/handoff**')
})

test('/cache big is in dollars, marks the default, and shows tokens', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const shown = await $.command.run({ command: 'cache', args: '' })
  expect(shown.text).toContain('**$1.00 (default) ≈ 125k tokens on Opus 5.5, 1h TTL**')
  expect(shown.text).toContain('- ◆ **Keep warm:**')
  const set = await $.command.run({ command: 'cache', args: 'big $2' })
  expect(set.text).toContain('$2.00 ≈ 250k tokens')
  const back = await $.command.run({ command: 'cache', args: 'big default' })
  expect(back.text).toContain('$1.00 (default)')
  const bad = await $.command.run({ command: 'cache', args: 'big lots' })
  expect(bad.text).toContain('Usage')
})

test('/keepwarm offers a handoff when that is cheaper than the pings', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0, output_tokens: 100 } } as any
  })
  // what /context counts: a fresh chat would start with 30k of these, not the messages
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 330000, window: 1000000, breakdown: { categories: [
    { name: 'System prompt', tokens: 15000, kind: 'used' },
    { name: 'System tools', tokens: 10000, kind: 'used' },
    { name: 'Memory files', tokens: 5000, kind: 'used' },
    { name: 'Messages', tokens: 300000, kind: 'used' },
    { name: 'Free space', tokens: 670000, kind: 'free' },
  ] } } } }) as any)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any) as any) {}
  await $.command.run({ command: 'cache', args: 'ttl 5' })
  const r = await $.command.run({ command: 'keepwarm', args: '' })
  // 300k read $0.06 + 3k handoff $0.06 + 30k fresh start $0.15 vs 9 pings of $0.06
  expect(r.text).toContain('A **/handoff** now is cheaper: about $0.27 vs $0.54 for 30m of pings. After it, each turn re-reads about 33.0k instead of 300k, about $0.05 less.')
  const shown = await $.command.run({ command: 'cache', args: '' })
  expect(shown.text).toContain('**Handoff hint:** from **300k** tokens (default)')
  expect(shown.text).toContain('fresh chat 30.0k, handoff 3.0k estimated')
})

test('/cache handoff takes a context size in tokens, or off', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  expect((await $.command.run({ command: 'cache', args: 'handoff 500k' })).text).toContain('**Handoff hint:** from **500k** tokens, then every 100k more ·')
  expect((await $.command.run({ command: 'cache', args: 'handoff off' })).text).toContain('**Handoff hint:** off')
  expect((await $.command.run({ command: 'cache', args: 'handoff $2' })).text).toContain('Usage: `/cache handoff 300k`')
})

test('past the handoff size, a notice suggests /handoff, again 100k later', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const logs: string[] = []
  on('ui.log', (_$, e: any) => { logs.push(String(e.text ?? e)); return { value: {} } as any })
  on('turn.complete', () => ({ text: '' }) as any)
  let ctx = 310000
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, output_tokens: 100 } } as any
  })
  for (const id of ['t1', 't2']) {
    for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any) as any) {}
    await $.turn.complete({ turnId: id, reason: 'answer', answer: 'ok' } as any)
  }
  const hint = logs.filter((l) => l.includes('This chat is at 310k tokens'))
  expect(hint.length).toBe(1)
  expect(hint[0]).toContain('re-reads all of it ($0.06). A /handoff or /compact (about $0.28, either) carries on with about 23.0k: about $0.06 less per turn.')
  // the next reminder comes 100k later
  ctx = 405000
  for await (const _ of $.turn.step({ turnId: 't3', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any) as any) {}
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'ok' } as any)
  expect(logs.filter((l) => l.includes('This chat is at 405k tokens')).length).toBe(1)
})
