// ─── Prompt Templates ───────────────────────────────────
// Advanced prompts for multi-stage BOTCOIN mining challenge solving.
// Designed for high solve rates with complex constraint satisfaction.

function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
}

// Stage 1: Answer questions with careful multi-hop reasoning
function extractionPrompt(doc, companies, questions) {
    return `You are solving a reading comprehension challenge. Read the document and answer each question.

## CRITICAL INSTRUCTIONS

### How to Answer
For EACH question, follow this process:
1. Read the question carefully — what EXACTLY is being asked?
2. Search the ENTIRE document for relevant data
3. For comparison questions (highest/lowest/most/fewest), you MUST:
   - Find ALL candidates with relevant data
   - List each candidate's value
   - Compare them ALL
   - Pick the correct one
4. Your answer MUST be an EXACT company name from the official list below

### Traps to Avoid
- **Aliases**: Companies use multiple names. "QS", "Quantum Sol", "Quantum Solutions Inc" may all be the same company. Always map back to the official name.
- **Red herrings**: IGNORE any statement using: "if", "would", "could", "might", "projected", "planned", "estimated", "expected", "hypothetically", "potentially". Only use STATED FACTS.
- **Recency bias**: Don't pick the first company you find. Read ALL data before answering comparison questions.
- **Revenue/Employee tricks**: Some numbers include subsidiaries, some don't. Use the number that matches what the question asks.

### Official Company Names (answers MUST exactly match one of these)
${companies.join(', ')}

## DOCUMENT
${doc}

## QUESTIONS
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

## RESPONSE FORMAT (JSON)
{
  "answers": [
    {
      "question": 1,
      "answer": "ExactOfficialCompanyName",
      "initials": "EOCN",
      "reasoning": "DETAILED step-by-step: I found X=100, Y=200, Z=150. Y is highest. Y's official name is CompanyName."
    }
  ]
}

RULES:
- "answer" must EXACTLY match one company name from the official list
- "initials" = first letter of each word, UPPERCASED (e.g. "Quantum Solutions" → "QS")
- "reasoning" must show your work for comparison questions — list ALL candidates and their values
- Return answers for ALL ${questions.length} questions`;
}


// Stage 2: Verify answers
function verificationPrompt(doc, companies, questions, extractedData) {
    return `You are a VERIFICATION agent. Re-read the document and check if these answers are correct.

## PREVIOUS ANSWERS TO VERIFY
${JSON.stringify(extractedData.answers, null, 2)}

## VERIFICATION STEPS
For EACH answer:
1. Re-read the document and find evidence for/against this answer
2. For comparison questions (highest/lowest/most), list ALL candidates and verify the right one was picked
3. Check the company name matches the official list EXACTLY
4. Watch for RED HERRINGS: ignore hypothetical/speculative/projected statements
5. ONLY correct an answer if you are CONFIDENT the original is wrong

## DOCUMENT
${doc}

## COMPANIES (official names)
${companies.join(', ')}

## QUESTIONS
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

## RESPONSE FORMAT (JSON)
{
  "answers": [
    {
      "question": 1,
      "answer": "ExactOfficialCompanyName",
      "initials": "EOCN",
      "confidence": "high|medium|low",
      "correction": "explanation if changed, or null"
    }
  ]
}

IMPORTANT: Only change answers you are CONFIDENT are wrong. If unsure, keep the original answer.`;
}

// Stage 3: Parse constraints into structured format
function constraintParsingPrompt(constraints) {
    return `Parse these constraints into structured JSON. You can ONLY fill in values you can determine directly from the constraint text itself.

## CONSTRAINTS
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

## RULES
- For word_count: extract the exact number → value = number
- For forbidden_letter: extract the letter → value = "letter"  
- For must_include where the exact literal text is given: value = "exact text"
- For must_include that REFERENCES a question (e.g. "headquarters city of company from Q8"): value = null (needs computation)
- For acrostic where exact letters are given: value = "LETTERS"
- For acrostic that REFERENCES questions/initials: value = null (needs computation)
- For any constraint requiring math or data lookup: value = null

## RESPONSE FORMAT (JSON)
{
  "parsed": [
    { "index": 1, "type": "word_count", "value": 19 },
    { "index": 2, "type": "must_include", "value": null, "needs_computation": true, "description": "headquarters city of Q8 answer" },
    { "index": 3, "type": "must_include", "value": null, "needs_computation": true, "description": "CEO last name of Q3 answer" },
    { "index": 4, "type": "must_include", "value": null, "needs_computation": true, "description": "HQ country of Q6 answer" },
    { "index": 5, "type": "must_include", "value": null, "needs_computation": true, "description": "nextPrime math" },
    { "index": 6, "type": "must_include", "value": null, "needs_computation": true, "description": "equation A+B=C" },
    { "index": 7, "type": "acrostic", "value": null, "needs_computation": true, "description": "initials from answers" },
    { "index": 8, "type": "forbidden_letter", "value": "x" }
  ]
}

Types: word_count, acrostic, forbidden_letter, must_include, must_not_include, starts_with, ends_with, prime, mod, other
CRITICAL: Set value = null for ANY constraint that references question answers, company data, or requires mathematical computation. Do NOT put placeholder text or raw constraint text as the value.`;
}

