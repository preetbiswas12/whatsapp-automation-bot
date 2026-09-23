'use strict';

// In-memory trackers for rate limiting and duplicate suppression.

// Per-chat cooldown so the bot never spams a conversation.
class Cooldown {
  constructor(seconds) {
    this.seconds = seconds;
    this.times = new Map();
  }

  isActive(key) {
    if (!key) return false;
    const last = this.times.get(key);
    if (!last) return false;
    return (Date.now() - last) / 1000 < this.seconds;
  }

  set(key) {
    if (!key) return;
    this.times.set(key, Date.now());
  }
}

// Idempotency guard: drops webhook deliveries that were already processed.
class Deduplicator {
  constructor(ttlMs = 60_000, maxSize = 100) {
    this.ttl = ttlMs;
    this.maxSize = maxSize;
    this.seen = new Map();
  }

  has(key) {
    if (!key) return false;
    return this.seen.has(key);
  }

  add(key) {
    if (!key) return;
    this.seen.set(key, Date.now());
    if (this.seen.size > this.maxSize) this.prune();
  }

  prune() {
    const now = Date.now();
    for (const [key, ts] of this.seen) {
      if (now - ts > this.ttl) this.seen.delete(key);
    }
  }
}

module.exports = { Cooldown, Deduplicator };