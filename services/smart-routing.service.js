/**
 * Smart Routing Service
 *
 * Intelligently routes queries to the most appropriate data sources
 * based on query analysis, maximizing relevance while minimizing API calls
 */

class SmartRoutingService {
  constructor() {
    // Source priorities by query type
    this.routingRules = {
      // Clinical trials
      trial: {
        primary: ['clinicaltrials'],
        secondary: ['pubmed', 'openalex'],
        keywords: [
          'trial', 'trials', 'clinical trial', 'study protocol',
          'recruiting', 'enrollment', 'NCT', 'phase 1', 'phase 2',
          'phase 3', 'phase 4', 'randomized controlled', 'RCT',
          'intervention study', 'treatment study', 'placebo',
          'double blind', 'multicenter trial'
        ]
      },

      // Recent research / cutting edge
      recent: {
        primary: ['openalex', 'europepmc'],
        secondary: ['pubmed'],
        keywords: [
          'recent', 'latest', 'new', 'emerging', 'novel',
          'current', '2024', '2025', 'up to date',
          'breakthrough', 'advancement', 'innovation'
        ]
      },

      // Meta-analysis / systematic reviews (high-quality evidence)
      synthesis: {
        primary: ['pubmed', 'europepmc'],
        secondary: ['openalex'],
        keywords: [
          'meta-analysis', 'systematic review', 'cochrane',
          'evidence synthesis', 'pooled analysis', 'literature review',
          'consensus', 'guideline', 'best practice'
        ]
      },

      // Drug/medication specific
      drug: {
        primary: ['pubmed', 'clinicaltrials'],
        secondary: ['europepmc', 'openalex'],
        keywords: [
          'drug', 'medication', 'pharmaceutical', 'treatment',
          'therapy', 'pharmacology', 'dosage', 'adverse effects',
          'side effects', 'contraindication', 'prescription'
        ]
      },

      // Disease/condition specific
      condition: {
        primary: ['pubmed', 'openalex'],
        secondary: ['europepmc', 'clinicaltrials'],
        keywords: [
          'disease', 'condition', 'syndrome', 'disorder',
          'pathology', 'diagnosis', 'symptoms', 'etiology',
          'epidemiology', 'prevalence', 'incidence'
        ]
      },

      // Mechanism / basic science
      mechanism: {
        primary: ['openalex', 'pubmed'],
        secondary: ['europepmc'],
        keywords: [
          'mechanism', 'pathway', 'molecular', 'cellular',
          'biochemistry', 'genetics', 'pathophysiology',
          'receptor', 'signaling', 'gene expression',
          'protein', 'enzyme', 'metabolism'
        ]
      },

      // Clinical guidelines / practice
      guidelines: {
        primary: ['pubmed'],
        secondary: ['openalex', 'europepmc'],
        keywords: [
          'guideline', 'recommendation', 'protocol',
          'clinical practice', 'standard of care',
          'treatment algorithm', 'management',
          'diagnostic criteria', 'screening'
        ]
      }
    };
  }

  /**
   * Analyze query and determine which sources to use
   * @param {string} query - User's search query
   * @returns {object} Routing decision with sources and strategy
   */
  analyzeQuery(query) {
    const lowerQuery = query.toLowerCase();
    const scores = {};

    // Score each query type based on keyword matches
    for (const [type, config] of Object.entries(this.routingRules)) {
      scores[type] = 0;

      for (const keyword of config.keywords) {
        if (lowerQuery.includes(keyword)) {
          // Longer keywords get higher scores (more specific)
          scores[type] += keyword.split(' ').length;
        }
      }
    }

    // Find the highest scoring query type
    const sortedTypes = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .filter(([, score]) => score > 0);

    // If no specific type detected, use default comprehensive search
    if (sortedTypes.length === 0) {
      return {
        queryType: 'general',
        sources: ['pubmed', 'europepmc', 'openalex'],
        strategy: 'comprehensive',
        confidence: 'low',
        reasoning: 'No specific query type detected, using all sources'
      };
    }

    // Get the best matching type
    const [bestType, bestScore] = sortedTypes[0];
    const config = this.routingRules[bestType];

    // Determine confidence based on score
    let confidence = 'medium';
    if (bestScore >= 3) confidence = 'high';
    else if (bestScore === 1) confidence = 'low';

    // Always include both primary and secondary sources for reliability
    // Even with high confidence, we want comprehensive results
    const sources = [...config.primary, ...config.secondary];

    return {
      queryType: bestType,
      sources: [...new Set(sources)], // Remove duplicates
      strategy: 'balanced',
      confidence,
      reasoning: `Detected ${bestType} query (score: ${bestScore}), using ${sources.join(', ')}`,
      alternativeTypes: sortedTypes.slice(1, 3).map(([type]) => type)
    };
  }

