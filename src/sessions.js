// ─── Session Manager ────────────────────────────────────
// Manages isolated miner sessions for multi-user support.
// Each session = own API key, wallet, miner loop, stats, SSE.
//
// - Local mode (BANKR_API_KEY in .env): auto-creates "local" session
// - Service mode (web): users enter API key, get a session cookie

const crypto = require('crypto');
const bankr = require('./bankr');
const coordinator = require('./coordinator');
const solver = require('./solver/pipeline');
const credits = require('./credits');
const log = require('./logger');
const { classify, AuthError, CreditError, FatalError, RetryableError } = require('./errors');
const path = require('path');
const fs = require('fs');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 min
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 5;
const AUTO_CLAIM_INTERVAL = 30 * 60 * 1000;

// Tier map
const TIER_MAP = {
    '25000000000000000000000000': { tokens: 25000000, label: 'Tier 1 (25M)' },
    '50000000000000000000000000': { tokens: 50000000, label: 'Tier 2 (50M)' },
    '100000000000000000000000000': { tokens: 100000000, label: 'Tier 3 (100M)' }
};

function getTierTokens(wei) {
    const t = TIER_MAP[wei];
    if (t) return t.tokens;
    try { const v = parseInt(wei) / 1e18; return v > 0 ? v : 25000000; } catch { return 25000000; }
}

const STATES = {
    IDLE: 'IDLE', MINING: 'MINING', PAUSED: 'PAUSED', ERROR: 'ERROR',
    CLAIMING: 'CLAIMING', CHECKING_WALLET: 'CHECKING_WALLET',
    FUNDING: 'FUNDING', STAKING: 'STAKING', AUTHENTICATING: 'AUTHENTICATING'
};

// ─── Session Class ──────────────────────────────────────

class MinerSession {
    constructor(sessionId, apiKey) {
        this.sessionId = sessionId;
        this.apiKey = apiKey;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();

        // State
        this.state = STATES.IDLE;
        this.isRunning = false;
        this.shouldStop = false;
        this.walletAddress = null;

        // Auth
        this.authToken = null;
        this.authExpiresAt = null;

        // Stats
        this.stats = {
            challengesAttempted: 0, challengesPassed: 0, challengesFailed: 0,
            creditsEarned: 0, receiptsPosted: 0, currentEpoch: null,
            epochsMined: [], consecutiveFailures: 0, startedAt: null,
            lastSolveAt: null, lifetimePassed: 0, lifetimeFailed: 0, lifetimeCredits: 0
        };

        // SSE clients for this session
        this.sseClients = [];

        // Background services
        this.claimIntervalId = null;
        this.creditIntervalId = null;

        // Abort controller
        this.abortController = new AbortController();

        // Per-session bankr/solver instances (create isolated copies)
        this._bankrApiKey = apiKey;
        this._primaryModel = process.env.LLM_MODEL || 'gemini-2.5-flash';
        this._verifyModel = process.env.LLM_MODEL_VERIFY || null;
        this._verifyEnabled = false;
    }

    touch() { this.lastActivity = Date.now(); }

    setState(newState) {
        const old = this.state;
        this.state = newState;
        if (old !== newState) {
            this.log('info', 'miner', `State: ${old} → ${newState}`);
        }
    }

    log(level, source, message) {
        const entry = { timestamp: new Date().toISOString(), level, source, message };
        // Broadcast to this session's SSE clients only
        this.broadcast({ type: 'log', entry });
        // Also log to server console
        log[level]?.(source, `[${this.sessionId.slice(0, 8)}] ${message}`);
    }

    broadcast(data) {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        this.sseClients = this.sseClients.filter(res => {
            try { res.write(msg); return true; } catch { return false; }
        });
    }

    addSSEClient(res) {
        this.sseClients.push(res);
        // Send current state immediately
        res.write(`data: ${JSON.stringify({ type: 'state', ...this.getStatus() })}\n\n`);
    }

    removeSSEClient(res) {
        this.sseClients = this.sseClients.filter(r => r !== res);
    }

