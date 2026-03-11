// ─── Error Classification ───────────────────────────────
// Typed errors for clear handling in the mining loop.

class MinerError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'MinerError';
        this.code = code;
        this.status = status;
    }
}

class RetryableError extends MinerError {
    constructor(message, status, retryAfterMs = null) {
        super(message, 'RETRYABLE', status);
        this.name = 'RetryableError';
        this.retryAfterMs = retryAfterMs;
    }
}

class FatalError extends MinerError {
    constructor(message, status) {
        super(message, 'FATAL', status);
        this.name = 'FatalError';
    }
}

class SolveError extends MinerError {
    constructor(message, failedConstraints = []) {
        super(message, 'SOLVE_FAILED');
        this.name = 'SolveError';
        this.failedConstraints = failedConstraints;
    }
}

class CreditError extends MinerError {
    constructor(message) {
        super(message, 'CREDITS_EXHAUSTED', 402);
        this.name = 'CreditError';
    }
}

class AuthError extends MinerError {
    constructor(message) {
        super(message, 'AUTH_EXPIRED', 401);
        this.name = 'AuthError';
    }
}

// Classify an HTTP error into a typed error
function classify(err) {
    const status = err.status || 0;
    const msg = err.message || '';

    // Auth expired
    if (status === 401) return new AuthError(msg);

    // Credits / billing
    if (status === 402 || msg.includes('billing') || msg.includes('usage limit')) {
        return new CreditError(msg);
    }

    // Permission / balance — fatal
    if (status === 403) return new FatalError(msg, 403);

    // Rate limit — retryable
    if (status === 429) {
        const wait = err.body?.retryAfterSeconds ? err.body.retryAfterSeconds * 1000 : 60000;
        return new RetryableError(msg, 429, wait);
    }

    // Server errors — retryable
    if (status >= 500) return new RetryableError(msg, status, 30000);

    // Solve failures
    if (err.failedConstraints || msg.includes('constraint')) {
        return new SolveError(msg, err.failedConstraints || []);
    }

    // Network / unknown
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
        return new RetryableError(msg, 0, 10000);
    }

    return err;
}

module.exports = {
    MinerError, RetryableError, FatalError, SolveError, CreditError, AuthError,
    classify
};
