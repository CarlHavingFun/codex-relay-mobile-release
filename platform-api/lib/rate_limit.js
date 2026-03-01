class InMemoryRateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  hit(key, { windowSeconds, limit }) {
    const now = Date.now();
    const windowMs = Math.max(1, Number(windowSeconds || 60)) * 1000;
    const max = Math.max(1, Number(limit || 10));
    const bucket = this.buckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);

    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      resetAt: new Date(bucket.resetAt).toISOString(),
      count: bucket.count,
      limit: max,
    };
  }
}

module.exports = {
  InMemoryRateLimiter,
};
