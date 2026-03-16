// ─── API Key Encryption (AES-256-GCM) ──────────────────
// Encrypts API keys at rest in memory. Keys are only decrypted
// when needed for Bankr API calls.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

// Generate a random encryption key on server startup.
// Override with ENCRYPTION_KEY env var for persistence across restarts.
let _key;

function getKey() {
    if (_key) return _key;
    const envKey = process.env.ENCRYPTION_KEY;
    if (envKey) {
        // Env key: hex-encoded 32 bytes
        _key = Buffer.from(envKey, 'hex');
        if (_key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    } else {
        // Random key per server lifetime (sessions lost on restart anyway)
        _key = crypto.randomBytes(32);
    }
    return _key;
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded string containing IV + ciphertext + auth tag.
 */
function encrypt(plaintext) {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Pack: IV (12) + tag (16) + ciphertext
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted string.
 * Returns the original plaintext.
 */
function decrypt(packed) {
    const key = getKey();
    const buf = Buffer.from(packed, 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