// Stage 3.5: Pre-compute all constraint values (SELF-CONTAINED — reads document directly)
function computationPrompt(doc, answers, constraints, parsedConstraints) {
    return `You are a COMPUTATION agent. Read the document and compute EXACT values for each constraint.

## YOUR ANSWERS (company names that answered each question)
${answers.map((a, i) => `Q${i + 1}: ${a.answer} (initials: ${a.initials || getInitials(a.answer)})`).join('\n')}

## DOCUMENT (search this for company details)
${doc}

## CONSTRAINTS TO RESOLVE
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

## STEP-BY-STEP INSTRUCTIONS

For EACH constraint, you must:

1. **Word count** → Just note the required count
2. **"headquarters city of company from Question X"** → Find Q{X}'s answer company name above → search the document for that company → find where it says their HQ/headquarters → extract the CITY name
3. **"CEO's last name of company from Question X"** → Find Q{X}'s answer → search document for that company's CEO → extract LAST NAME only
4. **"headquarters country of company from Question X"** → Same lookup → extract COUNTRY name
5. **"nextPrime((employees of QX answer mod 100) + 11)"** → Find Q{X}'s answer company → search doc for employee count → compute: (employees % 100) + 11 → find next prime ≥ that number
6. **"equation A+B=C where A=((Q1 revenue of QX answer mod 90)+10), B=..."** → Look up each company's revenue in the document → extract the numeric value → compute A, B, C
7. **"FIRST 8 LETTERS OF (INITIALS(Q8)+INITIALS(Q3)+...)"** → Get initials of each answer company → concatenate → take first 8 → UPPERCASE
8. **Forbidden letter** → Note which letter is forbidden
9. **Acrostic** → Compute the required first letters

## PRIME NUMBERS FOR REFERENCE
11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109,113

## CRITICAL: Revenue parsing
- "$4.2 billion" = 4200000000 (4.2 × 10^9)
- "$850 million" = 850000000
- When doing "revenue mod 90", use the value in MILLIONS (e.g. 4200 for $4.2B)

## RESPONSE FORMAT (JSON)
{
  "computations": [
    { "constraint_index": 1, "type": "word_count", "required_value": "19", "work": "Constraint says 19 words" },
    { "constraint_index": 2, "type": "must_include", "required_value": "Tokyo", "work": "Q8=CompanyX. Document says CompanyX HQ is in Tokyo." },
    { "constraint_index": 3, "type": "must_include", "required_value": "Smith", "work": "Q3=CompanyY. Document says CEO is John Smith. Last name: Smith" },
    { "constraint_index": 5, "type": "must_include", "required_value": "47", "work": "Q8=CompanyX, employees=8350. 8350%100=50. 50+11=61. nextPrime(61)=61. Answer: 61" },
    { "constraint_index": 6, "type": "must_include", "required_value": "42+38=80", "work": "A=((4200%90)+10)=(60+10)=70. B=..." },
    { "constraint_index": 7, "type": "acrostic", "required_value": "ABCDEFGH", "work": "Q8=CX(initials CX), Q3=CY... Combined: CXCY... First 8: ABCDEFGH" }
  ],
  "target_word_count": 19,
  "acrostic_letters": "ABCDEFGH",
  "forbidden_letters": ["x"],
  "must_include_values": ["Tokyo", "Smith", "Japan", "47", "42+38=80"]
}

SHOW ALL WORK. Every value must be computed from the document. Do NOT guess or use MISSING_DATA.`;
}

// Stage 4: Build artifact using pre-computed values
function artifactBuildPrompt(questions, answers, constraints, parsedConstraints, solveInstructions, previousAttempt, validationErrors, proposal, companyData, computedValues) {
    let prompt = `You are an artifact builder. Generate a SINGLE LINE string that satisfies ALL constraints.

## PRE-COMPUTED VALUES (use these EXACTLY)
`;

    if (computedValues) {
        if (computedValues.target_word_count) prompt += `Target word count: ${computedValues.target_word_count}\n`;
        if (computedValues.acrostic_letters) prompt += `Acrostic (first letter of each word must spell): ${computedValues.acrostic_letters}\n`;
        if (computedValues.forbidden_letters?.length) prompt += `Forbidden letters (NEVER use): ${computedValues.forbidden_letters.join(', ')}\n`;
        if (computedValues.must_include_values?.length) prompt += `Must include these EXACT values: ${computedValues.must_include_values.join(' | ')}\n`;

        prompt += `\nDetailed computations:\n`;
        for (const comp of (computedValues.computations || [])) {
            prompt += `C${comp.constraint_index}: ${comp.type} → "${comp.required_value}" (${comp.work})\n`;
        }
    }

    prompt += `
## ANSWERS
${answers.map((a, i) => `Q${i + 1}: ${a.answer}${a.initials ? ` (${a.initials})` : ''}`).join('\n')}

## CONSTRAINTS (must ALL be satisfied)
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}
`;

    if (solveInstructions) {
        prompt += `\n## SOLVE INSTRUCTIONS\n${solveInstructions}\n`;
    }

    if (previousAttempt && validationErrors) {
        prompt += `\n## ⚠ PREVIOUS ATTEMPT FAILED — FIX THESE:
Previous artifact: "${previousAttempt}"
Errors:
${validationErrors.map(e => `✖ ${e}`).join('\n')}

Carefully fix each error while maintaining ALL other constraints.\n`;
    }

    if (proposal) {
        prompt += proposalSuffix(proposal);
    }

    prompt += `
## BUILDING STRATEGY
1. Start with the acrostic letters (if any) — pick words starting with each required letter
2. Embed all must_include values naturally into the words
3. Avoid ALL forbidden letters in EVERY word
4. Hit the exact word count
5. Double-check: count words, verify first letters spell the acrostic, check all must_include values are present, confirm no forbidden letters

## OUTPUT
Your response must be exactly one line — the artifact string and nothing else. Do NOT output "Q1:", "Looking at", "Let me", "First", "Answer:", or any reasoning. Do NOT explain your process. Output ONLY the single-line artifact. No preamble. No JSON. Just the artifact.`;

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
    computationPrompt,
    artifactBuildPrompt,
    proposalSuffix
};
