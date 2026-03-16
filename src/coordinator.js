// ─── Coordinator API Client ─────────────────────────────
// Wraps the BOTCOIN mining coordinator (coordinator.agentmoney.net).
// Handles: challenges, submissions, staking, claims, auth, epochs.

const log = require('./logger');
const bankr = require('./bankr');

const DEFAULT_URL = 'https://coordinator.agentmoney.net';
let baseUrl = DEFAULT_URL;

function init(url) { baseUrl = url || DEFAULT_URL; }

// ─── Retry helper ───────────────────────────────────────

const BACKOFF = [2000, 4000, 8000, 16000, 30000, 60000];
const MAX_WAIT_MS = 120000; // never wait more than 2 minutes

// Timeout per endpoint type (ms)
const TIMEOUTS = {
    auth: 15000,
    challenge: 45000,
    submit: 45000,
    stake: 30000,
    unstake: 30000,
    claim: 30000,
    bonus: 30000,
    epoch: 15000,
    credits: 15000,
    token: 15000,
    coordinator: 30000  // default
};

async function retryFetch(url, opts = {}, label = 'coordinator') {
    const timeoutMs = TIMEOUTS[label] || TIMEOUTS.coordinator;

    for (let i = 0; i <= BACKOFF.length; i++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const fetchOpts = { ...opts, signal: controller.signal };
            const res = await fetch(url, fetchOpts);
            clearTimeout(timer);
            const text = await res.text();
            let body;
            try { body = JSON.parse(text); } catch { body = { raw: text }; }

            if (res.ok) return body;

            // 403: permission / balance issue — stop immediately, no retry
            if (res.status === 403) {
                const msg = body.message || body.error || text.slice(0, 300);
                const err = new Error(`403 Forbidden: ${msg}`);
                err.status = 403;
                err.body = body;
                throw err;
            }

            if (res.status === 429 || res.status >= 500) {
                if (i >= BACKOFF.length) {
                    const err = new Error(`HTTP ${res.status} after max retries: ${text.slice(0, 300)}`);
                    err.status = res.status;
                    throw err;
                }
                let wait = BACKOFF[i] || 60000;
                if (body.retryAfterSeconds) {
                    wait = Math.max(body.retryAfterSeconds * 1000, wait);
                }
                wait = Math.min(wait, MAX_WAIT_MS); // cap at 2 minutes
                const jitter = Math.random() * wait * 0.25;
                const totalWait = wait + jitter;
                log.warn(label, `${res.status} on ${url.split('?')[0]} — retrying in ${Math.round(totalWait / 1000)}s`);
                await bankr.sleep(totalWait);
                continue;
            }

            const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
            err.status = res.status;
            err.body = body;
            throw err;
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                if (i < BACKOFF.length) {
                    const wait = Math.min(BACKOFF[i], MAX_WAIT_MS);
                    log.warn(label, `Request timeout (${timeoutMs / 1000}s) on ${url.split('?')[0]} — retrying in ${Math.round(wait / 1000)}s`);
                    await bankr.sleep(wait);
                    continue;
                }
                throw new Error(`Request timeout after ${BACKOFF.length + 1} attempts on ${url.split('?')[0]}`);
            }
            if (e.status) throw e; // HTTP error already structured
            if (i < BACKOFF.length) {
                const wait = Math.min(BACKOFF[i] + Math.random() * BACKOFF[i] * 0.25, MAX_WAIT_MS);
                log.warn(label, `Network error: ${e.message} — retrying in ${Math.round(wait / 1000)}s`);
                await bankr.sleep(wait);
                continue;
            }
            throw e;
        }
    }
}

function authHeader(token) {
    if (!token) return {};
    return { 'Authorization': `Bearer ${token}` };
}

// ─── Auth Handshake ─────────────────────────────────────

