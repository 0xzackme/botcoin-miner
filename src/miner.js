// ─── Miner Orchestrator ─────────────────────────────────
// State machine that runs the complete mining lifecycle:
// IDLE → CHECKING_WALLET → FUNDING → STAKING → AUTHENTICATING → MINING → CLAIMING
// Features: auto-claim scheduler, persistent stats, graceful shutdown.

const { v4: uuidv4 } = require('uuid');
const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const bankr = require('./bankr');
const coordinator = require('./coordinator');
const solver = require('./solver/pipeline');
const credits = require('./credits');
const { classify, FatalError, AuthError, CreditError, RetryableError, SolveError } = require('./errors');

// ─── State ──────────────────────────────────────────────

const STATES = {
    IDLE: 'IDLE',
    CHECKING_WALLET: 'CHECKING_WALLET',
    FUNDING: 'FUNDING',
    STAKING: 'STAKING',
    AUTHENTICATING: 'AUTHENTICATING',
    MINING: 'MINING',
    CLAIMING: 'CLAIMING',
    PAUSED: 'PAUSED',
    ERROR: 'ERROR'
};

let state = STATES.IDLE;
let walletAddress = null;
let authToken = null;
let authExpiresAt = null;
let shouldStop = false;
let isRunning = false;
let claimIntervalId = null;

// Stats
const STATS_FILE = path.join(__dirname, '..', 'data', 'stats.json');
let currentConfig = {};

let stats = {
    challengesAttempted: 0,
    challengesPassed: 0,
    challengesFailed: 0,
    creditsEarned: 0,
    receiptsPosted: 0,
    currentEpoch: null,
    epochsMined: [],
    consecutiveFailures: 0,
    startedAt: null,
    lastSolveAt: null,
    totalSessionMs: 0,
    lifetimePassed: 0,
    lifetimeFailed: 0,
    lifetimeCredits: 0
};

const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 5;
const AUTO_CLAIM_INTERVAL = 30 * 60 * 1000; // 30 minutes

// Convert stake amount (wei) to whole BOTCOIN tokens
const TIER_MAP = {
    '25000000000000000000000000': { tokens: 25000000, label: 'Tier 1 (25M)' },
    '50000000000000000000000000': { tokens: 50000000, label: 'Tier 2 (50M)' },
    '100000000000000000000000000': { tokens: 100000000, label: 'Tier 3 (100M)' }
};

function getTierTokens(stakeAmountWei) {
    const tier = TIER_MAP[stakeAmountWei];
    if (tier) return tier.tokens;
    // Fallback: parse wei to tokens (18 decimals)
    try {
        const tokens = parseInt(stakeAmountWei) / 1e18;
        return tokens > 0 ? tokens : 25000000;
    } catch {
        return 25000000;
    }
}

// ─── Persistent stats ───────────────────────────────────

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
            stats.lifetimePassed = saved.lifetimePassed || 0;
            stats.lifetimeFailed = saved.lifetimeFailed || 0;
            stats.lifetimeCredits = saved.lifetimeCredits || 0;
            stats.epochsMined = saved.epochsMined || [];
            log.info('miner', `Loaded stats: ${stats.lifetimePassed} lifetime solves, ${stats.lifetimeCredits} lifetime credits`);
        }
    } catch (e) {
        log.debug('miner', `No saved stats to load: ${e.message}`);
    }
}