  /**
   * Get search strategy for each source
   * @param {string} queryType - The detected query type
   * @returns {object} Search parameters for each source
   */
  getSearchStrategies(queryType) {
    const strategies = {
      trial: {
        clinicaltrials: { limit: 15, primary: true },
        pubmed: { limit: 10, filters: { studyType: 'clinical_trial' } },
        openalex: { limit: 5, type: 'article' }
      },
      recent: {
        openalex: { limit: 15, sort: 'publication_date:desc', yearFrom: new Date().getFullYear() - 2, primary: true },
        europepmc: { limit: 10, primary: true },
        pubmed: { limit: 5 }
      },
      synthesis: {
        pubmed: { limit: 15, filters: { studyType: 'meta_analysis,systematic_review' }, primary: true },
        europepmc: { limit: 10, primary: true },
        openalex: { limit: 5 }
      },
      drug: {
        pubmed: { limit: 12, primary: true },
        clinicaltrials: { limit: 8, primary: true },
        europepmc: { limit: 5 },
        openalex: { limit: 5 }
      },
      condition: {
        pubmed: { limit: 12, primary: true },
        openalex: { limit: 10, primary: true },
        europepmc: { limit: 5 },
        clinicaltrials: { limit: 3 }
      },
      mechanism: {
        openalex: { limit: 15, medicalOnly: true, primary: true },
        pubmed: { limit: 10, primary: true },
        europepmc: { limit: 5 }
      },
      guidelines: {
        pubmed: { limit: 15, primary: true },
        openalex: { limit: 8 },
        europepmc: { limit: 7 }
      },
      general: {
        pubmed: { limit: 10, primary: true },
        europepmc: { limit: 8, primary: true },
        openalex: { limit: 7 }
      }
    };

    return strategies[queryType] || strategies.general;
  }

  /**
   * Determine optimal source combination for a query
   * @param {string} query - Search query
   * @returns {object} Complete routing plan
   */
  route(query) {
    const analysis = this.analyzeQuery(query);
    const strategies = this.getSearchStrategies(analysis.queryType);

    // Build execution plan
    const plan = {
      ...analysis,
      execution: []
    };

    for (const source of analysis.sources) {
      if (strategies[source]) {
        plan.execution.push({
          source,
          ...strategies[source]
        });
      }
    }

    // Sort by primary sources first
    plan.execution.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));

    console.log('Smart Routing Decision:');
    console.log(`  Query Type: ${analysis.queryType} (${analysis.confidence} confidence)`);
    console.log(`  Strategy: ${analysis.strategy}`);
    console.log(`  Sources: ${analysis.sources.join(', ')}`);
    console.log(`  Reasoning: ${analysis.reasoning}`);

    return plan;
  }

  /**
   * Check if a source should be included based on user filters
   * @param {string} source - Source name
   * @param {object} userFilters - User-provided filters
   * @returns {boolean}
   */
  shouldIncludeSource(source, userFilters = {}) {
    // If user explicitly selected sources, respect that
    if (userFilters.sources && Array.isArray(userFilters.sources)) {
      return userFilters.sources.includes(source);
    }

    // If user filtered by study type, adjust sources
    if (userFilters.studyType === 'clinical_trial') {
      return ['clinicaltrials', 'pubmed'].includes(source);
    }

    return true; // Include by default
  }

  /**
   * Get recommended sources for a query
   * (Can be shown to user for transparency)
   */
  getRecommendation(query) {
    const analysis = this.analyzeQuery(query);

    return {
      primary: this.routingRules[analysis.queryType]?.primary || ['pubmed'],
      all: analysis.sources,
      reason: analysis.reasoning,
      confidence: analysis.confidence
    };
  }
}

module.exports = new SmartRoutingService();
