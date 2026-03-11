// ─── BOTCOIN Miner Server ───────────────────────────────
// Multi-user session-based server.
// Local mode: BANKR_API_KEY in .env → auto-creates local session
// Service mode: Users enter API key via UI → get session cookie

require('dotenv').config();
const express = require('express');
const path = require('path');
const log = require('./logger');
const coordinator = require('./coordinator');
const { SessionManager } = require('./sessions');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Session Manager ────────────────────────────────────

const sessions = new SessionManager();
const API_KEY = process.env.BANKR_API_KEY || null;
coordinator.init(process.env.COORDINATOR_URL);

// Auto-create local session if API key in .env
let localSession = null;
if (API_KEY) {
    localSession = sessions.create(API_KEY);
    localSession.sessionId = 'local';
    sessions.sessions.set('local', localSession);
    log.info('server', 'Local session created from .env BANKR_API_KEY');
}

// ─── Session Middleware ─────────────────────────────────

function getSession(req, res) {
    // Check cookie first, then header, then fallback to local
    const sid = req.cookies?.sid || req.headers['x-session-id'] || 'local';
    const session = sessions.get(sid);
    if (!session) {
        // In local mode with no session cookie, use local session
        if (localSession) return localSession;
        return null;
    }
    return session;
}

// Simple cookie parser middleware
app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (k && v) req.cookies[k] = v;
        });
    }
    next();
});

// Optional basic auth for hosted mode
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
if (AUTH_PASSWORD) {
    app.use((req, res, next) => {
        if (req.path.startsWith('/api/') || req.path === '/') {
            const auth = req.headers.authorization;
            if (!auth || auth !== `Basic ${Buffer.from(`admin:${AUTH_PASSWORD}`).toString('base64')}`) {
                res.set('WWW-Authenticate', 'Basic realm="BOTCOIN Miner"');
                return res.status(401).json({ error: 'Authentication required' });
            }
        }
        next();
    });
}

// ─── API Routes ─────────────────────────────────────────

// SSE events — per-session stream
app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    const session = getSession(req, res);
    if (session) {
        session.addSSEClient(res);
        req.on('close', () => session.removeSSEClient(res));
    } else {
        // No session yet — just keep connection open for when they create one
        req.on('close', () => { });
    }
});

// Status
app.get('/api/status', (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.json({ state: 'IDLE', hasApiKey: false, activeSessions: sessions.getActiveCount() });
    res.json({
        ...session.getStatus(),
        activeSessions: sessions.getActiveCount(),
        runningMiners: sessions.getRunningCount()
    });
});

// Set API key — creates or replaces session
app.post('/api/apikey', async (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'API Key required' });

    try {
        // Create new session for this API key
        const session = sessions.create(key);
        const wallet = await session.getWalletAddress();
        session.walletAddress = wallet;
        session.log('success', 'server', `Wallet: ${wallet}`);

        // Set session cookie (30 days)
        res.setHeader('Set-Cookie', `sid=${session.sessionId}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`);
        res.json({ ok: true, walletAddress: wallet, sessionId: session.sessionId });
    } catch (e) {
        log.error('server', `API Key failed: ${e.message}`);
        res.status(400).json({ error: e.message });
    }
});

// Start mining
app.post('/api/start', (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ error: 'No session. Enter API key first.' });

    const { model, verifyModel, verifyEnabled, autoFund, stakeAmount } = req.body || {};
    if (model) session.setModel(model);
    if (verifyModel) session.setVerifyModel(verifyModel);
    session._verifyEnabled = verifyEnabled !== false && verifyEnabled !== undefined ? !!verifyEnabled : false;
    session.start({ autoFund, stakeAmount });
    res.json({ ok: true, message: 'Mining started' });
});

// Stop mining
app.post('/api/stop', (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ error: 'No session' });
    session.stop();
    res.json({ ok: true, message: 'Stop requested' });
});

