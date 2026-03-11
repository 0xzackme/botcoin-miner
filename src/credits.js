// ─── LLM Credit Monitor & Auto Top-Up ───────────────────
// Monitors Bankr LLM Gateway credit balance and auto-tops
// up when balance drops below threshold. Self-funds inference.

const log = require('./logger');
const bankr = require('./bankr');

const CHECK_INTERVAL = parseInt(process.env.CREDIT_CHECK_INTERVAL_MS) || 300000; // 5 min
const MIN_THRESHOLD = parseFloat(process.env.CREDIT_MIN_USD) || 2;
const TOPUP_AMOUNT = parseFloat(process.env.CREDIT_TOPUP_USD) || 5;
const TOPUP_TOKEN = process.env.CREDIT_TOPUP_TOKEN || 'USDC';

let intervalId = null;
let isTopUpInProgress = false;
let lastBalance = null;
let topUpCount = 0;

// ─── Check credit balance ───────────────────────────────

async function getBalance() {
    try {
        const data = await bankr.fetchJSON('https://llm.bankr.bot/v1/credits', {
            headers: { 'X-API-Key': bankr._getApiKey() }
        });
        const bal = parseFloat(data.balance || data.credits || data.remaining || 0);
        lastBalance = bal;
        return bal;
    } catch (e) {
        // Fallback: try via Bankr prompt
        try {
            log.debug('credits', 'Direct balance check failed, trying prompt fallback...');
            const { jobId } = await bankr.fetchJSON('https://api.bankr.bot/agent/prompt', {
                method: 'POST',
                headers: {
                    'X-API-Key': bankr._getApiKey(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'what is my LLM credit balance?' })
            });
            // Don't poll here — too slow for background check
            return lastBalance;
        } catch {
            return lastBalance;
        }
    }
}

// ─── Top up credits ─────────────────────────────────────

async function topUp() {
    if (isTopUpInProgress) return;
    isTopUpInProgress = true;

    try {
        log.warn('credits', `LLM credits low${lastBalance !== null ? ` ($${lastBalance.toFixed(2)})` : ''}. Topping up $${TOPUP_AMOUNT} from ${TOPUP_TOKEN}...`);
        await bankr.topUpCredits(TOPUP_AMOUNT, TOPUP_TOKEN);
        topUpCount++;
        log.success('credits', `Top-up #${topUpCount} complete ($${TOPUP_AMOUNT} from ${TOPUP_TOKEN})`);

        // Wait before next check to avoid double-spend
        await bankr.sleep(60000);
    } catch (e) {
        log.error('credits', `Top-up failed: ${e.message}`);
    } finally {
        isTopUpInProgress = false;
    }
}

// ─── Check and top up if needed ─────────────────────────

async function checkAndTopUp() {
    try {
        const balance = await getBalance();
        if (balance !== null && balance < MIN_THRESHOLD) {
            await topUp();
            return true;
        }
        if (balance !== null) {
            log.debug('credits', `LLM credit balance: $${balance.toFixed(2)} (threshold: $${MIN_THRESHOLD})`);
        }
        return false;
    } catch (e) {
        log.debug('credits', `Balance check error: ${e.message}`);
        return false;
    }
}

// ─── Start periodic monitoring ──────────────────────────

function start() {
    if (intervalId) return;
    log.info('credits', `Credit monitor started (check every ${CHECK_INTERVAL / 1000}s, threshold: $${MIN_THRESHOLD}, top-up: $${TOPUP_AMOUNT})`);

    // Initial check after short delay
    setTimeout(() => checkAndTopUp(), 10000);

    intervalId = setInterval(() => checkAndTopUp(), CHECK_INTERVAL);
}

function stop() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        log.info('credits', 'Credit monitor stopped');
    }
}

function getStatus() {
    return {
        lastBalance,
        topUpCount,
        isTopUpInProgress,
        threshold: MIN_THRESHOLD,
        topUpAmount: TOPUP_AMOUNT,
        token: TOPUP_TOKEN
    };
}

module.exports = { start, stop, checkAndTopUp, getBalance, getStatus };
