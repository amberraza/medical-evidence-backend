const crypto = require('crypto');

/**
 * Cache Service
 * In-memory caching with TTL support
 * Reduces API calls and speeds up responses
 */
class CacheService {
  constructor() {
    this.cache = new Map();
    this.enabled = process.env.CACHE_ENABLED !== 'false';
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0
    };

    // Clear expired entries every 5 minutes
    setInterval(() => this.clearExpired(), 5 * 60 * 1000);

    console.log(`Cache service initialized (${this.enabled ? 'ENABLED' : 'DISABLED'})`);
  }

  /**
   * Generate a cache key from data
   * @param {string} prefix - Key prefix
   * @param {any} data - Data to hash
   * @returns {string} Cache key
   */
  generateKey(prefix, data) {
    const hash = crypto
      .createHash('md5')
      .update(JSON.stringify(data))
      .digest('hex');
    return `${prefix}:${hash}`;
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {any|null} Cached value or null
   */
  get(key) {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if expired
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    console.log(`Cache HIT: ${key} (hit rate: ${this.getHitRate()}%)`);
    return entry.value;
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   */
  set(key, value, ttl = 3600) {
    if (!this.enabled) return;

    const expiresAt = ttl > 0 ? Date.now() + (ttl * 1000) : null;

    this.cache.set(key, {
      value,
      expiresAt,
      createdAt: Date.now()
    });

    this.stats.sets++;
    console.log(`Cache SET: ${key} (TTL: ${ttl}s, size: ${this.cache.size})`);
  }

  /**
   * Delete value from cache
   * @param {string} key - Cache key
   */
  delete(key) {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    console.log('Cache cleared');
  }

  /**
   * Clear expired entries
   */
  clearExpired() {
    const now = Date.now();
    let cleared = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(key);
        cleared++;
      }
    }

    if (cleared > 0) {
      console.log(`Cache: Cleared ${cleared} expired entries`);
    }
  }

  /**
   * Get cache hit rate percentage
   * @returns {number} Hit rate percentage
   */
  getHitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : 0;
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.getHitRate() + '%',
      enabled: this.enabled
    };
  }

  /**
   * Cache a search query
   * @param {string} query - Search query
   * @param {Object} filters - Search filters
   * @param {Function} searchFn - Function to execute on cache miss
   * @returns {any} Search results
   */
  async cacheSearch(query, filters, searchFn) {
    const key = this.generateKey('search', { query, filters });

    // Try cache first
    let results = this.get(key);

    if (!results) {
      // Cache miss - perform search
      console.log(`Cache MISS: Executing search for "${query.substring(0, 50)}..."`);
      results = await searchFn();

      // Cache results for 24 hours
      this.set(key, results, 86400);
    }

    return results;
  }

  /**
   * Cache a Claude AI response
   * @param {string} query - User query
   * @param {Array} articles - Articles used
   * @param {Function} generateFn - Function to execute on cache miss
   * @returns {any} Claude response
   */
  async cacheClaude(query, articles, generateFn) {
    const key = this.generateKey('claude', {
      query,
      articleIds: articles.map(a => a.id || a.pmid).sort()
    });

    // Try cache first
    let response = this.get(key);

    if (!response) {
      // Cache miss - generate response
      console.log(`Cache MISS: Generating Claude response for "${query.substring(0, 50)}..."`);
      response = await generateFn();

      // Cache for 12 hours (shorter TTL for medical accuracy)
      this.set(key, response, 43200);
    }

    return response;
  }

  /**
   * Cache article metadata
   * @param {string} id - Article ID
   * @param {Object} metadata - Article metadata
   * @param {number} ttl - Time to live in seconds (default: 7 days)
   */
  cacheArticle(id, metadata, ttl = 604800) {
    const key = `article:${id}`;
    this.set(key, metadata, ttl);
  }

  /**
   * Get cached article metadata
   * @param {string} id - Article ID
   * @returns {Object|null} Article metadata or null
   */
  getCachedArticle(id) {
    const key = `article:${id}`;
    return this.get(key);
  }
}

module.exports = new CacheService();