// Claim rewards
app.post('/api/claim', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ error: 'No session' });
    try {
        await session.claimRewards();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test solve (dry run)
app.post('/api/test-solve', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ error: 'No session' });
    try {
        if (!session.walletAddress) {
            session.walletAddress = await session.getWalletAddress();
        }
        await session.ensureAuth();
        const crypto = require('crypto');
        const nonce = crypto.randomBytes(16).toString('hex');
        const challenge = await coordinator.getChallenge(session.walletAddress, nonce, session.authToken);
        const artifact = await session._solvePipeline(challenge);
        res.json({ ok: true, epochId: challenge.epochId, creditsPerSolve: challenge.creditsPerSolve, artifact: artifact?.slice(0, 200) });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// Config (model switching)
app.get('/api/config', (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.json({ model: process.env.LLM_MODEL || 'gemini-2.5-flash' });
    res.json({ model: session.getModel(), verifyModel: session.getVerifyModel() });
});

app.post('/api/config', (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ error: 'No session' });
    const { model, verifyModel, verifyEnabled } = req.body || {};
    if (model) {
        const prev = session.getModel();
        session.setModel(model);
        session.log('info', 'server', `Model: ${prev} → ${model}`);
    }
    if (verifyEnabled !== undefined) {
        session._verifyEnabled = !!verifyEnabled;
        session.log('info', 'server', `Dual-model verify: ${verifyEnabled ? 'ON' : 'OFF'}`);
    }
    if (verifyModel) {
        const prev = session.getVerifyModel();
        session.setVerifyModel(verifyModel);
        session.log('info', 'server', `Verify model: ${prev} → ${verifyModel}`);
    } else if (verifyModel === null) {
        session.setVerifyModel(null);
    }
    res.json({ ok: true, model: session.getModel(), verifyModel: session.getVerifyModel() });
});

// Models list
app.get('/api/models', async (req, res) => {
    try {
        const session = getSession(req, res);
        const apiKey = session?._bankrApiKey || API_KEY;
        if (!apiKey) return res.json(defaultModels());

        const r = await fetch('https://llm.bankr.bot/v1/models', { headers: { 'X-API-Key': apiKey } });
        if (!r.ok) return res.json(defaultModels());
        const data = await r.json();
        res.json(data.data || data.models || data);
    } catch {
        res.json(defaultModels());
    }
});

function defaultModels() {
    return [
        // Google Gemini
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Recommended)' },
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
        { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
        // Anthropic Claude
        { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
        { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
        { id: 'claude-opus-4.5', label: 'Claude Opus 4.5' },
        { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
        // OpenAI GPT
        { id: 'gpt-5.2', label: 'GPT 5.2' },
        { id: 'gpt-5.2-codex', label: 'GPT 5.2 Codex' },
        { id: 'gpt-5-mini', label: 'GPT 5 Mini' },
        { id: 'gpt-5-nano', label: 'GPT 5 Nano' },
        // Moonshot AI Kimi
        { id: 'kimi-k2', label: 'Kimi K2 (Moonshot)' },
        // Alibaba Qwen
        { id: 'qwen-max', label: 'Qwen Max (Alibaba)' }
    ];
}

// Epoch info
app.get('/api/epochs', async (req, res) => {
    try {
        const epoch = await coordinator.getEpoch();
        res.json({ epoch });
    } catch (e) {
        res.json({ epoch: null, error: e.message });
    }
});

// Logs (last N)
app.get('/api/logs', (req, res) => {
    const session = getSession(req, res);
    const count = parseInt(req.query.count) || 50;
    // Return recent logs from log buffer
    const logs = log.getRecent?.(count) || [];
    res.json(logs);
});

// Service info
app.get('/api/info', (req, res) => {
    res.json({
        version: '2.0.0',
        multiUser: true,
        activeSessions: sessions.getActiveCount(),
        runningMiners: sessions.getRunningCount()
    });
});

// Logout / destroy session
app.post('/api/logout', (req, res) => {
    const sid = req.cookies?.sid || req.headers['x-session-id'];
    if (sid && sid !== 'local') {
        sessions.remove(sid);
        res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
    }
    res.json({ ok: true });
});

// Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
    log.success('server', `BOTCOIN Miner running at http://localhost:${PORT}`);
    log.info('server', `Mode: ${API_KEY ? 'Local + Service' : 'Service only'}`);
    log.info('server', `Active sessions: ${sessions.getActiveCount()}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log.warn('server', `Port ${PORT} in use. Trying ${PORT + 1}...`);
        const fallback = app.listen(PORT + 1, () => {
            log.success('server', `BOTCOIN Miner running at http://localhost:${PORT + 1}`);
        });
        fallback.on('error', () => {
            log.error('server', `Ports ${PORT} and ${PORT + 1} both in use.`);
            process.exit(1);
        });
    } else {
        log.error('server', `Server error: ${err.message}`);
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    log.info('server', 'Shutting down...');
    for (const [id, session] of sessions.sessions) {
        session.destroy();
    }
    process.exit(0);
});
