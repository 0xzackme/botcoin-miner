// ─── Bankr API Client ───────────────────────────────────
// Wraps Bankr Agent API (api.bankr.bot) for wallet ops,
// and Bankr LLM Gateway (llm.bankr.bot) for model listing.
// Non-custodial: only uses the user's BANKR_API_KEY.

const log = require('./logger');
const keyCrypto = require('./crypto');

const AGENT_URL = 'https://api.bankr.bot';
const LLM_URL = 'https://llm.bankr.bot';

let encryptedApiKey = null;
let isAborted = false;
let abortController = new AbortController();

function init(key) {
    encryptedApiKey = key ? keyCrypto.encrypt(key) : null;
}

function abort() {
    isAborted = true;
    abortController.abort();
}
function resetAbort() {
    isAborted = false;
    abortController = new AbortController();
}

function headers(json = false) {
    const h = { 'X-API-Key': _getApiKey() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}

// ─── Generic helpers ────────────────────────────────────

async function fetchJSON(url, opts = {}) {
    if (isAborted) throw new Error('Operation aborted by user');
    opts.signal = abortController.signal;

    let res;
    try {
        res = await fetch(url, opts);
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('Operation aborted by user');
        throw e;
    }

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
        let errMsg = body.message || body.error || text.slice(0, 300);
        if (typeof errMsg === 'object') errMsg = JSON.stringify(errMsg);
        const err = new Error(`HTTP ${res.status}: ${errMsg}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Poll a Bankr job until completed/failed
async function pollJob(jobId, timeoutMs = 120000) {
    const start = Date.now();
    const pollInterval = 2000;
    let polls = 0;
    while (Date.now() - start < timeoutMs) {
        if (isAborted) throw new Error('Job polling aborted by user');
        const data = await fetchJSON(`${AGENT_URL}/agent/job/${jobId}`, { headers: headers() });
        if (data.status === 'completed') return data;
        if (data.status === 'failed' || data.status === 'error') {
            throw new Error(`Job ${jobId} failed: ${data.response || JSON.stringify(data)}`);
        }
        polls++;
        if (polls % 5 === 0) {
            const elapsed = Math.round((Date.now() - start) / 1000);
            log.debug('bankr', `Waiting for Bankr to process... (${elapsed}s, status: ${data.status || 'pending'})`);
        }
        await sleep(pollInterval);
    }
    throw new Error(`Job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s — Bankr may be busy, try again`);
}

// ─── Wallet ─────────────────────────────────────────────

async function getWalletAddress() {
    log.info('bankr', 'Resolving wallet address...');
    const data = await fetchJSON(`${AGENT_URL}/agent/me`, { headers: headers() });
    // Extract first Base/EVM wallet
    const wallets = data.wallets || data.data?.wallets || [];
    for (const w of wallets) {
        if (w.chain === 'base' || w.chain === 'evm' || w.network === 'base' || w.type === 'evm') {
            log.success('bankr', `Wallet resolved: ${w.address}`);
            return w.address;
        }
    }
    // Fallback: try first wallet
    if (wallets.length > 0) {
        log.success('bankr', `Wallet resolved (fallback): ${wallets[0].address}`);
        return wallets[0].address;
    }
    // Try nested structure
    if (data.address) return data.address;
    if (data.data?.address) return data.data.address;
    throw new Error('No Base/EVM wallet found in Bankr account');
}

// ─── Balances ───────────────────────────────────────────

async function getBalances() {
    log.info('bankr', 'Checking balances on Base...');
    const { jobId } = await fetchJSON(`${AGENT_URL}/agent/prompt`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ prompt: 'what are my balances on base?' })
    });
    const result = await pollJob(jobId);
    return result.response || '';
}

// ─── Swap / Bridge ──────────────────────────────────────

async function swapForBotcoin(exactTokenAmount) {
    const tokenAddr = '0xA601877977340862Ca67f816eb079958E5bd0BA3';
    log.info('bankr', `Swapping ETH for ${exactTokenAmount.toLocaleString()} BOTCOIN...`);
    const { jobId } = await fetchJSON(`${AGENT_URL}/agent/prompt`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
            prompt: `swap my ETH on base for exactly ${exactTokenAmount} tokens of ${tokenAddr}. If I have insufficient ETH, tell me exactly how much ETH is required for this swap.`
        })
    });
    const result = await pollJob(jobId, 180000);
    log.success('bankr', `Swap complete: ${result.response?.slice(0, 200)}`);
    return result.response;
}

async function bridgeEth(amountUsd) {
    log.info('bankr', `Bridging $${amountUsd} ETH to Base...`);
    const { jobId } = await fetchJSON(`${AGENT_URL}/agent/prompt`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ prompt: `bridge $${amountUsd} of ETH to base` })
    });
    const result = await pollJob(jobId, 180000);
    log.success('bankr', `Bridge complete: ${result.response?.slice(0, 200)}`);
    return result.response;
}

// ─── Transaction Submission ─────────────────────────────

async function submitTransaction(tx, description) {
    log.info('bankr', `Submitting tx: ${description}`);
    const payload = {
        transaction: {
            to: tx.to,
            chainId: tx.chainId || 8453,
            value: tx.value || '0',
            data: tx.data
        },
        description,
        waitForConfirmation: true
    };
    const result = await fetchJSON(`${AGENT_URL}/agent/submit`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(payload)
    });
    if (result.success) {
        log.success('bankr', `Tx confirmed: ${result.transactionHash}`);
    } else {
        log.error('bankr', `Tx failed: ${JSON.stringify(result)}`);
    }
    return result;
}

// ─── Signing ────────────────────────────────────────────

async function signMessage(message) {
    log.debug('bankr', 'Signing message for auth...');
    const result = await fetchJSON(`${AGENT_URL}/agent/sign`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ signatureType: 'personal_sign', message })
    });
    return result.signature;
}

// ─── LLM Credits ────────────────────────────────────────

async function topUpCredits(amountUsd, token = 'USDC') {
    log.info('bankr', `Topping up LLM credits: $${amountUsd} from ${token}...`);
    const { jobId } = await fetchJSON(`${AGENT_URL}/agent/prompt`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
            prompt: `top up my LLM credits with $${amountUsd} from ${token}`
        })
    });
    const result = await pollJob(jobId, 120000);
    log.success('bankr', `Credits topped up: ${result.response?.slice(0, 200)}`);
    return result.response;
}

// ─── LLM Gateway: List Models ───────────────────────────

async function listModels() {
    const data = await fetchJSON(`${LLM_URL}/v1/models`, {
        headers: headers()
    });
    return (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
        provider: m.owned_by || 'unknown'
    }));
}

function _getApiKey() { return encryptedApiKey ? keyCrypto.decrypt(encryptedApiKey) : null; }

module.exports = {
    init,
    _getApiKey,
    getWalletAddress,
    getBalances,
    swapForBotcoin,
    bridgeEth,
    submitTransaction,
    signMessage,
    topUpCredits,
    listModels,
    fetchJSON,
    sleep,
    abort,
    resetAbort
};
