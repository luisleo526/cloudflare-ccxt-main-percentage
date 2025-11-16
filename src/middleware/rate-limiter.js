/**
 * Simple rate limiter for Cloudflare Workers
 * Uses Durable Objects or KV for persistence
 */
export class RateLimiter {
  constructor(env, options = {}) {
    this.env = env;
    this.maxRequests = options.maxRequests || 10;
    this.windowMs = options.windowMs || 60000; // 1 minute
    this.keyPrefix = options.keyPrefix || 'rate_limit:';
  }

  /**
   * Generate rate limit key
   */
  getKey(identifier) {
    return `${this.keyPrefix}${identifier}`;
  }

  /**
   * Check if request should be rate limited
   */
  async isRateLimited(identifier) {
    if (!this.env.RATE_LIMITER) {
      // No KV namespace configured, skip rate limiting
      return false;
    }

    const key = this.getKey(identifier);
    const now = Date.now();
    
    // Get current rate limit data
    const data = await this.env.RATE_LIMITER.get(key, 'json');
    
    if (!data) {
      // First request, initialize counter
      await this.env.RATE_LIMITER.put(key, JSON.stringify({
        count: 1,
        resetAt: now + this.windowMs
      }), {
        expirationTtl: Math.max(60, Math.ceil(this.windowMs / 1000))  // Minimum 60 seconds
      });
      return false;
    }

    // Check if window has expired
    if (now >= data.resetAt) {
      // Reset counter
      await this.env.RATE_LIMITER.put(key, JSON.stringify({
        count: 1,
        resetAt: now + this.windowMs
      }), {
        expirationTtl: Math.max(60, Math.ceil(this.windowMs / 1000))  // Minimum 60 seconds
      });
      return false;
    }

    // Check if limit exceeded
    if (data.count >= this.maxRequests) {
      return true;
    }

    // Increment counter
    await this.env.RATE_LIMITER.put(key, JSON.stringify({
      count: data.count + 1,
      resetAt: data.resetAt
    }), {
      expirationTtl: Math.max(60, Math.ceil((data.resetAt - now) / 1000))  // Minimum 60 seconds
    });

    return false;
  }

  /**
   * Get rate limit headers
   */
  async getRateLimitHeaders(identifier) {
    if (!this.env.RATE_LIMITER) {
      return {};
    }

    const key = this.getKey(identifier);
    const data = await this.env.RATE_LIMITER.get(key, 'json');
    
    if (!data) {
      return {
        'X-RateLimit-Limit': this.maxRequests.toString(),
        'X-RateLimit-Remaining': this.maxRequests.toString(),
        'X-RateLimit-Reset': new Date(Date.now() + this.windowMs).toISOString()
      };
    }

    const remaining = Math.max(0, this.maxRequests - data.count);
    
    return {
      'X-RateLimit-Limit': this.maxRequests.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
      'X-RateLimit-Reset': new Date(data.resetAt).toISOString()
    };
  }
}

/**
 * Rate limiting middleware
 */
export async function withRateLimit(request, env, options = {}) {
  const limiter = new RateLimiter(env, options);
  
  // Use IP address as identifier
  const clientIP = request.headers.get('CF-Connecting-IP') || 
                   request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                   'unknown';
  
  const isLimited = await limiter.isRateLimited(clientIP);
  const headers = await limiter.getRateLimitHeaders(clientIP);
  
  if (isLimited) {
    return new Response('Rate limit exceeded', {
      status: 429,
      headers: {
        ...headers,
        'Retry-After': Math.ceil(options.windowMs / 1000).toString()
      }
    });
  }
  
  return { limited: false, headers };
}
