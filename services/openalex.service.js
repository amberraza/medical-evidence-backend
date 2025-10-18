/**
 * OpenAlex Service
 *
 * OpenAlex is a free, open catalog of 209M+ scholarly works.
 * API: https://docs.openalex.org/
 *
 * Features:
 * - 209M+ works (articles, preprints, books, etc.)
 * - Citation counts from multiple sources
 * - Author information with affiliations
 * - Full abstracts when available
 * - Free, no API key required (polite usage)
 * - Rich metadata: concepts, institutions, funders
 */

const axios = require('axios');

class OpenAlexService {
  constructor() {
    this.baseUrl = 'https://api.openalex.org';
    this.politeEmail = process.env.OPENALEX_EMAIL || 'support@medicalevidence.app';
    this.rateLimitDelay = 100; // 10 requests/second (polite)
    this.lastRequestTime = 0;
  }

  /**
   * Rate limiting to be polite
   */
  async respectRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Search OpenAlex for works matching a query
   * @param {string} query - Search query
   * @param {object} options - Search options (limit, filters, etc.)
   * @returns {Promise<Array>} Array of articles
   */
  async searchWorks(query, options = {}) {
    try {
      await this.respectRateLimit();

      const params = {
        mailto: this.politeEmail,
        search: query,
        per_page: options.limit || 20,
        page: options.page || 1,
        sort: options.sort || 'cited_by_count:desc',
        filter: this.buildFilters(options)
      };

      // Remove empty filter
      if (!params.filter) delete params.filter;

      console.log(`OpenAlex: Searching for "${query}"...`);

      const response = await axios.get(`${this.baseUrl}/works`, {
        params,
        timeout: 10000
      });

      const works = response.data.results || [];
      console.log(`OpenAlex: Found ${works.length} works`);

      return works.map(work => this.normalizeWork(work));
    } catch (error) {
      console.error('OpenAlex search error:', error.message);
      return [];
    }
  }

  /**
   * Build filter string for OpenAlex API
   */
  buildFilters(options) {
    const filters = [];

    // Filter by publication year
    if (options.yearFrom || options.yearTo) {
      const from = options.yearFrom || 1900;
      const to = options.yearTo || new Date().getFullYear();
      filters.push(`publication_year:${from}-${to}`);
    }

    // Filter by open access status
    if (options.openAccessOnly) {
      filters.push('is_oa:true');
    }

    // Filter by type (articles, reviews, etc.)
    if (options.type) {
      filters.push(`type:${options.type}`);
    }

    // Filter by medical/health concepts
    if (options.medicalOnly) {
      // OpenAlex concept IDs for medicine and health sciences
      filters.push('concepts.id:C71924100|C86803240'); // Medicine | Health
    }

    return filters.length > 0 ? filters.join(',') : null;
  }

  /**
   * Normalize OpenAlex work to our article format
   */
  normalizeWork(work) {
    // Extract PMID if available
    let pmid = null;
    const pmidMatch = work.ids?.pmid?.match(/(\d+)$/);
    if (pmidMatch) pmid = pmidMatch[1];

    // Extract DOI
    const doi = work.doi?.replace('https://doi.org/', '') || null;

    // Build URL (prefer DOI, fallback to OpenAlex URL)
    let url = work.doi || `https://openalex.org/${work.id.split('/').pop()}`;

    // Extract authors
    const authors = work.authorships
      ?.map(a => a.author?.display_name)
      .filter(Boolean)
      .join(', ') || 'Unknown';

    // Extract journal/source
    const journal = work.primary_location?.source?.display_name ||
                    work.host_venue?.display_name ||
                    'Unknown';

    // Extract year
    const year = work.publication_year || 'Unknown';

    // Extract abstract (if available)
    const abstract = work.abstract_inverted_index
      ? this.reconstructAbstract(work.abstract_inverted_index)
      : null;

    // Extract concepts (topics/keywords)
    const concepts = work.concepts
      ?.slice(0, 5)
      .map(c => c.display_name) || [];

    // Open access status
    const isOpenAccess = work.open_access?.is_oa || false;
    const oaUrl = work.open_access?.oa_url || null;

    return {
      pmid,
      doi,
      title: work.title || 'No title',
      authors,
      journal,
      year,
      abstract,
      url,
      source: 'OpenAlex',

      // OpenAlex-specific enrichment
      citationCount: work.cited_by_count || 0,
      isOpenAccess,
      oaUrl,
      concepts,

      // Additional metadata
      type: work.type || 'article',
      publisher: work.primary_location?.source?.host_organization_name || null,

      // For UI display
      fullTextAvailable: isOpenAccess && !!oaUrl,
      fullTextUrl: oaUrl,

      // Quality indicators
      citedByPercentile: work.cited_by_percentile_year?.max || null
    };
  }

