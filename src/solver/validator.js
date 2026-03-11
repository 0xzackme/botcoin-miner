// ─── Programmatic Constraint Validator ───────────────────
// Validates artifact strings locally BEFORE submitting to
// coordinator. Catches errors early and enables retry with
// specific feedback.

const log = require('../logger');

// ─── Validation functions ───────────────────────────────

function countWords(text) {
    return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function isPrime(n) {
    if (n < 2) return false;
    if (n === 2 || n === 3) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    for (let i = 5; i * i <= n; i += 6) {
        if (n % i === 0 || n % (i + 2) === 0) return false;
    }
    return true;
}

function getAcrostic(text) {
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    return words.map(w => w[0]).join('');
}

// ─── Validate a single parsed constraint ────────────────

function validateConstraint(artifact, constraint) {
    const errors = [];
    const type = constraint.type;

    switch (type) {
        case 'word_count': {
            const actual = countWords(artifact);
            const expected = parseInt(constraint.value);
            if (!isNaN(expected) && actual !== expected) {
                errors.push(`Word count: expected ${expected}, got ${actual}`);
            }
            break;
        }

        case 'acrostic': {
            const expected = (constraint.value || '').toUpperCase();
            const actual = getAcrostic(artifact).toUpperCase();
            if (expected && !actual.startsWith(expected)) {
                errors.push(`Acrostic: expected "${expected}", got "${actual.slice(0, expected.length)}"`);
            }
            break;
        }

        case 'forbidden_letter': {
            const letter = (constraint.value || '').toLowerCase();
            if (letter && artifact.toLowerCase().includes(letter)) {
                const count = (artifact.toLowerCase().match(new RegExp(letter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                errors.push(`Forbidden letter "${letter}" found ${count} time(s)`);
            }
            break;
        }

        case 'must_include': {
            const phrase = constraint.value || '';
            if (phrase && !artifact.toLowerCase().includes(phrase.toLowerCase())) {
                errors.push(`Must include "${phrase}" — not found`);
            }
            break;
        }

        case 'must_not_include': {
            const phrase = constraint.value || '';
            if (phrase && artifact.toLowerCase().includes(phrase.toLowerCase())) {
                errors.push(`Must NOT include "${phrase}" — found`);
            }
            break;
        }

        case 'prime': {
            const wc = countWords(artifact);
            if (!isPrime(wc)) {
                errors.push(`Word count (${wc}) must be prime — it is not`);
            }
            break;
        }

        case 'mod': {
            const wc = countWords(artifact);
            const divisor = parseInt(constraint.divisor);
            const remainder = parseInt(constraint.remainder);
            if (!isNaN(divisor) && !isNaN(remainder)) {
                const actual = wc % divisor;
                if (actual !== remainder) {
                    errors.push(`Word count ${wc} mod ${divisor} = ${actual}, expected ${remainder}`);
                }
            }
            break;
        }

        case 'starts_with': {
            const prefix = constraint.value || '';
            if (prefix && !artifact.toLowerCase().startsWith(prefix.toLowerCase())) {
                errors.push(`Must start with "${prefix}"`);
            }
            break;
        }

        case 'ends_with': {
            const suffix = constraint.value || '';
            if (suffix && !artifact.toLowerCase().trimEnd().endsWith(suffix.toLowerCase())) {
                errors.push(`Must end with "${suffix}"`);
            }
            break;
        }

        default:
            // 'other' type — cannot validate programmatically
            break;
    }

    return errors;
}

// ─── Validate artifact against all parsed constraints ───

function validate(artifact, parsedConstraints) {
    if (!parsedConstraints || !Array.isArray(parsedConstraints)) {
        return { valid: true, errors: [] };
    }

    const allErrors = [];

    for (const constraint of parsedConstraints) {
        const errors = validateConstraint(artifact, constraint);
        if (errors.length > 0) {
            allErrors.push(...errors.map(e => `[C${constraint.index}] ${e}`));
        }
    }

    const valid = allErrors.length === 0;
    if (valid) {
        log.success('validator', `All ${parsedConstraints.length} constraints passed ✔`);
    } else {
        log.warn('validator', `${allErrors.length} validation error(s): ${allErrors.join('; ')}`);
    }

    return { valid, errors: allErrors };
}

module.exports = { validate, countWords, isPrime, getAcrostic };