    getStatus() {
        return {
            state: this.state,
            isRunning: this.isRunning,
            walletAddress: this.walletAddress,
            stats: this.stats,
            hasApiKey: !!this._bankrApiKey,
            model: this._primaryModel,
            verifyModel: this._verifyModel || this._primaryModel,
            sessionId: this.sessionId
        };
    }

    setModel(m) { this._primaryModel = m; }
    getModel() { return this._primaryModel; }
    setVerifyModel(m) { this._verifyModel = m; }
    getVerifyModel() { return this._verifyModel || this._primaryModel; }

    // ─── Bankr calls (use session's API key) ────────────

    _headers(withContent) {
        const h = { 'X-API-Key': this._bankrApiKey };
        if (withContent) h['Content-Type'] = 'application/json';
        return h;
    }

    async _fetchBankr(endpoint, opts = {}) {
        if (this.shouldStop) throw new Error('Operation aborted by user');
        const url = `https://api.bankr.bot${endpoint}`;
        opts.headers = { ...opts.headers, ...this._headers(!!opts.body) };
        opts.signal = this.abortController.signal;
        const res = await fetch(url, opts);
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
        if (!res.ok) {
            const msg = body.message || body.error || text.slice(0, 300);
            const err = new Error(`HTTP ${res.status}: ${msg}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    async _pollJob(jobId, timeoutMs = 120000) {
        const start = Date.now();
        let polls = 0;
        while (Date.now() - start < timeoutMs) {
            if (this.shouldStop) throw new Error('Job polling aborted');
            const data = await this._fetchBankr(`/agent/job/${jobId}`);
            if (data.status === 'completed') return data;
            if (data.status === 'failed' || data.status === 'error') {
                throw new Error(`Job failed: ${data.response || JSON.stringify(data)}`);
            }
            polls++;
            if (polls % 5 === 0) {
                const elapsed = Math.round((Date.now() - start) / 1000);
                this.log('debug', 'bankr', `Waiting for Bankr... (${elapsed}s, ${data.status || 'pending'})`);
            }
            await this._sleep(2000);
        }
        throw new Error(`Job timed out after ${Math.round(timeoutMs / 1000)}s`);
    }

    async _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    async getWalletAddress() {
        this.log('info', 'bankr', 'Resolving wallet address...');
        const data = await this._fetchBankr('/agent/me');
        const wallets = data.wallets || data.data?.wallets || [];
        for (const w of wallets) {
            if (w.chain === 'base' || w.chain === 'evm' || w.network === 'base' || w.type === 'evm') {
                return w.address;
            }
        }
        if (wallets.length > 0) return wallets[0].address;
        if (data.address) return data.address;
        throw new Error('No Base/EVM wallet found');
    }

    async getBalances() {
        this.log('info', 'bankr', 'Checking balances on Base...');
        const { jobId } = await this._fetchBankr('/agent/prompt', {
            method: 'POST', body: JSON.stringify({ prompt: 'what are my balances on base?' })
        });
        const result = await this._pollJob(jobId);
        return result.response || '';
    }

    async swapForBotcoin(amount) {
        const token = '0xA601877977340862Ca67f816eb079958E5bd0BA3';
        this.log('info', 'bankr', `Swapping ETH for ${amount.toLocaleString()} BOTCOIN...`);
        const { jobId } = await this._fetchBankr('/agent/prompt', {
            method: 'POST',
            body: JSON.stringify({ prompt: `swap my ETH on base for exactly ${amount} tokens of ${token}` })
        });
        const result = await this._pollJob(jobId, 180000);
        return result.response;
    }

    async submitTransaction(tx, description) {
        this.log('info', 'bankr', `Submitting tx: ${description}`);
        const payload = {
            transaction: { to: tx.to, chainId: tx.chainId || 8453, value: tx.value || '0', data: tx.data },
            description, waitForConfirmation: true
        };
        const result = await this._fetchBankr('/agent/submit', {
            method: 'POST', body: JSON.stringify(payload)
        });
        if (result.success) this.log('success', 'bankr', `Tx confirmed: ${result.transactionHash}`);
        return result;
    }

    async signMessage(message) {
        const data = await this._fetchBankr('/agent/sign', {
            method: 'POST',
            body: JSON.stringify({ signatureType: 'personal_sign', message })
        });
        return data.signature;
    }

    // ─── LLM calls (use session's API key + model) ─────

    async callLLM(prompt, model, options = {}) {
        const useModel = model || this._primaryModel;
        this.log('debug', 'solver', `LLM call → ${useModel} (${prompt.length} chars)`);

        const body = {
            model: useModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: options.temperature ?? 0.1,
            max_tokens: options.maxTokens || 4096
        };
        if (options.json) body.response_format = { type: 'json_object' };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);

        let res;
        try {
            res = await fetch('https://llm.bankr.bot/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': this._bankrApiKey },
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') throw new RetryableError('LLM timeout after 300s', 0, 30000);
            throw e;
        }
        clearTimeout(timer);

        if (!res.ok) {
            const text = await res.text();
            if (res.status === 401 || res.status === 403) {
                const err = new Error(`LLM auth error ${res.status}: ${text.slice(0, 200)}`);
                err.status = res.status; throw err;
            }
            if (res.status === 402 || text.includes('billing') || text.includes('credits'))
                throw new CreditError(`LLM credits exhausted: ${text.slice(0, 200)}`);
            if (res.status === 429)
                throw new RetryableError(`LLM rate limited`, 429, 45000);
            if (res.status >= 500)
                throw new RetryableError(`LLM server error ${res.status}`, res.status, 30000);
            const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
            err.status = res.status; throw err;
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content?.trim() || '';
        return { content, usage: data.usage || {} };
    }

    // ─── Auth ───────────────────────────────────────────

    async ensureAuth() {
        if (this.authToken && this.authExpiresAt) {
            const remaining = this.authExpiresAt - Date.now();
            if (remaining > 60000) return;
        }
        this.setState(STATES.AUTHENTICATING);
        this.log('info', 'coordinator', 'Starting auth handshake...');

        const nonceResp = await coordinator.retryFetch(
            `${coordinator.getBaseUrl()}/v1/auth/nonce`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ miner: this.walletAddress }) }, 'auth'
        );
        if (!nonceResp.message) throw new Error('Auth nonce missing message');

        const signature = await this.signMessage(nonceResp.message);
        if (!signature) throw new Error('Sign response missing signature');

        const verifyResp = await coordinator.retryFetch(
            `${coordinator.getBaseUrl()}/v1/auth/verify`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ miner: this.walletAddress, message: nonceResp.message, signature }) }, 'auth'
        );
        if (!verifyResp.token) throw new Error('Auth verify missing token');

        this.authToken = verifyResp.token;
        this.authExpiresAt = verifyResp.expiresAt ? new Date(verifyResp.expiresAt).getTime() : Date.now() + 3600000;
        this.log('success', 'coordinator', 'Auth handshake complete');
    }

    async reAuth() {
        this.authToken = null;
        this.authExpiresAt = null;
        await this.ensureAuth();
    }

    // ─── Credit monitoring ──────────────────────────────

    startCreditMonitor() {
        const interval = parseInt(process.env.CREDIT_CHECK_INTERVAL_MS) || 300000;
        this.creditIntervalId = setInterval(async () => {
            if (!this.isRunning) return;
            try { await this.checkAndTopUpCredits(); } catch { }
        }, interval);
    }

    async checkAndTopUpCredits() {
        try {
            const res = await fetch('https://llm.bankr.bot/v1/credits', {
                headers: { 'X-API-Key': this._bankrApiKey }
            });
            if (!res.ok) return;
            const data = await res.json();
            const balance = data.balance ?? data.credits ?? null;
            if (balance !== null) {
                this.broadcast({ type: 'state', credits: { lastBalance: balance } });
                const minUsd = parseFloat(process.env.CREDIT_MIN_USD) || 2;
                if (balance < minUsd) {
                    const topupAmount = parseFloat(process.env.CREDIT_TOPUP_USD) || 5;
                    const token = process.env.CREDIT_TOPUP_TOKEN || 'USDC';
                    this.log('warn', 'credits', `Balance $${balance.toFixed(2)} < $${minUsd}. Topping up $${topupAmount} from ${token}...`);
                    const { jobId } = await this._fetchBankr('/agent/prompt', {
                        method: 'POST',
                        body: JSON.stringify({ prompt: `top up my LLM credits with $${topupAmount} from ${token}` })
                    });
                    await this._pollJob(jobId, 180000);
                    this.log('success', 'credits', `Top-up complete ($${topupAmount} from ${token})`);
                    await this._sleep(60000);
                }
            }
        } catch (e) {
            this.log('debug', 'credits', `Credit check failed: ${e.message}`);
        }
    }

    // ─── Auto-claim ─────────────────────────────────────

    startAutoClaimScheduler() {
        if (this.claimIntervalId) return;
        this.log('info', 'miner', `Auto-claim scheduler started (every ${AUTO_CLAIM_INTERVAL / 60000} min)`);
        this.claimIntervalId = setInterval(async () => {
            if (this.state === STATES.MINING) {
                try { await this.claimRewards(); } catch (e) {
                    this.log('debug', 'miner', `Auto-claim: ${e.message}`);
                }
            }
        }, AUTO_CLAIM_INTERVAL);
    }

    async claimRewards() {
        if (!this.walletAddress) return;
        try { await this.ensureAuth(); } catch { }

        const prevState = this.state;
        this.setState(STATES.CLAIMING);
        this.log('info', 'miner', 'Checking for claimable epochs...');

        try {
            const epoch = await coordinator.getEpoch();
            const epochsToClaim = [];
            if (epoch.prevEpochId && this.stats.epochsMined.includes(epoch.prevEpochId)) {
                epochsToClaim.push(epoch.prevEpochId);
            }
            for (const eid of this.stats.epochsMined) {
                if (eid < (epoch.epochId || 0) && !epochsToClaim.includes(eid)) {
                    epochsToClaim.push(eid);
                }
            }
            if (epochsToClaim.length === 0) {
                this.log('info', 'miner', 'No epochs to claim');
                this.setState(prevState);
                return;
            }

            // Check bonus
            for (const eid of epochsToClaim) {
                try {
                    const bonusStatus = await coordinator.getBonusStatus(eid);
                    if (bonusStatus.isBonusEpoch && bonusStatus.claimsOpen) {
                        this.log('info', 'miner', `Epoch ${eid} is bonus! Claiming bonus...`);
                        const bonusClaim = await coordinator.getBonusClaimCalldata(eid);
                        if (bonusClaim.transaction) {
                            await this.submitTransaction(bonusClaim.transaction, `Claim bonus for epoch ${eid}`);
                        }
                    }
                } catch { }
            }

            // Regular claim
            const claimData = await coordinator.getClaimCalldata(epochsToClaim);
            if (claimData.transaction) {
                const txResult = await this.submitTransaction(claimData.transaction, `Claim rewards for epoch(s) ${epochsToClaim.join(',')}`);
                if (txResult.success) {
                    this.log('success', 'miner', `💰 Rewards claimed! Tx: ${txResult.transactionHash}`);
                }
            }
        } catch (e) {
            if (e.message?.includes('NotFunded')) {
                this.log('info', 'miner', 'Epoch not funded yet, will retry later');
            } else if (e.message?.includes('AlreadyClaimed')) {
                this.log('info', 'miner', 'Already claimed, skipping');
            } else {
                this.log('warn', 'miner', `Claim failed: ${e.message}`);
            }
        } finally {
            this.setState(prevState);
        }
    }

    // ─── Mining ─────────────────────────────────────────

    async start(config = {}) {
        if (this.isRunning) {
            this.log('warn', 'miner', 'Already running');
            return;
        }

        this.shouldStop = false;
        this.isRunning = true;
        this.abortController = new AbortController();
        this.stats.startedAt = new Date().toISOString();
        this.stats.consecutiveFailures = 0;
        this.stats.challengesAttempted = 0;
        this.stats.challengesPassed = 0;
        this.stats.challengesFailed = 0;
        this.stats.creditsEarned = 0;
        this.stats.receiptsPosted = 0;

        this.log('info', 'miner', '⛏ BOTCOIN Miner starting...');
        this.broadcast({ type: 'state', ...this.getStatus() });

        try {
            // Phase 1: Wallet
            this.setState(STATES.CHECKING_WALLET);
            this.walletAddress = await this.getWalletAddress();
            this.log('success', 'miner', `Mining wallet: ${this.walletAddress}`);
            this.broadcast({ type: 'state', ...this.getStatus() });
            if (this.shouldStop) return this._cleanup('User stopped');

            // Phase 2: Balances (retry up to 3 times — Bankr can have transient errors)
            let balanceText = '';
            for (let balTry = 1; balTry <= 3; balTry++) {
                try {
                    balanceText = await this.getBalances();
                    break;
                } catch (e) {
                    this.log('warn', 'miner', `Balance check failed (attempt ${balTry}/3): ${e.message.slice(0, 150)}`);
                    if (balTry < 3) {
                        await this._sleep(5000);
                    } else {
                        this.log('warn', 'miner', 'Balance check failed 3 times. Proceeding with 0 balance assumption...');
                    }
                }
            }
            if (this.shouldStop) return this._cleanup('User stopped');
            if (balanceText) this.log('info', 'miner', `Balances: ${balanceText.slice(0, 300)}`);

            const botcoinMatch = balanceText.match(/botcoin[:\s]*([0-9,.]+)/i) || balanceText.match(/([0-9,.]+)\s*botcoin/i);
            const botcoinBalance = botcoinMatch ? parseFloat(botcoinMatch[1].replace(/,/g, '')) : 0;
            this.log('info', 'miner', `Estimated BOTCOIN: ${botcoinBalance.toLocaleString()}`);

            const ethUsdMatch = balanceText.match(/ETH.*?\$([0-9,.]+)/i);
            const ethUsd = ethUsdMatch ? parseFloat(ethUsdMatch[1].replace(/,/g, '')) : 0;

            // Phase 3: Auto-fund
            const stakeAmountWei = config.stakeAmount || '25000000000000000000000000';
            const requiredTokens = getTierTokens(stakeAmountWei);
            const tierInfo = TIER_MAP[stakeAmountWei];
            this.log('info', 'miner', `Selected stake: ${tierInfo ? tierInfo.label : requiredTokens.toLocaleString() + ' BOTCOIN'}`);

            if (botcoinBalance < requiredTokens && config.autoFund !== false) {
                if (ethUsd > 0 && ethUsd < 2) {
                    this.log('error', 'miner', `⚠ Not enough ETH ($${ethUsd.toFixed(2)}). Fund wallet: ${this.walletAddress}`);
                    this.setState(STATES.ERROR); this.isRunning = false; return;
                }

                this.setState(STATES.FUNDING);
                const buyAmount = requiredTokens - botcoinBalance + 100;
                this.log('warn', 'miner', `Buying ${buyAmount.toLocaleString()} BOTCOIN...`);

                let funded = false;
                for (let swapTry = 1; swapTry <= 3; swapTry++) {
                    try {
                        const swapResult = await this.swapForBotcoin(buyAmount);
                        if (this.shouldStop) return this._cleanup('User stopped');
                        const swapLower = (swapResult || '').toLowerCase();
                        if (swapLower.includes('insufficient') || swapLower.includes('failed')) {
                            throw new Error('Swap returned failure response');
                        }
                        funded = true;
                        break;
                    } catch (e) {
                        this.log('warn', 'miner', `Swap attempt ${swapTry}/3 failed: ${e.message.slice(0, 120)}`);
                        if (swapTry < 3) {
                            this.log('info', 'miner', `Retrying in 10s...`);
                            await this._sleep(10000);
                        }
                    }
                }
                if (!funded) {
                    this.log('error', 'miner', `Auto-fund failed after 3 attempts. Fund wallet manually with BOTCOIN or more ETH.`);
                    this.setState(STATES.ERROR); this.isRunning = false; return;
                }
            } else if (botcoinBalance < requiredTokens && config.autoFund === false) {
                // Auto-fund disabled but insufficient BOTCOIN — can't proceed
                this.log('error', 'miner', `⚠ Insufficient BOTCOIN: have ${botcoinBalance.toLocaleString()}, need ${requiredTokens.toLocaleString()} for ${tierInfo ? tierInfo.label : 'staking'}`);
                this.log('error', 'miner', `Enable "Auto-fund BOTCOIN" or manually buy BOTCOIN and stake at least ${requiredTokens.toLocaleString()} before mining.`);
                this.log('error', 'miner', `Wallet: ${this.walletAddress}`);
                this.setState(STATES.ERROR); this.isRunning = false; return;
            } else if (botcoinBalance >= requiredTokens) {
                this.log('success', 'miner', `BOTCOIN sufficient (${botcoinBalance.toLocaleString()}) ✔`);
            }

            if (this.shouldStop) return this._cleanup('User stopped');

            // Phase 4: Staking
            this.setState(STATES.STAKING);
            this.log('info', 'miner', `Staking ${requiredTokens.toLocaleString()} BOTCOIN...`);
            try {
                const approveResp = await coordinator.getStakeApproveCalldata(stakeAmountWei);
                if (approveResp.transaction) await this.submitTransaction(approveResp.transaction, 'Approve BOTCOIN');
                if (this.shouldStop) return this._cleanup('User stopped');
                const stakeResp = await coordinator.getStakeCalldata(stakeAmountWei);
                if (stakeResp.transaction) await this.submitTransaction(stakeResp.transaction, 'Stake BOTCOIN');
                this.log('success', 'miner', 'Staking confirmed');
            } catch (e) {
                if (e.message?.includes('already') || e.message?.includes('Already') || e.status === 400) {
                    this.log('info', 'miner', 'Stake already active, continuing...');
                } else {
                    this.log('warn', 'miner', `Staking error: ${e.message} — proceeding...`);
                }
            }

            if (this.shouldStop) return this._cleanup('User stopped');

            // Phase 5: Auth
            await this.ensureAuth();
            if (this.shouldStop) return this._cleanup('User stopped');

            // Phase 6: Background services
            this.startCreditMonitor();
            this.startAutoClaimScheduler();

            // Phase 7: Mining loop
            this.setState(STATES.MINING);
            this.log('success', 'miner', '⛏ Mining loop started!');
            this.broadcast({ type: 'state', ...this.getStatus() });

            while (!this.shouldStop) {
                try {
                    await this._mineOnce();
                } catch (e) {
                    const classified = classify(e);
                    if (classified instanceof AuthError) {
                        this.log('info', 'miner', 'Auth expired, re-authenticating...');
                        try { await this.reAuth(); } catch { }; continue;
                    }
                    if (classified instanceof CreditError) {
                        this.log('error', 'miner', 'LLM credits exhausted! Topping up...');
                        try { await this.checkAndTopUpCredits(); } catch { }
                        await this._sleep(30000); continue;
                    }
                    if (classified instanceof FatalError) {
                        this.log('error', 'miner', `Fatal: ${classified.message}`);
                        this.setState(STATES.ERROR); break;
                    }
                    if (classified instanceof RetryableError) {
                        this.stats.consecutiveFailures++;
                        const wait = classified.retryAfterMs || Math.min(this.stats.consecutiveFailures * 5000, 30000);
                        this.log('warn', 'miner', `Retryable (${this.stats.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
                        await this._sleep(wait);
                    } else {
                        this.stats.consecutiveFailures++;
                        this.log('error', 'miner', `Error (${this.stats.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
                        await this._sleep(Math.min(this.stats.consecutiveFailures * 5000, 30000));
                    }
                    if (this.stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        this.log('error', 'miner', `${MAX_CONSECUTIVE_FAILURES} failures — paused. Try different model.`);
                        this.setState(STATES.PAUSED); break;
                    }
                }
            }
        } catch (e) {
            this.log('error', 'miner', `Fatal: ${e.message}`);
            this.setState(STATES.ERROR);
        } finally {
            this._cleanup();
        }
    }

    async _mineOnce() {
        await this.ensureAuth();
        const nonce = crypto.randomBytes(16).toString('hex');
        const challenge = await coordinator.getChallenge(this.walletAddress, nonce, this.authToken);
        this.stats.challengesAttempted++;

        if (challenge.epochId) {
            this.stats.currentEpoch = challenge.epochId;
            if (!this.stats.epochsMined.includes(challenge.epochId))
                this.stats.epochsMined.push(challenge.epochId);
        }

        this.log('info', 'miner', `Challenge: ${challenge.challengeId?.slice(0, 8)}... (epoch ${challenge.epochId}, ${challenge.creditsPerSolve} credits/solve)`);

        // Solve with pipeline (using this session's LLM)
        const artifact = await this._solvePipeline(challenge);

        // Submit
        const result = await coordinator.submitSolution(this.walletAddress, challenge.challengeId, artifact, nonce, this.authToken);

        if (result.pass) {
            const cpss = challenge.creditsPerSolve || 1;
            this.stats.challengesPassed++;
            this.stats.creditsEarned += cpss;
            this.stats.lifetimePassed++;
            this.stats.lifetimeCredits += cpss;
            this.stats.consecutiveFailures = 0;
            this.stats.lastSolveAt = new Date().toISOString();
            this.log('success', 'miner', `✔ PASSED! +${cpss} credits (total: ${this.stats.creditsEarned})`);

            if (result.transaction) {
                const txResult = await this.submitTransaction(result.transaction, 'Post mining receipt');
                if (txResult.success) this.stats.receiptsPosted++;
            }
        } else {
            this.stats.challengesFailed++;
            this.stats.lifetimeFailed++;
            this.stats.consecutiveFailures++;
            const indices = result.failedConstraintIndices || [];
            this.log('warn', 'miner', `✖ FAILED constraints: [${indices.join(',')}]`);
        }

        this.broadcast({ type: 'state', ...this.getStatus() });
        await this._sleep(2000);
    }

    async _solvePipeline(challenge) {
        const prompts = require('./solver/prompts');
        const validator = require('./solver/validator');

        // Stage 1: Extract
        this.broadcast({ type: 'pipeline', stage: 1, detail: 'Extracting data' });
        this.log('info', 'solver', '📋 Stage 1/4: Extract + Answer...');
        const extractPrompt = prompts.extractionPrompt(challenge.doc, challenge.companies, challenge.questions);
        const { content: extractRaw } = await this.callLLM(extractPrompt, this._primaryModel, { json: true, maxTokens: 8192 });
        let extracted = this._parseJSON(extractRaw);
        if (!extracted || !extracted.answers) {
            extracted = { answers: challenge.questions.map((_, i) => ({ question: i + 1, answer: 'unknown' })) };
        }
        this.log('success', 'solver', `Stage 1: ${extracted.answers.length} answers`);

        // Stage 2: Verify (optional — only when dual-model verification is enabled)
        if (this._verifyEnabled) {
            this.broadcast({ type: 'pipeline', stage: 2, detail: 'Verifying answers' });
            this.log('info', 'solver', '🔍 Stage 2/4: Verify...');
            const verifyPrompt = prompts.verificationPrompt(challenge.doc, challenge.companies, challenge.questions, extracted);
            const { content: verifyRaw } = await this.callLLM(verifyPrompt, this._verifyModel || this._primaryModel, { json: true });
            const verified = this._parseJSON(verifyRaw);
            if (verified?.answers) {
                let corrections = 0;
                for (const v of verified.answers) {
                    const orig = extracted.answers.find(a => a.question === v.question);
                    if (orig && v.answer !== orig.answer) { orig.answer = v.answer; corrections++; }
                }
                this.log('success', 'solver', `Stage 2: ${corrections} correction(s)`);
            }
        } else {
            this.log('info', 'solver', '⏩ Stage 2: Skipped (dual-model verification disabled)');
        }

        // Stage 3: Parse constraints
        this.broadcast({ type: 'pipeline', stage: 3, detail: 'Parsing constraints' });
        this.log('info', 'solver', '🧩 Stage 3/4: Parse constraints...');
        const constraintPrompt = prompts.constraintParsingPrompt(challenge.constraints);
        const { content: constraintRaw } = await this.callLLM(constraintPrompt, this._primaryModel, { json: true });
        const parsedConstraints = this._parseJSON(constraintRaw)?.parsed || null;
        if (parsedConstraints) this.log('success', 'solver', `Stage 3: ${parsedConstraints.length} constraints parsed`);

        // Stage 4: Build artifact
        this.broadcast({ type: 'pipeline', stage: 4, detail: 'Building artifact' });
        this.log('info', 'solver', '🔨 Stage 4/4: Build artifact...');
        let lastArtifact = null, lastErrors = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const buildPrompt = prompts.artifactBuildPrompt(
                challenge.questions, extracted.answers, challenge.constraints,
                parsedConstraints, challenge.solveInstructions,
                lastArtifact, lastErrors, challenge.proposal
            );
            const { content } = await this.callLLM(buildPrompt, this._primaryModel, { temperature: 0.15 });
            let artifact = challenge.proposal ? content : (content.split('\n').filter(l => l.trim())[0] || content);

            if (parsedConstraints) {
                const result = validator.validate(artifact, parsedConstraints);
                if (result.valid) {
                    this.log('success', 'solver', `Artifact built (attempt ${attempt}) ✔`);
                    this.broadcast({ type: 'pipeline', stage: null, detail: 'Complete' });
                    return artifact;
                }
                lastArtifact = artifact;
                lastErrors = result.errors;
                if (attempt < 3) this.log('warn', 'solver', `Attempt ${attempt} failed: ${result.errors.join('; ')}`);
            } else {
                this.broadcast({ type: 'pipeline', stage: null, detail: 'Complete' });
                return artifact;
            }
        }
        this.broadcast({ type: 'pipeline', stage: null, detail: 'Best effort' });
        return lastArtifact || '';
    }

    _parseJSON(text) {
        try { return JSON.parse(text); } catch { }
        const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) { try { return JSON.parse(match[1].trim()); } catch { } }
        const start = text.indexOf('{'), end = text.lastIndexOf('}');
        if (start !== -1 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { } }
        return null;
    }

    stop() {
        this.log('info', 'miner', 'Stopping...');
        this.shouldStop = true;
        try { this.abortController.abort(); } catch { }
    }

    _cleanup(reason) {
        if (reason) this.log('info', 'miner', `Stopped: ${reason}`);
        this.isRunning = false;
        this.shouldStop = false;
        if (this.claimIntervalId) { clearInterval(this.claimIntervalId); this.claimIntervalId = null; }
        if (this.creditIntervalId) { clearInterval(this.creditIntervalId); this.creditIntervalId = null; }
        this.setState(STATES.IDLE);
        this.broadcast({ type: 'state', ...this.getStatus() });
    }

    destroy() {
        this.stop();
        this._cleanup('Session expired');
        this.sseClients.forEach(res => { try { res.end(); } catch { } });
        this.sseClients = [];
    }
}

// ─── Session Store ──────────────────────────────────────

class SessionManager {
    constructor() {
        this.sessions = new Map();

        // Cleanup expired sessions periodically
        setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
    }

    create(apiKey) {
        const sessionId = crypto.randomBytes(16).toString('hex');
        const session = new MinerSession(sessionId, apiKey);
        this.sessions.set(sessionId, session);
        log.info('sessions', `New session ${sessionId.slice(0, 8)}... (${this.sessions.size} active)`);
        return session;
    }

    get(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) session.touch();
        return session;
    }

    remove(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.destroy();
            this.sessions.delete(sessionId);
            log.info('sessions', `Session ${sessionId.slice(0, 8)}... removed (${this.sessions.size} active)`);
        }
    }

    getActiveCount() { return this.sessions.size; }

    getRunningCount() {
        let count = 0;
        for (const s of this.sessions.values()) if (s.isRunning) count++;
        return count;
    }

    _cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (now - session.lastActivity > SESSION_TTL_MS && !session.isRunning) {
                log.info('sessions', `Expiring idle session ${id.slice(0, 8)}...`);
                this.remove(id);
            }
        }
    }
}

module.exports = { SessionManager, MinerSession };
