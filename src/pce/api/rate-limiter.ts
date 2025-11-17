export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  scope?: "global" | "ip";
}

class SlidingWindowRateLimiter {
  private hits: Map<string, number[]> = new Map();
  private windowMs: number;
  private max: number;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.max = config.max;
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const entries = this.hits.get(key) || [];

    const recentEntries = entries.filter((timestamp) => timestamp > windowStart);
    if (recentEntries.length >= this.max) {
      const retryAfterMs = recentEntries[0] + this.windowMs - now;
      this.hits.set(key, recentEntries);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    recentEntries.push(now);
    this.hits.set(key, recentEntries);
    return { allowed: true };
  }
}

export class ApiRateLimiter {
  private globalLimiter: SlidingWindowRateLimiter;
  private perIpLimiter: SlidingWindowRateLimiter;
  private globalKey = "__global__";

  constructor(globalConfig: RateLimitConfig, perIpConfig: RateLimitConfig) {
    this.globalLimiter = new SlidingWindowRateLimiter(globalConfig);
    this.perIpLimiter = new SlidingWindowRateLimiter(perIpConfig);
  }

  check(ip: string): RateLimitResult {
    const globalResult = this.globalLimiter.check(this.globalKey);
    if (!globalResult.allowed) {
      return { ...globalResult, scope: "global" };
    }

    const perIpResult = this.perIpLimiter.check(ip);
    if (!perIpResult.allowed) {
      return { ...perIpResult, scope: "ip" };
    }

    return { allowed: true };
  }
}
