// ─── Prompt Templates ───────────────────────────────────
// Advanced prompts for multi-stage BOTCOIN mining challenge solving.
// Designed for high solve rates with complex constraint satisfaction.

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
    return `Parse these constraints into structured JSON for programmatic validation.

## CONSTRAINTS
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

## CONSTRAINT TYPES
- word_count: exact number of words required
- acrostic: first letter of each word must spell something
- forbidden_letter: a letter that must NOT appear anywhere
- must_include: an exact phrase/value that must appear in the artifact
- must_not_include: something that must NOT appear
- starts_with: artifact must start with specific text
- ends_with: artifact must end with specific text
- prime: word count or some value must be prime
- mod: modular arithmetic constraint
- other: anything else

## RESPONSE FORMAT (JSON)
{
  "parsed": [
    { "index": 1, "type": "word_count", "value": 19, "raw": "original constraint text" },
    { "index": 2, "type": "must_include", "value": "specific text", "description": "what must be included and why" },
    { "index": 3, "type": "acrostic", "value": "ABCDEFGH", "description": "first 8 letters of combined initials" },
    { "index": 4, "type": "forbidden_letter", "value": "x" },
    { "index": 5, "type": "must_include", "value": "computed_value", "computation": "description of math needed" }
  ]
}

IMPORTANT: For constraints that reference questions (e.g. "headquarters city of company from Question 8"), note which question is referenced so we can look up the data.`;
}

// Stage 3.5: Pre-compute all constraint values
function computationPrompt(answers, companyData, constraints, parsedConstraints) {
    let prompt = `You are a COMPUTATION agent. Your job is to calculate the EXACT values needed for each constraint.

## ANSWERS (company names from questions)
${answers.map((a, i) => `Q${i + 1}: ${a.answer} (initials: ${a.initials || '?'})`).join('\n')}

## COMPANY DATA
`;
    for (const c of (companyData || [])) {
        prompt += `${c.name}: HQ_City="${c.headquarters_city || '?'}" | HQ_Country="${c.headquarters_country || '?'}" | CEO="${c.ceo_name || '?'}" (last name: "${c.ceo_last_name || '?'}") | Employees=${c.employees || '?'} | Revenue=${c.revenue || '?'} (numeric: ${c.revenue_numeric || '?'})\n`;
    }

    prompt += `
## CONSTRAINTS
${constraints.map((c, i) => `C${i + 1}: ${c}`).join('\n')}

## PARSED CONSTRAINTS
${JSON.stringify(parsedConstraints, null, 2)}

## YOUR TASK
For EACH constraint, compute the EXACT value that must appear in the artifact. Show your work step by step.

Example computations:
- "headquarters city of company from Question 8" → Look up Q8 answer company → find its HQ city → that city name must appear
- "CEO's last name of company from Question 3" → Look up Q3 answer company → find CEO → extract last name
- "nextPrime((employees of Q8 answer mod 100) + 11)" → Get employee count → compute mod 100 → add 11 → find next prime ≥ result
- "equation A+B=C where A=((Q1 revenue mod 90)+10)" → Get Q1 answer's revenue → mod 90 → add 10 → that's A. Similarly compute B. C=A+B.
- "FIRST 8 LETTERS OF (INITIALS(Q8)+INITIALS(Q3)+INITIALS(Q6)+INITIALS(Q7))" → Get initials of each answer → concatenate → take first 8 → UPPERCASE

## PRIME NUMBER REFERENCE
Primes near common ranges: 2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109,113

## RESPONSE FORMAT (JSON)
{
  "computations": [
    {
      "constraint_index": 1,
      "type": "word_count",
      "required_value": 19,
      "work": "Constraint says exactly 19 words"
    },
    {
      "constraint_index": 2,
      "type": "must_include",
      "required_value": "Tokyo",
      "work": "Q8 answer is CompanyX. CompanyX HQ city is Tokyo."
    },
    {
      "constraint_index": 5,
      "type": "prime_number",
      "required_value": "47",
      "work": "Q8 answer CompanyX has 8350 employees. 8350 mod 100 = 50. 50 + 11 = 61. nextPrime(61) = 61. Include '61'."
    },
    {
      "constraint_index": 7,
      "type": "acrostic",
      "required_value": "ABCDEFGH",
      "work": "Q8=CompanyX (initials CX), Q3=CompanyY (CY), Q6=CompanyZ (CZ), Q7=CompanyW (CW). Combined: CXCYCZCW. First 8: CXCYCZCW."
    }
  ],
  "forbidden_letters": ["x"],
  "target_word_count": 19,
  "acrostic_letters": "ABCDEFGH",
  "must_include_values": ["Tokyo", "Smith", "Japan", "47", "42+38=80"]
}

SHOW ALL WORK. Double-check every computation. These values MUST be mathematically correct.`;

    return prompt;
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
