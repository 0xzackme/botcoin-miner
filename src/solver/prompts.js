// ─── Prompt Templates ───────────────────────────────────
// Advanced prompts for multi-stage BOTCOIN mining challenge solving.
// Designed for high solve rates with complex constraint satisfaction.

function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
}

// Stage 1: Extract ALL company data + answer questions
function extractionPrompt(doc, companies, questions) {
    return `You are an expert data extraction agent for a complex challenge. You must be EXTREMELY precise.

## YOUR TASK
1. Read the ENTIRE document carefully
2. Extract EVERY fact about EACH company
3. Answer ALL questions using ONLY factual (non-hypothetical, non-speculative) statements

## CRITICAL RULES
- Companies use MULTIPLE names/aliases throughout the document. Track ALL of them.
- IGNORE hypothetical statements ("if", "would", "could", "might", "projected")
- IGNORE speculative/future-looking statements — use ONLY stated facts
- For multi-hop questions (e.g. "highest revenue"), you MUST compare ALL companies before answering
- Numbers must be EXACT — they are used in mathematical computations later

## DOCUMENT
${doc}

## COMPANIES (official names — answers MUST match one of these exactly)
${companies.join(', ')}

## QUESTIONS
${questions.map((q, i) => `Q${i + 1}: ${q}`).join('\n')}

## RESPONSE FORMAT (JSON)
{
  "companies": [
    {
      "name": "OfficialCompanyName",
      "aliases": ["AlternateName1", "Abbrev"],
      "headquarters_city": "CityName",
      "headquarters_country": "CountryName",
      "ceo_name": "FirstName LastName",
      "ceo_last_name": "LastName",
      "revenue": "$X.Y billion",
      "revenue_numeric": 4200000000,
      "employees": 12500,
      "founding_year": 2010,
      "industry": "tech/finance/etc",
      "facts": ["key fact 1", "key fact 2"]
    }
  ],
  "answers": [
    {
      "question": 1,
      "answer": "ExactOfficialCompanyName",
      "initials": "EOCN",
      "reasoning": "Step-by-step explanation of how you determined this answer"
    }
  ]
}

IMPORTANT:
- "answer" MUST be an exact match from the companies list above
- "initials" = first letter of each word in the official company name, UPPERCASED
- "revenue_numeric" = revenue converted to raw number (e.g. "$4.2 billion" → 4200000000)
- "employees" = raw number (e.g. "twelve thousand" → 12000)
- Extract ALL 25 companies even if some have sparse data`;
}

// Stage 2: Verify constraint-critical data with chain-of-thought
function verificationPrompt(doc, companies, questions, extractedData) {
    return `You are a VERIFICATION agent. Your job is to find and fix errors in the previous extraction.

## PREVIOUS EXTRACTION RESULTS
${JSON.stringify(extractedData.answers, null, 2)}

## COMPANY DATA EXTRACTED
${JSON.stringify((extractedData.companies || []).map(c => ({
    name: c.name, headquarters_city: c.headquarters_city, headquarters_country: c.headquarters_country,
    ceo_name: c.ceo_name, employees: c.employees, revenue: c.revenue
})), null, 2)}

## VERIFICATION CHECKLIST — Go through each one:
1. For EACH answer, re-read the document and verify the reasoning
2. For multi-hop questions (highest/lowest/most/largest), COMPARE ALL candidates
3. Check that company names match the official list EXACTLY (case-sensitive)
4. Verify HQ city, HQ country, CEO name, employee count, revenue for EACH answer company
5. Watch for RED HERRINGS: hypothetical statements, projected numbers, speculative scenarios
6. Verify aliases — make sure you attributed facts to the RIGHT company

## DOCUMENT (re-read carefully)
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
  ],
  "company_corrections": [
    {
      "name": "CompanyName",
      "field": "headquarters_city",
      "old_value": "wrong",
      "new_value": "correct",
      "evidence": "quote from document"
    }
  ]
}

Be AGGRESSIVE about corrections. It's better to fix a wrong answer than to leave it.`;
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