  /**
   * Reconstruct abstract from inverted index
   * OpenAlex stores abstracts in inverted index format for efficiency
   */
  reconstructAbstract(invertedIndex) {
    try {
      // Create array to hold words at their positions
      const words = [];

      // Fill array with words at correct positions
      for (const [word, positions] of Object.entries(invertedIndex)) {
        positions.forEach(pos => {
          words[pos] = word;
        });
      }

      // Join words and return
      return words.filter(Boolean).join(' ').substring(0, 2000); // Limit length
    } catch (error) {
      console.error('Error reconstructing abstract:', error.message);
      return null;
    }
  }

  /**
   * Get a single work by ID (OpenAlex ID, DOI, or PMID)
   */
  async getWork(id) {
    try {
      await this.respectRateLimit();

      let workId = id;

      // Handle different ID formats
      if (id.startsWith('10.')) {
        // DOI
        workId = `https://doi.org/${id}`;
      } else if (/^\d+$/.test(id)) {
        // PMID
        workId = `https://pubmed.ncbi.nlm.nih.gov/${id}`;
      } else if (!id.startsWith('W')) {
        // OpenAlex ID without prefix
        workId = `W${id}`;
      }

      const response = await axios.get(`${this.baseUrl}/works/${workId}`, {
        params: { mailto: this.politeEmail },
        timeout: 10000
      });

      return this.normalizeWork(response.data);
    } catch (error) {
      console.error('OpenAlex getWork error:', error.message);
      return null;
    }
  }

  /**
   * Enrich existing articles with OpenAlex data
   * (primarily for citation counts and concepts)
   */
  async enrichArticles(articles) {
    console.log(`OpenAlex: Enriching ${articles.length} articles...`);

    const enriched = [];

    for (const article of articles) {
      try {
        // Try to find work by DOI or PMID
        const identifier = article.doi || article.pmid;
        if (!identifier) {
          enriched.push(article);
          continue;
        }

        const openAlexWork = await this.getWork(identifier);

        if (openAlexWork) {
          // Merge OpenAlex data with existing article
          enriched.push({
            ...article,
            citationCount: openAlexWork.citationCount || article.citationCount,
            concepts: openAlexWork.concepts,
            citedByPercentile: openAlexWork.citedByPercentile,
            // Only override if article doesn't have OA info
            isOpenAccess: article.isOpenAccess || openAlexWork.isOpenAccess,
            oaUrl: article.oaUrl || openAlexWork.oaUrl
          });
          console.log(`OpenAlex enriched: ${article.title.substring(0, 60)}... (+${openAlexWork.citationCount} citations)`);
        } else {
          enriched.push(article);
        }
      } catch (error) {
        console.error(`Error enriching article: ${error.message}`);
        enriched.push(article);
      }
    }

    console.log(`OpenAlex: Enriched ${enriched.filter(a => a.concepts).length}/${articles.length} articles`);
    return enriched;
  }

  /**
   * Search specifically for medical/health articles
   */
  async searchMedical(query, options = {}) {
    return this.searchWorks(query, {
      ...options,
      medicalOnly: true
    });
  }

  /**
   * Search for highly cited articles
   */
  async searchHighImpact(query, options = {}) {
    return this.searchWorks(query, {
      ...options,
      sort: 'cited_by_count:desc',
      limit: options.limit || 10
    });
  }

  /**
   * Search for recent articles
   */
  async searchRecent(query, options = {}) {
    const currentYear = new Date().getFullYear();
    return this.searchWorks(query, {
      ...options,
      yearFrom: options.yearFrom || currentYear - 2,
      sort: 'publication_date:desc'
    });
  }
}

module.exports = new OpenAlexService();
