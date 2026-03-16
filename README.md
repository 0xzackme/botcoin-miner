# ⛏ BOTCOIN Miner

Plug-and-play BOTCOIN mining agent powered by **Bankr LLM Gateway**. Non-custodial, self-funding inference, web dashboard with real-time pipeline visibility. **Supports both local and multi-user service mode.**

## Quick Start

```bash
# 1. Install
git clone https://github.com/0xzackme/botcoin-miner.git && cd botcoin-miner
npm install

# 2. Configure (optional — for local mode)
cp .env.example .env
# Edit .env → set BANKR_API_KEY

# 3. Run
npm start
# Dashboard: http://localhost:3000
```

**No API key in `.env`?** Enter it via the dashboard UI. Each user gets an isolated mining session.

## Modes

| Mode | How | Use Case |
|------|-----|----------|
| **Local** | Set `BANKR_API_KEY` in `.env` | Self-hosted, single miner |
| **Service** | Don't set `.env` key, users enter via UI | Hosted for multiple miners |
| **Both** | Set `.env` key + others connect via UI | Your miner + service for others |

## Startup Flow (Auth-First)

The miner uses a fast auth-first approach — if you're already staked, it skips straight to mining in ~3 seconds:

```
Step 1: Resolve wallet (fast)
Step 2: Try auth → Already staked? → Mine immediately! ⚡
         ↓ (not staked)
Step 3: Try staking directly → Success? → Auth → Mine
         ↓ (no BOTCOIN)
Step 4: Check price (DexScreener) → Check ETH balance → Swap → Stake → Auth → Mine
```

- **Already staked**: Wallet → Auth → Mine (~3s)
- **Have BOTCOIN, not staked**: Wallet → Auth fail → Stake → Auth → Mine (~10s)
- **Fresh wallet**: Wallet → Auth fail → Stake fail → Price check → Swap → Stake → Auth → Mine

Balance checks and swaps only happen when actually needed.

## Multi-User Service Mode

When hosted publicly, **each user** who enters their Bankr API key gets:
- Own session (cookie-based, 24h TTL)
- Own wallet resolution & mining loop
- Own stats, credits, epoch tracking
- Own SSE log stream
- Auto-cleanup when idle for 24h

Close browser? Mining keeps running server-side.

## Mining Pipeline (4-Stage)

Each challenge goes through:

1. **Extract** — LLM reads prose document about 25 fictional companies, answers questions
2. **Verify** *(optional)* — Second model double-checks answers (toggle in UI)
3. **Parse Constraints** — LLM structures constraints into JSON
4. **Build Artifact** — LLM generates artifact string, local validator checks compliance (up to 3 retries)

## Supported Models (14)

All models available through Bankr LLM Gateway, switchable live from the UI:

| Provider | Models |
|----------|--------|
| **Google** | Gemini 2.5 Flash *(recommended)*, Gemini 2.5 Pro, Gemini 3 Flash, Gemini 3 Pro |
| **Anthropic** | Claude Sonnet 4.5, Claude Haiku 4.5, Claude Opus 4.5, Claude Opus 4.6 |
| **OpenAI** | GPT 5.2, GPT 5.2 Codex, GPT 5 Mini, GPT 5 Nano |
| **Moonshot** | Kimi K2 |
| **Alibaba** | Qwen Max |

## Security

### API Key Encryption at Rest

All API keys are encrypted using **AES-256-GCM** and only decrypted on demand for API calls. Zero plaintext keys stored in memory at rest.

| File | Storage | Decryption |
|------|---------|------------|
| `sessions.js` | `_encryptedApiKey` | `_getApiKey()` per Bankr/LLM call |
| `bankr.js` | `encryptedApiKey` | `_getApiKey()` in `headers()` |
| `pipeline.js` | `encryptedApiKey` | Decrypted in `callLLM()` only |
| `server.js` | `ENCRYPTED_API_KEY` | Decrypted in `/api/models` only |

Set `ENCRYPTION_KEY` env var (64 hex chars) for persistence across server restarts.

### Coordinator Request Timeouts

Per-endpoint **AbortController** timeouts prevent hanging requests:

| Endpoint | Timeout | Label |
|----------|---------|-------|
| Auth (nonce/verify) | 15s | `auth` |
| Challenge | 45s | `challenge` |
| Submit solution | 45s | `submit` |
| Stake/Unstake/Withdraw | 30s | `stake`/`unstake` |
| Claims/Bonus | 30s | `claim`/`bonus` |
| Epoch/Credits/Token | 15s | `epoch`/`credits`/`token` |

All timeouts include automatic retry with backoff on `AbortError`.

### Other

- **Non-custodial** — no private keys stored, only Bankr API key (encrypted)
- **Session isolation** — each user's data is fully isolated via cookie-based sessions

## Features

- **Non-custodial** — only stores Bankr API key (per-session), no private keys
- **Auth-first startup** — skips balance checks if already staked (fast path)
- **Smart auto-fund** — checks BOTCOIN price via DexScreener, calculates exact ETH needed
- **Multi-user** — cookie-based session isolation, per-user mining loops
- **Model switching** — 14 models, live dropdown, takes effect on next LLM call
- **Dual-model verification** — optional toggle to use a separate model for answer verification
- **Tier-based staking** — 25M / 50M / 100M BOTCOIN (1 / 2 / 3 credits per solve)
- **Auto top-up LLM credits** — monitors balance, tops up from USDC
- **Auto-claim rewards** — every 30 min, checks bonus epochs
- **Rate limit handling** — exponential backoff with jitter per botcoinskill.md
- **Real-time UI** — SSE log streaming, pipeline progress bar, live stats
- **Resilient** — retries on Bankr transient errors (balance, swap, staking)

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

## Deploy

### Railway (Recommended — Free Subdomain)

1. Push to GitHub
2. [railway.app](https://railway.app) → Deploy from GitHub → Select repo
3. Add env vars in Railway dashboard
4. Auto-deploys → get `https://your-app.up.railway.app`

### Docker

```bash
docker compose up -d
```

### VPS (Direct)

```bash
npm install -g pm2
pm2 start src/server.js --name botcoin-miner
pm2 save && pm2 startup
```

Access via `http://YOUR_VPS_IP:3000`

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/apikey` | Set API key, create session |
| POST | `/api/start` | Start mining |
| POST | `/api/stop` | Stop mining |
| POST | `/api/claim` | Claim rewards |
| POST | `/api/config` | Switch models, toggle verify |
| GET | `/api/status` | Session status + stats |
| GET | `/api/events` | SSE log stream |
| GET | `/api/models` | Available LLM models |
| GET | `/api/info` | Server info |
| POST | `/api/logout` | Destroy session |

## Bounty Checklist

- [x] Entirely non-custodial
- [x] Plug and play (API key → auto wallet → auto fund → auto stake → mine)
- [x] Model choice selector (14 models from 5 providers)
- [x] Pre-equipped with botcoin miner skill (follows botcoinskill.md)
- [x] Proper rate-limit handling (backoff, jitter, per-endpoint rules)
- [x] Self-fund inference via auto top-ups
- [x] UI with real-time agent/LLM output visibility
- [x] Multi-user service mode

## License

MIT
