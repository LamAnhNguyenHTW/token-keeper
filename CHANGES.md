# Changes

## 1.1.0 (2026-10-06)
- `/keepwarm` says when a `/handoff` now is cheaper than the pings it would send, with both prices, and how much less each turn after it costs.
- A handoff's cost is measured: the fresh chat's start from /context (system prompt, tools, MCP tools, memory files), and the average output of the last five handoffs.
- A notice suggests `/handoff` or `/compact` once a chat passes `/cache handoff` tokens (300k by default, or off), with what each turn would save.

## 1.0.0 (2026-10-06)
- First release. Forked from Cache Keeper 1.0.0 by Nate Herk (nateherkai/claude-code-mods), cut down to four jobs: stats, cache settings, keep warm, handoff.
- Cache-break detector: a rewrite while the cache was warm, with the suspected cause.
- `/cache big` is a dollar amount ($1 by default), shown with its token equivalent for the current model and TTL.
- `/keepwarm` runs for 30m by default on the 5-minute TTL and for 4h on the 1-hour TTL, and warns past its break-even with a pointer to `/handoff` or `/clear`.
- The cooling warning offers `/handoff` while the cache is still warm.
- Warnings and notices show as a line in the chat right after the prompt.
- Today's cost across sessions, with `≥` when a transcript is too big to read.
