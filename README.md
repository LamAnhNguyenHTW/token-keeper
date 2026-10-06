# Token Keeper

A Claude Code mod for token economics, for subscription and API users alike. It is a fork of **Cache Keeper** by [Nate Herk](https://github.com/nateherkai), from [nateherkai/claude-code-mods](https://github.com/nateherkai/claude-code-mods) (MIT), cut down to four jobs: show what the cache costs, set it up, keep it warm, and hand a big chat off to a fresh one.

## Credits

All of Cache Keeper's original work is Nate Herk's: the warm/cold cache band, `/keepwarm`, the cold-send guard, TTL detection, `/handoff` and the session-handoff skill, plus the shared `pricing` and `fmt` helpers. Go check out his repo and videos. This fork changes and adds the things listed below. It leaves out Cache Keeper's `/board` and recording mode for now.

## What's different from Cache Keeper

- **Cache-break detector.** If a request rewrites most of the context even though the cache was still warm (less than 4.5 minutes idle), Token Keeper reports it as a *cache break* and names the cause it suspects: a model switch, or a changed prompt prefix (CLAUDE.md, MCP tools, settings, effort). Cache breaks show on the band and in `/cache`.
- **The threshold is in dollars.** A context counts as big when rewriting it costs at least `/cache big` ($1 by default). Token Keeper works out what that means in tokens for the current model and TTL, for example $1 ≈ 125k tokens on Opus 5.5 with the 1h TTL. Above it, the cold-send guard asks before a cold send, a line in the chat warns before the cache goes cold, and the band shows the keep-warm button.
- **Keep warm knows its break-even.** `/keepwarm` runs for 30 minutes on the 5-minute TTL and for 4 hours on the 1-hour TTL by default. A rewrite costs as much as (cache-write price / cache-read price) pings, whatever the context size, so pinging pays off only up to a point, for example about 1h 28m on Opus 5.5 with the 5-minute TTL. Ask for longer and you get a warning that suggests `/handoff` or `/clear` instead.
- **A handoff while the cache is warm.** On a cold cache, writing a handoff rewrites the whole context too. So the cooling warning offers `/handoff` before the cache goes cold.
- **Today's cost across sessions.** A cache file per day keeps what each transcript cost, so only transcripts that changed are read again, and this session counts live. A transcript too big to read shows as `≥` instead of being left out without a word.

## Install

Needs Claude Code 2.1.287 or later, with mods turned on for your account.

```bash
claude plugin marketplace add LamAnhNguyenHTW/token-keeper
claude plugin install token-keeper@token-keeper
```

Don't install it alongside Cache Keeper: both register `/cache`, `/keepwarm` and `/handoff`. If a name is already taken, Token Keeper falls back to `/tk-cache` and so on.

## Commands

| Command | What it does |
|---|---|
| `/cache` | Status and settings |
| `/cache ttl 5\|60\|auto` | Cache window |
| `/cache guard on\|off` | Ask before a cold send of a big context |
| `/cache big $1\|default` | When a context counts as big: what a rewrite costs. $1 by default |
| `/cache alerts on\|off` | Warnings in the chat |
| `/keepwarm [30m\|4h\|off]` | Keep the cache warm. 30m by default on the 5-minute TTL, 4h on the 1-hour TTL |
| `/handoff [continue]` | Hand the chat off to a fresh one |

## Data

Everything stays local, under `~/.claude/mods-data/token-keeper/`. The mod makes no network calls of its own. The only extra requests are the keep-warm pings, and those run only while `/keepwarm` is on.

## License

MIT. See [LICENSE](LICENSE). The original copyright belongs to Nate Herk.
