const axios = require('axios');

/**
 * Unpaywall Service
 * Finds free, legal full-text PDFs for research articles
 * API Docs: https://unpaywall.org/products/api
 * Rate Limit: None (just include email)
 * Coverage: 20+ million free scholarly articles
 */
class UnpaywallService {
  constructor() {
    this.baseUrl = 'https://api.unpaywall.org/v2';
    this.email = process.env.UNPAYWALL_EMAIL || 'support@medicalevidence.app';
  }

  /**
   * Check if full-text is available for a single article
   * @param {Object} article - Article object with DOI
   * @returns {Object} Article with fullTextUrl if available
   */
  async checkFullText(article) {
    // Skip if no DOI
    if (!article.doi) {
      return { ...article, fullTextAvailable: false };
    }

    try {
      const response = await axios.get(`${this.baseUrl}/${article.doi}`, {
        params: { email: this.email },
        timeout: 5000
      });

      const data = response.data;

      // Get the best open access location
      const bestOA = data.best_oa_location;

      if (bestOA) {
        const enriched = {
          ...article,
          fullTextAvailable: true,
          fullTextUrl: bestOA.url_for_pdf || bestOA.url_for_landing_page || bestOA.url,
          fullTextPdfUrl: bestOA.url_for_pdf,
          fullTextLandingUrl: bestOA.url_for_landing_page,
          openAccessType: this.getOAType(data),
          license: bestOA.license || article.license,
          isOpenAccess: data.is_oa || false,
          oaStatus: data.oa_status,
          // Additional OA locations
          allOALocations: data.oa_locations?.map(loc => ({
            url: loc.url,
            pdfUrl: loc.url_for_pdf,
            version: loc.version,
            license: loc.license,
            hostType: loc.host_type
          })) || []
        };

        console.log(`Unpaywall: Found full-text for ${article.doi} (${enriched.openAccessType})`);
        return enriched;
      } else {
        return {
          ...article,
          fullTextAvailable: false,
          isOpenAccess: false,
          oaStatus: 'closed'
        };
      }

    } catch (error) {
      // Don't fail the whole request if Unpaywall check fails
      if (error.response?.status === 404) {
        console.log(`Unpaywall: Article not found: ${article.doi}`);
      } else {
        console.warn(`Unpaywall check failed for ${article.doi}:`, error.message);
      }
      return { ...article, fullTextAvailable: false };
    }
  }

  /**
   * Check full-text availability for multiple articles
   * @param {Array} articles - Array of article objects
   * @returns {Array} Articles with fullTextUrl where available
   */
  async checkMultipleArticles(articles) {
    if (!articles || articles.length === 0) {
      return articles;
    }

    console.log(`Unpaywall: Checking ${articles.length} articles for full-text...`);

    // Process in small batches to be polite (even though there's no rate limit)
    const batchSize = 10;
    const enriched = [];

    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(article => this.checkFullText(article))
      );
      enriched.push(...batchResults);

      // Small delay between batches
      if (i + batchSize < articles.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const availableCount = enriched.filter(a => a.fullTextAvailable).length;
    const pdfCount = enriched.filter(a => a.fullTextPdfUrl).length;
    console.log(`Unpaywall: Found ${availableCount} full-text articles (${pdfCount} PDFs)`);

    return enriched;
  }

  /**
   * Determine the type of open access
   * @param {Object} data - Unpaywall response data
   * @returns {string} OA type description
   */
  getOAType(data) {
    const status = data.oa_status;
    const typeMap = {
      'gold': 'Gold OA (Published OA)',
      'hybrid': 'Hybrid OA (OA in subscription journal)',
      'bronze': 'Bronze OA (Free to read, no license)',
      'green': 'Green OA (Repository version)',
      'closed': 'Closed Access'
    };
    return typeMap[status] || status || 'Unknown';
  }

  /**
   * Get direct PDF link for a DOI
   * @param {string} doi - DOI to lookup
   * @returns {string|null} PDF URL or null
   */
  async getPdfUrl(doi) {
    try {
      const response = await axios.get(`${this.baseUrl}/${doi}`, {
        params: { email: this.email },
        timeout: 5000
      });
      return response.data.best_oa_location?.url_for_pdf || null;
    } catch (error) {
      console.warn(`Failed to get PDF URL for ${doi}:`, error.message);
      return null;
    }
  }

  /**
   * Check if article is open access
   * @param {string} doi - DOI to check
   * @returns {boolean} True if open access
   */
  async isOpenAccess(doi) {
    try {
      const response = await axios.get(`${this.baseUrl}/${doi}`, {
        params: { email: this.email },
        timeout: 5000
      });
      return response.data.is_oa || false;
    } catch (error) {
      return false;
    }
  }
}

module.exports = new UnpaywallService();