function saveStats() {
    try {
        const dir = path.dirname(STATS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const toSave = {
            lifetimePassed: stats.lifetimePassed,
            lifetimeFailed: stats.lifetimeFailed,
            lifetimeCredits: stats.lifetimeCredits,
            epochsMined: stats.epochsMined,
            lastSolveAt: stats.lastSolveAt,
            savedAt: new Date().toISOString()
        };
        fs.writeFileSync(STATS_FILE, JSON.stringify(toSave, null, 2));
    } catch (e) {
        log.debug('miner', `Failed to save stats: ${e.message}`);
    }
}

// ─── State transitions ─────────────────────────────────

function setState(newState) {
    const prev = state;
    state = newState;
    log.info('miner', `State: ${prev} → ${newState}`);
}

function getState() {
    return {
        state,
        walletAddress,
        stats: { ...stats },
        isRunning,
        authActive: !!authToken,
        pipeline: solver.getStage(),
        credits: credits.getStatus()
    };
}

// ─── Generate unique nonce ──────────────────────────────

function generateNonce() {
    return randomBytes(16).toString('hex');
}

// ─── Auth management ────────────────────────────────────

async function ensureAuth() {
    // Re-auth if no token or near expiry
    if (authToken && authExpiresAt) {
        const remaining = new Date(authExpiresAt).getTime() - Date.now();
        if (remaining > 60000) return; // still valid
    }
    if (authToken && !authExpiresAt) return; // no expiry info, assume valid

    setState(STATES.AUTHENTICATING);
    try {
        const result = await coordinator.authHandshake(walletAddress);
        authToken = result.token;
        authExpiresAt = result.expiresAt;
    } catch (e) {
        if (e.status === 403) {
            log.error('miner', 'Auth failed: insufficient BOTCOIN balance. Stake more tokens.');
            throw e;
        }
        throw e;
    }
}

async function reAuth() {
    authToken = null;
    authExpiresAt = null;
    await ensureAuth();
}

// ─── Auto-claim scheduler ───────────────────────────────

function startAutoClaimScheduler() {
    if (claimIntervalId) return;
    log.info('miner', `Auto-claim scheduler started (every ${AUTO_CLAIM_INTERVAL / 60000} min)`);
    claimIntervalId = setInterval(async () => {
        if (state === STATES.MINING) {
            try {
                await claimRewards();
            } catch (e) {
                log.debug('miner', `Auto-claim attempt: ${e.message}`);
            }
        }
    }, AUTO_CLAIM_INTERVAL);
}

function stopAutoClaimScheduler() {
    if (claimIntervalId) {
        clearInterval(claimIntervalId);
        claimIntervalId = null;
    }
}

// ─── Main mining loop ───────────────────────────────────

async function start(config = {}) {
    if (isRunning) {
        log.warn('miner', 'Already running');
        return;
    }

    shouldStop = false;
    isRunning = true;
    currentConfig = config;
    stats.startedAt = new Date().toISOString();
    stats.consecutiveFailures = 0;
    stats.challengesAttempted = 0;
    stats.challengesPassed = 0;
    stats.challengesFailed = 0;
    stats.creditsEarned = 0;
    stats.receiptsPosted = 0;
    bankr.resetAbort();
    loadStats();

    log.info('miner', '⛏ BOTCOIN Miner starting...');

    try {
        // Phase 1: Wallet check
        setState(STATES.CHECKING_WALLET);
        walletAddress = await bankr.getWalletAddress();
        log.success('miner', `Mining wallet: ${walletAddress}`);

        if (shouldStop) return cleanup('User stopped');

        // Phase 2: Check balances
        const balanceText = await bankr.getBalances();
        if (shouldStop) return cleanup('User stopped');

        log.info('miner', `Balances: ${balanceText.slice(0, 300)}`);

        // Parse BOTCOIN balance roughly
        const botcoinMatch = balanceText.match(/botcoin[:\s]*([0-9,.]+)/i) ||
            balanceText.match(/([0-9,.]+)\s*botcoin/i);
        const botcoinBalance = botcoinMatch
            ? parseFloat(botcoinMatch[1].replace(/,/g, ''))
            : 0;

        log.info('miner', `Estimated BOTCOIN balance: ${botcoinBalance.toLocaleString()}`);

        // Parse ETH balance
        const ethMatch = balanceText.match(/ETH[:\s]*([0-9.]+)/i) ||
            balanceText.match(/([0-9.]+)\s*ETH/i);
        const ethBalance = ethMatch ? parseFloat(ethMatch[1]) : 0;
        const ethUsdMatch = balanceText.match(/ETH.*?\$([0-9,.]+)/i);
        const ethUsd = ethUsdMatch ? parseFloat(ethUsdMatch[1].replace(/,/g, '')) : 0;

        // Phase 3: Auto-fund if needed
        // Use user-selected tier to determine required BOTCOIN
        const stakeAmountWei = config.stakeAmount || '25000000000000000000000000';
        const requiredTokens = getTierTokens(stakeAmountWei);
        const tierInfo = TIER_MAP[stakeAmountWei];
        log.info('miner', `Selected stake: ${tierInfo ? tierInfo.label : requiredTokens.toLocaleString() + ' BOTCOIN'}`);

        if (botcoinBalance < requiredTokens && config.autoFund !== false) {
            // Pre-check: is there enough ETH to even attempt a swap?
            if (ethUsd > 0 && ethUsd < 2) {
                log.error('miner', `⚠ Not enough ETH to buy BOTCOIN. Have $${ethUsd.toFixed(2)} in ETH but need gas + swap value.`);
                log.error('miner', '⚠ Fund your Bankr wallet with more ETH on Base, then restart.');
                log.error('miner', `Wallet: ${walletAddress}`);
                setState(STATES.ERROR);
                isRunning = false;
                return;
            }
            setState(STATES.FUNDING);
            const needed = requiredTokens - botcoinBalance;
            const buyAmount = needed + 100; // small buffer
            log.warn('miner', `BOTCOIN balance (${botcoinBalance.toLocaleString()}) below ${requiredTokens.toLocaleString()} required. Buying ${buyAmount.toLocaleString()} BOTCOIN...`);

            try {
                const swapResult = await bankr.swapForBotcoin(buyAmount);
                if (shouldStop) return cleanup('User stopped');

                const swapLower = (swapResult || '').toLowerCase();
                if (swapLower.includes('insufficient') || swapLower.includes('not enough') || swapLower.includes('failed')) {
                    log.error('miner', `Swap failed: ${swapResult.slice(0, 200)}`);
                    log.error('miner', '⚠ Fund your Bankr wallet with more ETH on Base, then restart.');
                    setState(STATES.ERROR);
                    isRunning = false;
                    return;
                }
                log.success('miner', 'BOTCOIN purchase complete. Re-checking balance...');

                const newBalanceText = await bankr.getBalances();
                const newMatch = newBalanceText.match(/botcoin[:\s]*([0-9,.]+)/i) ||
                    newBalanceText.match(/([0-9,.]+)\s*botcoin/i);
                const newBalance = newMatch ? parseFloat(newMatch[1].replace(/,/g, '')) : 0;
                log.info('miner', `New BOTCOIN balance: ${newBalance.toLocaleString()}`);

                if (newBalance < requiredTokens) {
                    log.error('miner', `⚠ Still below ${requiredTokens.toLocaleString()} (have ${newBalance.toLocaleString()}). Need more ETH to buy BOTCOIN.`);
                    setState(STATES.ERROR);
                    isRunning = false;
                    return;
                }
            } catch (e) {
                if (e.status === 403) {
                    log.error('miner', '⚠ Your Bankr API key is read-only. Enable write access at https://bankr.bot/api');
                    setState(STATES.ERROR);
                    isRunning = false;
                    return;
                }
                log.error('miner', `Auto-fund failed: ${e.message}. Please buy BOTCOIN manually.`);
                setState(STATES.ERROR);
                isRunning = false;
                return;
            }
        } else if (botcoinBalance >= requiredTokens) {
            log.success('miner', `BOTCOIN balance (${botcoinBalance.toLocaleString()}) sufficient for ${requiredTokens.toLocaleString()} stake ✔`);
        }

        if (shouldStop) return cleanup('User stopped');

        // Phase 4: Staking
        setState(STATES.STAKING);
        log.info('miner', `Setting up staking (${requiredTokens.toLocaleString()} BOTCOIN)...`);
        try {
            // Approve
            const approveResp = await coordinator.getStakeApproveCalldata(stakeAmountWei);
            if (shouldStop) return cleanup('User stopped');

            if (approveResp.transaction) {
                await bankr.submitTransaction(approveResp.transaction, 'Approve BOTCOIN for staking');
            }
            if (shouldStop) return cleanup('User stopped');

            // Stake
            const stakeResp = await coordinator.getStakeCalldata(stakeAmountWei);
            if (shouldStop) return cleanup('User stopped');

            if (stakeResp.transaction) {
                await bankr.submitTransaction(stakeResp.transaction, 'Stake BOTCOIN for mining');
            }
            log.success('miner', 'Staking confirmed');
        } catch (e) {
            if (e.status === 403 && (e.message?.includes('Read-only') || e.message?.includes('read-only'))) {
                log.error('miner', '⚠ Your Bankr API key is read-only. Disable read-only mode at https://bankr.bot/api');
                setState(STATES.ERROR);
                isRunning = false;
                return;
            }
            // Staking might already be active
            if (e.message?.includes('already') || e.message?.includes('Already') || e.status === 400) {
                log.info('miner', 'Stake already active, continuing...');
            } else {
                log.warn('miner', `Staking error: ${e.message} — attempting to proceed...`);
            }
        }

        if (shouldStop) return cleanup('User stopped');

        // Phase 5: Auth handshake
        try {
            await ensureAuth();
        } catch (e) {
            if (e.status === 403) {
                const msg = e.message?.includes('Read-only') || e.message?.includes('read-only')
                    ? '⚠ Your Bankr API key is read-only. Disable read-only mode at https://bankr.bot/api'
                    : '⚠ Auth failed (403). You may need more BOTCOIN staked, or fix API key permissions at https://bankr.bot/api';
                log.error('miner', msg);
                setState(STATES.ERROR);
                isRunning = false;
                return;
            }
            throw e;
        }

        if (shouldStop) return cleanup('User stopped');

        // Phase 6: Start background services
        credits.start();
        startAutoClaimScheduler();

        // Phase 7: Mining loop
        setState(STATES.MINING);
        log.success('miner', '⛏ Mining loop started!');

        while (!shouldStop) {
            try {
                await mineOnce();
                // consecutiveFailures is reset inside mineOnce on PASS
            } catch (e) {
                const classified = classify(e);

                if (classified instanceof AuthError) {
                    log.info('miner', 'Auth expired, re-authenticating...');
                    try { await reAuth(); } catch { }
                    continue;
                }

                if (classified instanceof CreditError) {
                    log.error('miner', 'LLM credits exhausted! Triggering top-up...');
                    try { await credits.checkAndTopUp(); } catch { }
                    await bankr.sleep(30000);
                    continue;
                }

                if (classified instanceof FatalError) {
                    log.error('miner', `Fatal error: ${classified.message}`);
                    setState(STATES.ERROR);
                    break;
                }

                if (classified instanceof RetryableError) {
                    stats.consecutiveFailures++;
                    const wait = classified.retryAfterMs || Math.min(stats.consecutiveFailures * 5000, 30000);
                    log.warn('miner', `Retryable error (${stats.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}. Waiting ${Math.round(wait / 1000)}s...`);
                    await bankr.sleep(wait);
                } else {
                    stats.consecutiveFailures++;
                    log.error('miner', `Mining error (${stats.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
                    const backoff = Math.min(stats.consecutiveFailures * 5000, 30000);
                    await bankr.sleep(backoff);
                }

                if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    log.error('miner', `${MAX_CONSECUTIVE_FAILURES} consecutive failures — pausing. Consider changing model or checking configuration.`);
                    setState(STATES.PAUSED);
                    break;
                }
            }
        }

    } catch (e) {
        log.error('miner', `Fatal error: ${e.message}`);
        setState(STATES.ERROR);
    } finally {
        cleanup();
    }
}

// ─── Single mining cycle ────────────────────────────────

async function mineOnce() {
    // Ensure auth is fresh
    await ensureAuth();

    // Step A: Request challenge
    const nonce = generateNonce();
    const challenge = await coordinator.getChallenge(walletAddress, nonce, authToken);
    stats.challengesAttempted++;

    if (challenge.epochId) {
        stats.currentEpoch = challenge.epochId;
        if (!stats.epochsMined.includes(challenge.epochId)) {
            stats.epochsMined.push(challenge.epochId);
        }
    }

    // Step B: Solve challenge (multi-stage pipeline)
    const artifact = await solver.solve(challenge);

    // Step C: Submit solution
    const result = await coordinator.submitSolution(
        walletAddress, challenge.challengeId, artifact, nonce, authToken
    );

    if (result.pass) {
        const cpss = challenge.creditsPerSolve || 1;
        stats.challengesPassed++;
        stats.creditsEarned += cpss;
        stats.lifetimePassed++;
        stats.lifetimeCredits += cpss;
        stats.consecutiveFailures = 0; // Reset on PASS only
        stats.lastSolveAt = new Date().toISOString();
        log.success('miner', `✔ Challenge PASSED! +${cpss} credits (session: ${stats.creditsEarned}, lifetime: ${stats.lifetimeCredits})`);

        // Step D: Post receipt on-chain
        if (result.transaction) {
            const txResult = await bankr.submitTransaction(result.transaction, 'Post BOTCOIN mining receipt');
            if (txResult.success) {
                stats.receiptsPosted++;
                log.success('miner', `Receipt posted: ${txResult.transactionHash}`);
            }
        }

        // Save stats periodically
        if (stats.challengesPassed % 5 === 0) saveStats();
    } else {
        stats.challengesFailed++;
        stats.lifetimeFailed++;
        stats.consecutiveFailures++;
        const failed = result.failedConstraintIndices || [];
        log.warn('miner', `✖ Challenge FAILED — ${failed.length} constraint(s) violated: [${failed.join(', ')}]`);
    }

    // Small delay between cycles
    await bankr.sleep(2000);
}

// ─── Test solve (dry run) ───────────────────────────────

async function testSolve() {
    if (!walletAddress) {
        walletAddress = await bankr.getWalletAddress();
    }

    // Ensure auth
    if (!authToken) {
        const result = await coordinator.authHandshake(walletAddress);
        authToken = result.token;
        authExpiresAt = result.expiresAt;
    }

    log.info('miner', '🧪 Test solve: fetching challenge...');
    const nonce = generateNonce();
    const challenge = await coordinator.getChallenge(walletAddress, nonce, authToken);
    log.info('miner', `Challenge: ${challenge.challengeId?.slice(0, 8)}... (epoch ${challenge.epochId})`);

    const artifact = await solver.solve(challenge);
    log.info('miner', `Test artifact: ${artifact.slice(0, 150)}...`);

    return {
        challengeId: challenge.challengeId,
        epochId: challenge.epochId,
        artifact: artifact.slice(0, 500),
        creditsPerSolve: challenge.creditsPerSolve
    };
}

// ─── Stop mining ────────────────────────────────────────

function stop(reason = 'User requested stop') {
    shouldStop = true;
    bankr.abort();
    log.info('miner', `Stopping: ${reason}`);
    if (!isRunning) setState(STATES.IDLE);
}

function cleanup(reason) {
    credits.stop();
    stopAutoClaimScheduler();
    saveStats();
    isRunning = false;
    if (state !== STATES.ERROR && state !== STATES.PAUSED) {
        setState(STATES.IDLE);
    }
    log.info('miner', reason || 'Miner stopped');
}

// ─── Claim rewards ──────────────────────────────────────

async function claimRewards() {
    if (!walletAddress) {
        log.error('miner', 'No wallet address — run miner first');
        return;
    }

    // Ensure auth token is fresh before claiming
    try {
        await ensureAuth();
    } catch (e) {
        log.warn('miner', `Auth refresh for claim failed: ${e.message}`);
    }

    const prevState = state;
    setState(STATES.CLAIMING);
    log.info('miner', 'Checking for claimable epochs...');

    try {
        const epoch = await coordinator.getEpoch();
        log.info('miner', `Current epoch: ${epoch.epochId}, prev: ${epoch.prevEpochId}`);

        const claimable = [...new Set([
            ...(epoch.prevEpochId ? [epoch.prevEpochId] : []),
            ...stats.epochsMined.filter(e => e < epoch.epochId)
        ])];

        if (claimable.length === 0) {
            log.info('miner', 'No claimable epochs found');
            setState(isRunning ? STATES.MINING : STATES.IDLE);
            return;
        }

        log.info('miner', `Attempting to claim epochs: [${claimable.join(', ')}]`);

        // Check for bonus epochs
        for (const ep of claimable) {
            try {
                const bonus = await coordinator.getBonusStatus(ep);
                if (bonus.isBonusEpoch && bonus.claimsOpen) {
                    log.info('miner', `Epoch ${ep} is a bonus epoch! Claiming bonus...`);
                    const bonusTx = await coordinator.getBonusClaimCalldata(ep);
                    if (bonusTx.transaction) {
                        await bankr.submitTransaction(bonusTx.transaction, `Claim bonus for epoch ${ep}`);
                    }
                }
            } catch { /* bonus check failure is non-fatal */ }
        }

        // Regular claim
        const claimResp = await coordinator.getClaimCalldata(claimable);
        if (claimResp.transaction) {
            const result = await bankr.submitTransaction(claimResp.transaction, `Claim rewards for epochs [${claimable.join(', ')}]`);
            if (result.success) {
                log.success('miner', `💰 Rewards claimed! Tx: ${result.transactionHash}`);
            }
        }
    } catch (e) {
        if (e.message?.includes('NotFunded') || e.message?.includes('0x3eb21795')) {
            log.info('miner', 'Epoch not funded yet — will retry later');
        } else if (e.message?.includes('AlreadyClaimed')) {
            log.info('miner', 'Already claimed');
        } else {
            log.error('miner', `Claim error: ${e.message}`);
        }
    } finally {
        setState(isRunning ? STATES.MINING : STATES.IDLE);
    }
}

// ─── Get info ───────────────────────────────────────────

async function getCreditsInfo() {
    if (!walletAddress) return null;
    try {
        return await coordinator.getCredits(walletAddress);
    } catch {
        return null;
    }
}

async function getEpochInfo() {
    try {
        return await coordinator.getEpoch();
    } catch {
        return null;
    }
}

// ─── Graceful shutdown ──────────────────────────────────

function setupGracefulShutdown() {
    const handler = (signal) => {
        log.info('miner', `Received ${signal}, shutting down gracefully...`);
        stop(`${signal} received`);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
}

setupGracefulShutdown();

module.exports = {
    start,
    stop,
    testSolve,
    claimRewards,
    getState,
    getCreditsInfo,
    getEpochInfo,
    STATES
};
