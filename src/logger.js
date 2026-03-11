// ─── Logger ─────────────────────────────────────────────
// Centralized event emitter + ring buffer for all agent logs.
// Consumed by SSE stream → browser UI.

const EventEmitter = require('events');

class Logger extends EventEmitter {
  constructor(maxEntries = 1000) {
    super();
    this.entries = [];
    this.maxEntries = maxEntries;
    this.setMaxListeners(50);
  }

  _add(level, source, message, data = null) {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      data
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.emit('log', entry);
    const icon = { info: 'ℹ', warn: '⚠', error: '✖', success: '✔', debug: '…' }[level] || '•';
    console.log(`${icon} [${source}] ${message}`);
    return entry;
  }

  info(source, msg, data)    { return this._add('info', source, msg, data); }
  warn(source, msg, data)    { return this._add('warn', source, msg, data); }
  error(source, msg, data)   { return this._add('error', source, msg, data); }
  success(source, msg, data) { return this._add('success', source, msg, data); }
  debug(source, msg, data)   { return this._add('debug', source, msg, data); }

  recent(count = 100) {
    return this.entries.slice(-count);
  }
}

module.exports = new Logger();
