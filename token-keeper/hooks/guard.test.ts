import { test, expect, mock } from 'claude-code/testing'

const compacted = () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] })

// A big chat whose cache went cold: the guard asks before the next message,
// and the test answers as the person would
async function coldChat($: any, on: any, answer: string, compact: () => any, attachments?: any[], text = 'hello again') {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  on('session.measure', () => ({ changed: [] }) as any)
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 309000, cache_creation_input_tokens: 0, output_tokens: 100 } } as any
  })
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: any, e: any) => {
    const q = e.questions[0].question
    asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: answer } } } as any
  })
  let compacted = 0
  on('session.compact', () => { compacted++; return compact() })
  const sent: { text: string, origin: any }[] = []
  on('prompt.submit', (_$: any, e: any) => { sent.push({ text: e.text, origin: e.origin }); return { text: e.text } as any })
  const filled: string[] = []
  on('prompt.fill', (_$: any, e: any) => { filled.push(e.text); return { isFilled: true } as any })
  const logs: string[] = []
  on('ui.log', (_$: any, e: any) => { logs.push(e.text); return { value: undefined } as any })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as any) as any) {}
  await $.session.measure({ context: { tokens: 309000, window: 1000000 }, rateLimits: [], changed: [] } as any)
  await clock.advance(2 * 60 * 60 * 1000)
  const r = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, attachments } as any)
  // what the guard does once its hook has returned
  await clock.advance(10)
  return { r, asked, sent, filled, logs, compacted: () => compacted }
}

test('guard: "Compact first, then send" compacts, then sends the message as typed', async ($, on) => {
  const t = await coldChat($, on, 'Compact first, then send', compacted)
  expect(t.asked.length).toBe(1)
  expect((t.r as any).drop).toContain('compacting first')
  expect(t.compacted()).toBe(1)
  expect(t.sent.map((s) => s.text)).toEqual(['hello again'])
  expect(t.sent[0].origin.asUser).toBe(true)
  expect(t.filled).toEqual([])
})

test('guard: a compaction a hook skipped sends nothing and puts the message back', async ($, on) => {
  const t = await coldChat($, on, 'Compact first, then send', () => ({ skip: 'off' }))
  expect(t.compacted()).toBe(1)
  expect(t.sent).toEqual([])
  expect(t.filled).toEqual(['hello again'])
  expect(t.logs.some((l) => l.includes("Not sent: compacting didn't work (off)"))).toBe(true)
})

test('guard: with pasted images it compacts, then puts the message back to attach them again', async ($, on) => {
  const t = await coldChat($, on, 'Compact first, then send', compacted, [{ type: 'image' }])
  expect(t.compacted()).toBe(1)
  expect(t.sent).toEqual([])
  expect(t.filled).toEqual(['hello again'])
})

test('guard: with an @file mention it compacts, then puts the message back to send it', async ($, on) => {
  const t = await coldChat($, on, 'Compact first, then send', compacted, undefined, 'look at @src/app.ts')
  expect(t.compacted()).toBe(1)
  expect(t.sent).toEqual([])
  expect(t.filled).toEqual(['look at @src/app.ts'])
})

test('guard: an email address is no @file mention', async ($, on) => {
  const t = await coldChat($, on, 'Compact first, then send', compacted, undefined, 'mail me@example.com')
  expect(t.sent.map((s) => s.text)).toEqual(['mail me@example.com'])
})

test('guard: "Send anyway" sends without compacting', async ($, on) => {
  const t = await coldChat($, on, 'Send anyway', compacted)
  expect(t.compacted()).toBe(0)
  expect(t.sent.map((s) => s.text)).toEqual(['hello again'])
})

test('guard: "Cancel" sends nothing', async ($, on) => {
  const t = await coldChat($, on, 'Cancel', compacted)
  expect(t.compacted()).toBe(0)
  expect(t.sent).toEqual([])
})
