// ─── Multi-Stage Solver Pipeline ────────────────────────
// 4-stage LLM pipeline for solving BOTCOIN mining challenges:
// Stage 1: Extract data + answer questions (primary model)
// Stage 2: Verify answers (verification model)
// Stage 3: Parse constraints into structured format (primary)
// Stage 4: Build artifact + validate programmatically (primary)
//
// Dual-model: LLM_MODEL (fast) + LLM_MODEL_VERIFY (accurate)

const log = require('../logger');
const prompts = require('./prompts');
const validator = require('./validator');
const { CreditError, RetryableError } = require('../errors');

const LLM_URL = 'https://llm.bankr.bot/v1/chat/completions';

let apiKey = null;
let primaryModel = 'gemini-2.5-flash';
let verifyModel = null; // Falls back to primaryModel if not set

const MAX_ARTIFACT_RETRIES = 3;
const LLM_TIMEOUT_MS = 300000; // 5 minutes

// ─── Init ───────────────────────────────────────────────

function init(key, model, verificationModel) {
    apiKey = key;
    if (model) primaryModel = model;
    if (verificationModel) verifyModel = verificationModel;
}

function setModel(m) { primaryModel = m; }
function getModel() { return primaryModel; }
function setVerifyModel(m) { verifyModel = m; }
function getVerifyModel() { return verifyModel || primaryModel; }

// ─── LLM Call ───────────────────────────────────────────