async function authHandshake(minerAddress) {
    log.info('coordinator', 'Starting auth handshake...');

    // Step 1: Get nonce
    const nonceResp = await retryFetch(`${baseUrl}/v1/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ miner: minerAddress })
    }, 'auth');

    const message = nonceResp.message;
    if (!message) throw new Error('Auth nonce response missing "message" field');

    // Step 2: Sign via Bankr
    const signature = await bankr.signMessage(message);
    if (!signature) throw new Error('Bankr sign response missing "signature"');

    // Step 3: Verify
    const verifyResp = await retryFetch(`${baseUrl}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ miner: minerAddress, message, signature })
    }, 'auth');

    const token = verifyResp.token;
    if (!token) throw new Error('Auth verify response missing "token"');

    log.success('coordinator', 'Auth handshake complete');
    return { token, expiresAt: verifyResp.expiresAt || null };
}

// ─── Challenge ──────────────────────────────────────────

async function getChallenge(minerAddress, nonce, token) {
    log.info('coordinator', `Requesting challenge (nonce: ${nonce.slice(0, 8)}...)...`);
    const url = `${baseUrl}/v1/challenge?miner=${minerAddress}&nonce=${nonce}`;
    const data = await retryFetch(url, {
        headers: { ...authHeader(token) }
    }, 'challenge');
    log.success('coordinator', `Challenge received: ${data.challengeId?.slice(0, 8)}... (epoch ${data.epochId}, ${data.creditsPerSolve} credits/solve)`);
    return data;
}

// ─── Submit Solution ────────────────────────────────────

async function submitSolution(minerAddress, challengeId, artifact, nonce, token) {
    log.info('coordinator', `Submitting solution for ${challengeId?.slice(0, 8)}...`);
    const data = await retryFetch(`${baseUrl}/v1/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(token) },
        body: JSON.stringify({
            miner: minerAddress,
            challengeId,
            artifact,
            nonce
        })
    }, 'submit');
    return data;
}

// ─── Staking ────────────────────────────────────────────

async function getStakeApproveCalldata(amountWei) {
    return retryFetch(`${baseUrl}/v1/stake-approve-calldata?amount=${amountWei}`, {}, 'stake');
}

async function getStakeCalldata(amountWei) {
    return retryFetch(`${baseUrl}/v1/stake-calldata?amount=${amountWei}`, {}, 'stake');
}

async function getUnstakeCalldata() {
    return retryFetch(`${baseUrl}/v1/unstake-calldata`, {}, 'unstake');
}

async function getWithdrawCalldata() {
    return retryFetch(`${baseUrl}/v1/withdraw-calldata`, {}, 'withdraw');
}

// ─── Claims ─────────────────────────────────────────────

async function getClaimCalldata(epochs) {
    const ep = Array.isArray(epochs) ? epochs.join(',') : epochs;
    return retryFetch(`${baseUrl}/v1/claim-calldata?epochs=${ep}`, {}, 'claim');
}

async function getBonusStatus(epochs) {
    const ep = Array.isArray(epochs) ? epochs.join(',') : epochs;
    return retryFetch(`${baseUrl}/v1/bonus/status?epochs=${ep}`, {}, 'bonus');
}

async function getBonusClaimCalldata(epochs) {
    const ep = Array.isArray(epochs) ? epochs.join(',') : epochs;
    return retryFetch(`${baseUrl}/v1/bonus/claim-calldata?epochs=${ep}`, {}, 'bonus');
}

// ─── Info ───────────────────────────────────────────────

async function getEpoch() {
    return retryFetch(`${baseUrl}/v1/epoch`, {}, 'epoch');
}

async function getCredits(minerAddress) {
    return retryFetch(`${baseUrl}/v1/credits?miner=${minerAddress}`, {}, 'credits');
}

async function getTokenInfo() {
    return retryFetch(`${baseUrl}/v1/token`, {}, 'token');
}

module.exports = {
    init,
    getBaseUrl: () => baseUrl,
    retryFetch,
    authHandshake,
    getChallenge,
    submitSolution,
    getStakeApproveCalldata,
    getStakeCalldata,
    getUnstakeCalldata,
    getWithdrawCalldata,
    getClaimCalldata,
    getBonusStatus,
    getBonusClaimCalldata,
    getEpoch,
    getCredits,
    getTokenInfo
};
