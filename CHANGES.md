# Changes

## Unreleased
- `/cache ttl 5|60` sets Claude Code's own cache TTL (`CLAUDE_CODE_PROMPT_CACHE_TTL`), from the next request on and again at each session start; `/cache ttl auto` gives the variable back. Before, it only changed what Token Keeper assumed.
- The cache window is measured from each cache write (`ephemeral_1h` vs `ephemeral_5m`), and `/cache` says whether the TTL you set is confirmed. A line warns once when Claude Code writes another TTL than the one you set.
- `/cache ttl` asks first while the cache is warm and the context is over 30k tokens: the switch makes the next message rewrite it, with the price. Once the cache is cold it switches without asking, since that rewrite happens anyway.
- After a switch while warm, the first request reports what the rewrite really cost ("Switching to the 5-min TTL rewrote 11.3k tokens for about $0.06") instead of flagging it as a cache break. The question's price is an upper bound: parts already cached under the new TTL, such as the system prompt, are read, not rewritten.
- The TTL is also measured when the live usage has no 1h/5m split (it usually has none): from what Claude Code charged for the request, which counts the TTL really written.
- Fix: keep warm stopped after its first ping. That ping may write the turn's tail, because a fork's prefix ends after the reply and the main thread's entry before it; it was taken for a cold cache. Now only a later ping that writes much stops keep warm, and a cache already past its TTL is not pinged at all. Measured live: with pings every 3.5 minutes, the main thread read its whole context after an 8-minute pause on the 5-minute TTL.
- Fix: on the 5-minute TTL the cache counted as cooling right after every turn, so the cooling warning came after every turn. Cooling now starts when a keep-warm ping would go out (90 seconds before on the 5-minute TTL, 5 minutes before on the 1-hour one).
- Fix: a return past the TTL counts as a cold restart when a fifth or more is rewritten; before it took half, and the system prompt part often stays warm through other sessions.
- The handoff notice leads with quality ("a long context gets less reliable") and names a per-turn saving only when the fresh chat is clearly smaller.

## 1.1.0 (2026-10-06)
- `/keepwarm` says when a `/handoff` now is cheaper than the pings it would send, with both prices, and how much less each turn after it costs.
- A handoff's cost is measured: the fresh chat's start from /context (system prompt, tools, MCP tools, memory files), and the average output of the last five handoffs.
- Past `/cache handoff` tokens (140k by default, or off) a notice suggests `/handoff` or `/compact`, with what each turn would save, and asks: hand off now, remind me after another 100k, or no more reminders.
- Fix: a new `/keepwarm` run counts its own pings; before, the count and cost carried over from earlier runs in the session.

## 1.0.0 (2026-10-06)
- First release. Forked from Cache Keeper 1.0.0 by Nate Herk (nateherkai/claude-code-mods), cut down to four jobs: stats, cache settings, keep warm, handoff.
- Cache-break detector: a rewrite while the cache was warm, with the suspected cause.
- `/cache big` is a dollar amount ($1 by default), shown with its token equivalent for the current model and TTL.
- `/keepwarm` runs for 30m by default on the 5-minute TTL and for 4h on the 1-hour TTL, and warns past its break-even with a pointer to `/handoff` or `/clear`.
- The cooling warning offers `/handoff` while the cache is still warm.
- Warnings and notices show as a line in the chat right after the prompt.
- Today's cost across sessions, with `≥` when a transcript is too big to read.