async function callLLM(prompt, model, options = {}) {
    const useModel = model || primaryModel;
    const isJson = options.json || false;

    log.debug('solver', `LLM call → ${useModel} (${prompt.length} chars)`);

    const body = {
        model: useModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens || 4096
    };

    if (isJson) {
        body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    let res;
    try {
        res = await fetch(LLM_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
            throw new RetryableError(`LLM timeout after ${LLM_TIMEOUT_MS / 1000}s`, 0, 30000);
        }
        throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
        const text = await res.text();
        // Classify LLM errors
        if (res.status === 401 || res.status === 403) {
            const err = new Error(`LLM auth error ${res.status}: ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        if (res.status === 402 || text.includes('billing') || text.includes('credits')) {
            throw new CreditError(`LLM credits exhausted: ${text.slice(0, 200)}`);
        }
        if (res.status === 429) {
            throw new RetryableError(`LLM rate limited: ${text.slice(0, 200)}`, 429, 45000);
        }
        if (res.status >= 500) {
            throw new RetryableError(`LLM server error ${res.status}: ${text.slice(0, 200)}`, res.status, 30000);
        }
        const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    const usage = data.usage || {};

    log.debug('solver', `LLM response: ${content.length} chars, ${usage.total_tokens || '?'} tokens`);
    return { content, usage };
}

// ─── Parse JSON from LLM response ──────────────────────

function parseJSON(text) {
    // Try direct parse
    try { return JSON.parse(text); } catch { }
    // Try extracting JSON block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
        try { return JSON.parse(match[1].trim()); } catch { }
    }
    // Try finding first { to last }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch { }
    }
    return null;
}

// ─── Pipeline Stage Emitter ─────────────────────────────

let currentStage = null;
let stageCallback = null;

function onStageChange(cb) { stageCallback = cb; }

function setStage(stage, detail = '') {
    currentStage = { stage, detail, timestamp: Date.now() };
    if (stageCallback) stageCallback(currentStage);
}

function getStage() { return currentStage; }

// ─── Stage 1: Extract + Answer ──────────────────────────

async function stageExtract(challenge) {
    setStage(1, 'Extracting data & answering questions');
    log.info('solver', '📋 Stage 1/4: Extracting company data + answering questions...');

    const { doc, companies, questions } = challenge;
    const prompt = prompts.extractionPrompt(doc, companies, questions);

    const { content } = await callLLM(prompt, primaryModel, { json: true, maxTokens: 8192 });
    const parsed = parseJSON(content);

    if (!parsed || !parsed.answers) {
        log.warn('solver', 'Stage 1: JSON parse failed, using raw extraction');
        return { answers: questions.map((_, i) => ({ question: i + 1, answer: 'unknown' })), raw: content };
    }

    log.success('solver', `Stage 1 complete: ${parsed.answers.length} answers extracted`);
    return parsed;
}

// ─── Stage 2: Verify ───────────────────────────────────

async function stageVerify(challenge, extractedData) {
    setStage(2, 'Verifying answers');
    log.info('solver', '🔍 Stage 2/4: Verifying answers with verification model...');

    const { doc, companies, questions } = challenge;
    const useModel = getVerifyModel();
    const prompt = prompts.verificationPrompt(doc, companies, questions, extractedData);

    const { content } = await callLLM(prompt, useModel, { json: true, maxTokens: 4096 });
    const parsed = parseJSON(content);

    if (!parsed || !parsed.answers) {
        log.warn('solver', 'Stage 2: Verification parse failed, keeping original answers');
        return extractedData;
    }

    // Merge: use verified answers, log any corrections
    let corrections = 0;
    for (const verified of parsed.answers) {
        const original = extractedData.answers.find(a => a.question === verified.question);
        if (original && verified.answer !== original.answer) {
            log.info('solver', `Corrected Q${verified.question}: "${original.answer}" → "${verified.answer}"`);
            original.answer = verified.answer;
            corrections++;
        }
    }

    log.success('solver', `Stage 2 complete: ${corrections} correction(s) applied`);
    return extractedData;
}

// ─── Stage 3: Parse Constraints ─────────────────────────

async function stageParseConstraints(challenge) {
    setStage(3, 'Parsing constraints');
    log.info('solver', '🧩 Stage 3/4: Parsing constraints...');

    const { constraints } = challenge;
    const prompt = prompts.constraintParsingPrompt(constraints);

    const { content } = await callLLM(prompt, primaryModel, { json: true });
    const parsed = parseJSON(content);

    if (!parsed || !parsed.parsed) {
        log.warn('solver', 'Stage 3: Constraint parse failed, skipping programmatic validation');
        return null;
    }

    const types = parsed.parsed.map(p => p.type);
    log.success('solver', `Stage 3 complete: ${parsed.parsed.length} constraints parsed [${types.join(', ')}]`);
    return parsed.parsed;
}

// ─── Stage 4: Build Artifact ────────────────────────────

async function stageBuildArtifact(challenge, verifiedData, parsedConstraints) {
    setStage(4, 'Building artifact');
    log.info('solver', '🔨 Stage 4/4: Building artifact...');

    const { questions, constraints, solveInstructions, proposal } = challenge;

    let lastArtifact = null;
    let lastErrors = null;

    for (let attempt = 1; attempt <= MAX_ARTIFACT_RETRIES; attempt++) {
        const prompt = prompts.artifactBuildPrompt(
            questions, verifiedData.answers, constraints,
            parsedConstraints, solveInstructions,
            lastArtifact, lastErrors, proposal
        );

        const { content } = await callLLM(prompt, primaryModel, { temperature: 0.15 });

        // Extract artifact
        let artifact = content;
        if (proposal) {
            artifact = content; // multi-line expected with VOTE/REASONING
        } else {
            const lines = content.split('\n').filter(l => l.trim());
            artifact = lines[0] || content;
        }

        // Programmatic validation
        if (parsedConstraints) {
            const result = validator.validate(artifact, parsedConstraints);
            if (result.valid) {
                log.success('solver', `Artifact built (attempt ${attempt}/${MAX_ARTIFACT_RETRIES}) ✔`);
                return artifact;
            }

            // Failed validation — retry with feedback
            lastArtifact = artifact;
            lastErrors = result.errors;

            if (attempt < MAX_ARTIFACT_RETRIES) {
                log.warn('solver', `Artifact attempt ${attempt} failed validation: ${result.errors.join('; ')}. Retrying...`);
            } else {
                log.warn('solver', `Artifact failed all ${MAX_ARTIFACT_RETRIES} validation attempts. Submitting best effort.`);
            }
        } else {
            // No parsed constraints — can't validate locally
            log.info('solver', `Artifact built (no local validation available)`);
            return artifact;
        }
    }

    // Return last attempt even if validation failed
    return lastArtifact || '';
}

// ─── Full Pipeline ──────────────────────────────────────

async function solve(challenge) {
    const startTime = Date.now();
    log.info('solver', `━━━ Starting 4-stage solve pipeline (${primaryModel} + ${getVerifyModel()}) ━━━`);

    try {
        // Stage 1: Extract + Answer
        const extracted = await stageExtract(challenge);

        // Stage 2: Verify
        const verified = await stageVerify(challenge, extracted);

        // Stage 3: Parse Constraints
        const parsedConstraints = await stageParseConstraints(challenge);

        // Stage 4: Build Artifact
        const artifact = await stageBuildArtifact(challenge, verified, parsedConstraints);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log.success('solver', `━━━ Pipeline complete in ${elapsed}s ━━━`);
        setStage(null, 'Complete');

        return artifact;
    } catch (e) {
        setStage(null, 'Error');
        throw e;
    }
}

module.exports = {
    init, setModel, getModel, setVerifyModel, getVerifyModel,
    solve, callLLM,
    onStageChange, getStage
};
