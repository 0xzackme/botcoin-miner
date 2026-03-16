// ─── Prompt Templates ───────────────────────────────────
// Simplified 2-stage solver: SOLVE (answers+compute) → BUILD (artifact)

function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
}

// ─── Stage 1: SOLVE — answers + compute everything in one call ───
function solvePrompt(doc, companies, questions, constraints) {
    return `You are solving a mining challenge. Read the document, answer questions, then compute constraint values.

## STEP 1: ANSWER QUESTIONS

Read the document and answer each question. Your answer MUST be an exact company name from the official list.

CRITICAL RULES:
- Companies use MULTIPLE names/aliases. Always map back to the OFFICIAL name from the list.
- IGNORE hypothetical/speculative statements ("if", "would", "could", "might", "projected", "estimated", "potentially").
- For comparison questions (highest/lowest): find ALL candidates, compare their values, pick the correct one.
- Show your reasoning for each answer.

## STEP 2: COMPUTE CONSTRAINT VALUES

After answering, compute the EXACT value for each constraint by looking up data in the document.
- "headquarters city of company from Question X" → find Q{X}'s answer company in the document → extract HQ city
- "CEO's last name of company from Question X" → find CEO → extract last name only
- "nextPrime((employees of QX mod 100) + 11)" → find employee count → compute: (employees % 100) + 11 → find next prime ≥ that
- "equation A+B=C" → compute A, B from revenue data, C = A + B
- Acrostic from initials → get initials of each referenced answer → concatenate → take first N letters → UPPERCASE
- Revenue "mod 90": use revenue in MILLIONS (e.g. "$4.2B" = 4200, so 4200 mod 90 = 60)

PRIMES: 11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109,113

───── DOCUMENT ─────
${doc}

───── OFFICIAL COMPANY NAMES ─────
${companies.join(', ')}

───── QUESTIONS ─────
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

───── CONSTRAINTS ─────
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

## RESPONSE FORMAT (JSON)
{
  "answers": [
    { "question": 1, "answer": "ExactOfficialCompanyName", "initials": "EOCN", "reasoning": "..." }
  ],
  "computed_constraints": {
    "word_count": 19,
    "forbidden_letter": "x",
    "acrostic_letters": "ABCDEFGH",
    "must_include": ["CityName", "LastName", "Country", "47", "42+38=80"],
    "details": [
      { "constraint": 2, "value": "CityName", "work": "Q8=CompanyX. Doc says CompanyX HQ is in CityName." },
      { "constraint": 5, "value": "47", "work": "employees=8350. 8350%100=50. 50+11=61. nextPrime(61)=61." }
    ]
  }
}

SHOW ALL WORK in the reasoning and details fields.`;
}

// ─── Stage 2: BUILD — assemble artifact from pre-computed values ───
function buildPrompt(answers, computedConstraints, constraints, previousAttempt, validationErrors, solveInstructions, proposal) {
    let prompt = `Build a SINGLE LINE artifact satisfying ALL constraints.

## PRE-COMPUTED VALUES (use these EXACTLY)
Word count: ${computedConstraints?.word_count || '?'}
Acrostic letters: ${computedConstraints?.acrostic_letters || '?'}
Forbidden letter: ${computedConstraints?.forbidden_letter || 'none'}
Must include: ${(computedConstraints?.must_include || []).join(' | ')}

## ANSWERS
${answers.map((a, i) => `Q${i + 1}: ${a.answer} (${a.initials || getInitials(a.answer)})`).join('\n')}

## CONSTRAINTS
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

## DETAILED COMPUTATIONS
${(computedConstraints?.details || []).map(d => `C${d.constraint}: "${d.value}" — ${d.work}`).join('\n')}
`;

    if (solveInstructions) {
        prompt += `\n## SOLVE INSTRUCTIONS\n${solveInstructions}\n`;
    }

    if (previousAttempt && validationErrors) {
        prompt += `\n## ⚠ PREVIOUS ATTEMPT FAILED
Previous: "${previousAttempt}"
Errors:
${validationErrors.map(e => `✖ ${e}`).join('\n')}
Fix ALL errors while keeping other constraints.\n`;
    }

    if (proposal) {
        prompt += `\n─── PROPOSAL ───\n${JSON.stringify(proposal)}\nAfter the artifact, append on new lines:\nVOTE: yes|no\nREASONING: <100 words max>\n`;
    }

    prompt += `
## BUILD STRATEGY
1. Start with acrostic letters — each word MUST begin with the required letter
2. Embed must_include values as words in the artifact
3. AVOID the forbidden letter in EVERY character
4. Count words to hit exact word_count
5. Verify: count words, check first letters, confirm all must_include present, no forbidden letter

## OUTPUT
Your response must be exactly one line — the artifact string and nothing else. No reasoning, no preamble, no JSON. Just the artifact.`;

    return prompt;
}

module.exports = {
    solvePrompt,
    buildPrompt,
    getInitials
};
