// ─── Prompt Templates ───────────────────────────────────
// 3-stage solver: ANSWER → COMPUTE → BUILD

function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
}

// ─── Stage 1: ANSWER — focused only on getting the right answers ───
function answerPrompt(doc, companies, questions) {
    return `Read the document and answer each question. Your answer MUST be an exact company name from the official list.

RULES:
- Companies use multiple aliases. Always map back to the OFFICIAL name.
- IGNORE hypothetical/speculative statements ("if", "would", "could", "might", "projected", "estimated").
- For comparison questions (highest/lowest/most): find ALL candidates, list their values, compare, pick correct one.
- Show step-by-step reasoning for each answer.

OFFICIAL COMPANY NAMES:
${companies.join(', ')}

DOCUMENT:
${doc}

QUESTIONS:
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

Respond in JSON:
{
  "answers": [
    { "question": 1, "answer": "ExactOfficialCompanyName", "initials": "EOCN", "reasoning": "step-by-step explanation" }
  ]
}`;
}

// ─── Stage 2: COMPUTE — look up company data + calculate constraint values ───
function computePrompt(doc, answers, constraints) {
    return `You have answers to questions about companies. Now compute the EXACT values required by each constraint.

ANSWERS:
${answers.map((a, i) => `Q${i + 1}: ${a.answer} (initials: ${a.initials || getInitials(a.answer)})`).join('\n')}

DOCUMENT (search this for company data — HQ, CEO, employees, revenue):
${doc}

CONSTRAINTS TO RESOLVE:
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

FOR EACH CONSTRAINT, DO THIS:
1. "word count = N" → value = N
2. "headquarters city of company from Question X" → find QX's answer → search document for that company → extract HQ city name
3. "CEO's last name of company from Question X" → find QX's answer → search document for CEO → extract LAST NAME only
4. "headquarters country of company from Question X" → find QX's answer → search document → extract country
5. "nextPrime((employees of QX mod 100) + 11)" → find employee count in doc → (employees % 100) + 11 → next prime ≥ result
6. "equation A+B=C" → look up revenue in doc → compute A, B (revenue mod 90 + 10) → C = A + B → format as "A+B=C"
7. Acrostic from initials → concatenate initials of referenced answers → take first N letters → UPPERCASE
8. "forbidden letter" → extract the letter
PRIMES: 11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109,113

REVENUE PARSING: "$4.2 billion" = 4200 (in millions). "mod 90" means 4200 % 90.

Respond in JSON:
{
  "word_count": 19,
  "forbidden_letter": "x",
  "acrostic_letters": "ABCDEFGH",
  "must_include": ["CityName", "LastName", "Country", "47", "42+38=80"],
  "details": [
    { "constraint": 2, "value": "CityName", "work": "Q8=CompanyX. Doc says HQ in CityName." },
    { "constraint": 5, "value": "47", "work": "employees=8350. 8350%100=50. 50+11=61. nextPrime(61)=61." }
  ]
}

CRITICAL: Every value must come from the document. Show your work. Do NOT guess.`;
}

// ─── Stage 3: BUILD — assemble artifact from pre-computed values ───
function buildPrompt(answers, computed, constraints, previousAttempt, errors, solveInstructions, proposal) {
    let prompt = `Build a SINGLE LINE artifact satisfying ALL constraints below.

PRE-COMPUTED VALUES (use these EXACTLY):
- Word count: ${computed?.word_count || '?'}
- Forbidden letter: "${computed?.forbidden_letter || 'none'}"
- Acrostic letters: ${computed?.acrostic_letters || '?'}
- Must include these exact strings: ${(computed?.must_include || []).join(', ')}

ANSWERS:
${answers.map((a, i) => `Q${i + 1}: ${a.answer} (${a.initials || getInitials(a.answer)})`).join('\n')}

CONSTRAINTS:
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

COMPUTATIONS:
${(computed?.details || []).map(d => `C${d.constraint}: "${d.value}" (${d.work})`).join('\n')}`;

    if (solveInstructions) prompt += `\n\nSOLVE INSTRUCTIONS:\n${solveInstructions}`;

    if (previousAttempt && errors) {
        prompt += `\n\nPREVIOUS ATTEMPT FAILED:
"${previousAttempt}"
Errors: ${errors.join('; ')}
Fix ALL errors.`;
    }

    if (proposal) {
        prompt += `\n\nPROPOSAL:\n${JSON.stringify(proposal)}\nAfter artifact, add:\nVOTE: yes|no\nREASONING: <100 words`;
    }

    prompt += `

BUILD STEPS:
1. Start with acrostic — word N must begin with letter N of the acrostic
2. Include all must_include values as words
3. AVOID forbidden letter in EVERY character
4. Hit exact word count
5. Double-check: count words, verify first letters, confirm must_include present, no forbidden letter

OUTPUT: Exactly one line — the artifact string only. No quotes, no explanation.`;
    return prompt;
}

module.exports = { answerPrompt, computePrompt, buildPrompt, getInitials };
