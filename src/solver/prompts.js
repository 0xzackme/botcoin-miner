// ─── Prompt Templates ───────────────────────────────────
// Centralized prompts for multi-stage mining challenge solving.

// Stage 1: Extract structured data + answer questions
function extractionPrompt(doc, companies, questions) {
    return `You are a precise data extraction agent. Read the document below and:

1. For EACH of the 25 companies, extract: full name, any aliases/alternate names, revenue figures, employee counts, founding year, and any other numerical facts mentioned.
2. Answer ALL questions using ONLY factual statements from the document. Ignore hypothetical/speculative statements.

CRITICAL: Companies are referenced by multiple names throughout the document. Track ALL aliases.

─── DOCUMENT ───
${doc}

─── COMPANIES (official names) ───
${companies.join(', ')}

─── QUESTIONS ───
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

Respond in JSON format:
{
  "companies": [
    { "name": "CompanyName", "aliases": ["Alt1"], "revenue": "...", "employees": "...", "facts": ["..."] }
  ],
  "answers": [
    { "question": 1, "answer": "ExactCompanyName", "reasoning": "brief explanation" }
  ]
}

Use ONLY company names from the official list above. Be precise with numbers.`;
}

// Stage 2: Verify constraint-critical data
function verificationPrompt(doc, companies, questions, extractedData) {
    return `You are a verification agent. You must DOUBLE-CHECK these answers against the original document.

Previous extraction found these answers:
${JSON.stringify(extractedData.answers, null, 2)}

Re-read the document and verify each answer is correct. Pay special attention to:
- Multi-hop reasoning (e.g., "which company had the HIGHEST total annual revenue?" requires comparing ALL revenue figures)
- Aliases — companies are referenced by multiple names
- Ignore hypothetical and speculative statements (red herrings)

─── DOCUMENT ───
${doc}

─── COMPANIES ───
${companies.join(', ')}

─── QUESTIONS ───
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

Respond in JSON format:
{
  "answers": [
    { "question": 1, "answer": "ExactCompanyName", "confidence": "high|medium|low", "correction": "explanation if changed" }
  ]
}

Use ONLY company names from the official list. If an answer looks wrong, correct it.`;
}

// Stage 3: Parse constraints into structured format
function constraintParsingPrompt(constraints) {
    return `Parse these constraints into structured JSON. Each constraint describes a rule the artifact string must satisfy.

─── CONSTRAINTS ───
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

For each constraint, identify its type and parameters. Respond in JSON:
{
  "parsed": [
    { "index": 1, "type": "word_count", "value": 42 },
    { "index": 2, "type": "acrostic", "value": "HELLO" },
    { "index": 3, "type": "forbidden_letter", "value": "e" },
    { "index": 4, "type": "must_include", "value": "specific phrase" },
    { "index": 5, "type": "prime", "value": "word count must be prime" },
    { "index": 6, "type": "mod", "dividend": "word_count", "divisor": 7, "remainder": 3 },
    { "index": 7, "type": "other", "description": "..." }
  ]
}

Types: word_count, acrostic, forbidden_letter, must_include, must_not_include, prime, mod, starts_with, ends_with, other`;
}

// Stage 4: Build artifact
function artifactBuildPrompt(questions, answers, constraints, parsedConstraints, solveInstructions, previousAttempt, validationErrors, proposal) {
    let prompt = `You are an artifact builder. Generate a SINGLE LINE string that satisfies ALL constraints below.

─── ANSWERS TO USE ───
${answers.map((a, i) => `Q${i + 1}: ${a.answer}`).join('\n')}

─── CONSTRAINTS (original text) ───
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

─── PARSED CONSTRAINTS (structured) ───
${JSON.stringify(parsedConstraints, null, 2)}
`;

    if (solveInstructions) {
        prompt += `\n─── SOLVE INSTRUCTIONS ───\n${solveInstructions}\n`;
    }

    if (previousAttempt && validationErrors) {
        prompt += `\n─── PREVIOUS ATTEMPT FAILED ───
Your previous artifact: "${previousAttempt}"
Validation errors:
${validationErrors.map(e => `• ${e}`).join('\n')}
Fix these issues in your new attempt.\n`;
    }

    // Proposal instructions go BEFORE the output instruction
    if (proposal) {
        prompt += proposalSuffix(proposal);
    }

    // CRITICAL: Output instruction must be the LAST thing the model sees (per botcoinskill.md)
    prompt += `\nYour response must be exactly one line — the artifact string and nothing else. Do NOT output "Q1:", "Looking at", "Let me", "First", "Answer:", or any reasoning. Do NOT explain your process. Output ONLY the single-line artifact that satisfies all constraints. No preamble. No JSON. Just the artifact.`;

    return prompt;
}

// Proposal voting attachment
function proposalSuffix(proposal) {
    return `\n─── PROPOSAL ───\n${JSON.stringify(proposal)}\nAfter the artifact, append on new lines:\nVOTE: yes|no\nREASONING: <100 words max>\n`;
}

module.exports = {
    extractionPrompt,
    verificationPrompt,
    constraintParsingPrompt,
    artifactBuildPrompt,
    proposalSuffix
};
