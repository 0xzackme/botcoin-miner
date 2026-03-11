# ⛏ BOTCOIN Miner

Plug-and-play BOTCOIN mining agent powered by **Bankr LLM Gateway**. Non-custodial, self-funding inference, web dashboard with real-time pipeline visibility. **Supports both local (self-hosted) and multi-user service mode.**

## Quick Start

```bash
# 1. Install
git clone <repo-url> && cd botcoin-miner
npm install

# 2. Configure (optional — for local mode)
cp .env.example .env
# Edit .env → set BANKR_API_KEY

# 3. Run
npm start
# Dashboard: http://localhost:3000
```

**No API key in `.env`?** No problem — enter it via the dashboard UI. Each user gets an isolated mining session.

## Modes

| Mode | How | Use Case |
|------|-----|----------|
| **Local** | Set `BANKR_API_KEY` in `.env` | Self-hosted, single miner |
| **Service** | Don't set `.env` key, users enter via UI | Hosted for multiple miners |
| **Both** | Set `.env` key + others connect via UI | Your miner + service for others |

## Multi-User Service Mode

When hosted publicly, **each user** who enters their Bankr API key gets:
- Own session (cookie-based, 24h TTL)
- Own wallet resolution
- Own isolated mining loop
- Own stats, credits, epoch tracking
- Own SSE log stream (only sees their logs)
- Auto-cleanup when idle for 24h

```
User A → enters API key → session abc → mines with wallet 0xAAA...
User B → enters API key → session def → mines with wallet 0xBBB...
```

Complete isolation — users cannot see or interfere with each other.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Express Server (server.js)                     │
│                                                 │
│  ┌──────────────┐    ┌──────────────────────┐   │
│  │ SessionManager│───▶│ MinerSession (User A)│   │
│  │  (sessions.js)│    │  - bankr API calls   │   │
│  │               │    │  - solver pipeline   │   │
│  │               │    │  - mining loop       │   │
│  │               │    │  - auto-claim        │   │
│  │               │    │  - credit monitor    │   │
│  │               │    │  - SSE broadcast     │   │
│  │               │    └──────────────────────┘   │
│  │               │    ┌──────────────────────┐   │
│  │               │───▶│ MinerSession (User B)│   │
│  │               │    │  (fully isolated)    │   │
│  └──────────────┘    └──────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Mining Pipeline (4-Stage)

Each challenge goes through:

1. **Extract** — LLM reads document, answers questions about 25 companies
2. **Verify** — Second model double-checks answers (catches multi-hop errors)
3. **Parse Constraints** — LLM structures constraints into JSON
4. **Build Artifact** — LLM generates artifact, local validator checks compliance (up to 3 retries)

## Features

- **Non-custodial** — only stores Bankr API key (per-session), no private keys
- **Plug & play** — enter API key → auto-resolves wallet → auto-buys BOTCOIN → auto-stakes → mines
- **Multi-user** — cookie-based session isolation, per-user mining loops
- **Model switching** — live dropdown, takes effect on next LLM call (no restart)
- **Tier-based staking** — 25M/50M/100M BOTCOIN (1/2/3 credits per solve)
- **Auto top-up LLM credits** — monitors balance, tops up from USDC
- **Auto-claim rewards** — every 30 min, checks bonus epochs
- **Rate limit handling** — exponential backoff with jitter per botcoinskill.md
- **Real-time UI** — SSE log streaming, pipeline progress, stats

## Environment Variables

```bash
# Required
BANKR_API_KEY=bk_your_key     # Optional for service mode (users enter via UI)

# LLM Models
LLM_MODEL=gemini-2.5-flash    # Primary solver model
LLM_MODEL_VERIFY=             # Verification model (defaults to primary)

# Server
PORT=3000
AUTH_PASSWORD=                 # Optional basic auth for hosted mode

# Credit monitoring
CREDIT_MIN_USD=2              # Top-up when below this
CREDIT_TOPUP_USD=5            # Amount to top up
CREDIT_TOPUP_TOKEN=USDC       # Token to pay with

# Mining
MAX_CONSECUTIVE_FAILURES=5    # Pause after N failures
COORDINATOR_URL=https://coordinator.agentmoney.net
```

## Docker Deployment

```bash
# One command
docker compose up -d

# With custom port
PORT=8080 docker compose up -d
```

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/apikey` | Set API key, create session |
| POST | `/api/start` | Start mining |
| POST | `/api/stop` | Stop mining |
| POST | `/api/claim` | Claim rewards |
| POST | `/api/config` | Switch models |
| GET | `/api/status` | Session status + stats |
| GET | `/api/events` | SSE log stream |
| GET | `/api/info` | Server info (version, active sessions) |
| POST | `/api/logout` | Destroy session |

## Bounty Checklist

- [x] Entirely non-custodial
- [x] Plug and play (API key → auto wallet → auto fund → auto stake → mine)
- [x] Model choice selector for LLM gateway
- [x] Pre-equipped with botcoin miner skill (follows botcoinskill.md flow)
- [x] Proper rate-limit handling (backoff, jitter, per-endpoint rules)
- [x] Self-fund inference via top-ups
- [x] UI with real-time agent output
- [x] Multi-user service mode

## License

MIT
