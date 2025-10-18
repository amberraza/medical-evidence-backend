const axios = require('axios');

/**
 * CrossRef Service
 * Enriches article metadata using the free CrossRef API
 * API Docs: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 * Rate Limit: 50 requests/second (free)
 */
class CrossRefService {
  constructor() {
    this.baseUrl = 'https://api.crossref.org/works';
    this.userAgent = 'Medical Evidence App (mailto:support@medicalevidence.app)';
    this.rateLimit = 50; // requests per second
  }

  /**
   * Enrich a single article with CrossRef metadata
   * @param {Object} article - Article object with DOI
   * @returns {Object} Enriched article
   */
  async enrichArticle(article) {
    // Skip if no DOI
    if (!article.doi) {
      return article;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/${article.doi}`, {
        headers: {
          'User-Agent': this.userAgent
        },
        timeout: 5000
      });

      const data = response.data.message;

      // Enrich with CrossRef data
      const enriched = {
        ...article,
        citationCount: data['is-referenced-by-count'] || article.citationCount || 0,
        // Add abstract if missing and available
        abstract: article.abstract || this.extractAbstract(data),
        // Add publisher info
        publisher: data.publisher || article.publisher,
        // Add license info
        license: data.license ? data.license[0]?.URL : null,
        // Add funding info
        funding: data.funder?.map(f => f.name).join(', ') || null,
        // Add ORCID IDs if available
        orcids: this.extractOrcids(data),
        // Add full-text links if available
        fullTextLinks: data.link?.map(link => ({
          url: link.URL,
          contentType: link['content-type'],
          intendedApplication: link['intended-application']
        })) || []
      };

      console.log(`CrossRef enriched article ${article.doi}: +${enriched.citationCount} citations`);
      return enriched;

    } catch (error) {
      // Don't fail the whole request if CrossRef enrichment fails
      if (error.response?.status === 404) {
        console.log(`CrossRef: DOI not found: ${article.doi}`);
      } else {
        console.warn(`CrossRef enrichment failed for ${article.doi}:`, error.message);
      }
      return article;
    }
  }

  /**
   * Enrich multiple articles in parallel
   * @param {Array} articles - Array of article objects
   * @returns {Array} Enriched articles
   */
  async enrichArticles(articles) {
    if (!articles || articles.length === 0) {
      return articles;
    }

    console.log(`CrossRef: Enriching ${articles.length} articles...`);

    // Process in batches to respect rate limits (50/sec)
    const batchSize = 10;
    const enriched = [];

    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(article => this.enrichArticle(article))
      );
      enriched.push(...batchResults);

      // Small delay between batches to be polite
      if (i + batchSize < articles.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const enrichedCount = enriched.filter(a => a.citationCount > 0).length;
    console.log(`CrossRef: Successfully enriched ${enrichedCount}/${articles.length} articles`);

    return enriched;
  }

  /**
   * Extract abstract from CrossRef data
   * @param {Object} data - CrossRef response data
   * @returns {string|null} Abstract text
   */
  extractAbstract(data) {
    if (!data.abstract) return null;

    // CrossRef abstracts are often in JATS XML format
    // Strip XML tags for plain text
    return data.abstract
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }

  /**
   * Extract ORCID IDs from authors
   * @param {Object} data - CrossRef response data
   * @returns {Array} Array of ORCID IDs
   */
  extractOrcids(data) {
    if (!data.author) return [];

    return data.author
      .filter(author => author.ORCID)
      .map(author => author.ORCID);
  }

  /**
   * Get citation count for a DOI
   * @param {string} doi - DOI to lookup
   * @returns {number} Citation count
   */
  async getCitationCount(doi) {
    try {
      const response = await axios.get(`${this.baseUrl}/${doi}`, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 5000
      });
      return response.data.message['is-referenced-by-count'] || 0;
    } catch (error) {
      console.warn(`Failed to get citation count for ${doi}:`, error.message);
      return 0;
    }
  }
}

module.exports = new CrossRefService();
