import { test, expect, mock } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 } } as const

test('the band shows model, effort and session cost', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(Date.parse('2026-10-05T12:00:00Z'))
  mock.store(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }) as any)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0, output_tokens: 100 } } as any
  })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as any)
  for await (const _ of step as any) {}
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'token-keeper', surface, ...BAND } as any)
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /high/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /session \$/ })).toBeDefined()
    await ui.unmount()
  }
})
