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
