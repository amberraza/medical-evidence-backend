/**
 * ClinicalTrials.gov Service
 *
 * ClinicalTrials.gov is a database of clinical studies from around the world.
 * API: https://clinicaltrials.gov/data-api/api
 *
 * Features:
 * - 450,000+ registered clinical studies
 * - Trial status, phases, enrollment
 * - Conditions, interventions, outcomes
 * - Results and publications
 * - Free, no API key required
 */

const axios = require('axios');

class ClinicalTrialsService {
  constructor() {
    this.baseUrl = 'https://clinicaltrials.gov/api/v2';
    this.rateLimitDelay = 200; // 5 requests/second (conservative)
    this.lastRequestTime = 0;
  }

  /**
   * Rate limiting
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
   * Search clinical trials
   * @param {string} query - Search query (condition, intervention, etc.)
   * @param {object} options - Search options
   * @returns {Promise<Array>} Array of clinical trials
   */
  async searchTrials(query, options = {}) {
    try {
      await this.respectRateLimit();

      // Clean query: remove quotes and extract condition
      let cleanQuery = query.replace(/"/g, '').trim();

      // Extract condition from query by removing common trial-related terms
      const trialTerms = ['phase 1', 'phase 2', 'phase 3', 'phase 4', 'clinical trial', 'clinical trials', 'trial', 'trials', 'study', 'studies', 'rct', 'randomized controlled'];
      let condition = cleanQuery;

      // Remove trial terms to get the actual condition
      trialTerms.forEach(term => {
        const regex = new RegExp(term, 'gi');
        condition = condition.replace(regex, '').trim();
      });

      // Clean up extra spaces
      condition = condition.replace(/\s+/g, ' ').trim();

      const params = {
        'query.cond': options.condition || condition,
        'query.term': options.intervention || null,
        'filter.overallStatus': options.status || null,
        'filter.phase': options.phase || null,
        pageSize: options.limit || 20,
        format: 'json'
      };

      // Remove null params
      Object.keys(params).forEach(key => {
        if (params[key] === null) delete params[key];
      });

      console.log(`ClinicalTrials: Searching for condition="${params['query.cond']}" (original: "${query}")...`);

      const response = await axios.get(`${this.baseUrl}/studies`, {
        params,
        timeout: 15000
      });

      const studies = response.data.studies || [];
      console.log(`ClinicalTrials: Found ${studies.length} trials`);

      return studies.map(study => this.normalizeTrial(study));
    } catch (error) {
      console.error('ClinicalTrials search error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data).substring(0, 200));
      }
      return [];
    }
  }

  /**
   * Normalize trial data to our format
   */
  normalizeTrial(study) {
    const proto = study.protocolSection || {};
    const ident = proto.identificationModule || {};
    const status = proto.statusModule || {};
    const design = proto.designModule || {};
    const sponsor = proto.sponsorCollaboratorsModule || {};
    const desc = proto.descriptionModule || {};
    const conditions = proto.conditionsModule || {};
    const interventions = proto.armsInterventionsModule || {};
    const outcomes = proto.outcomesModule || {};
    const eligibility = proto.eligibilityModule || {};

    // Extract NCT ID
    const nctId = ident.nctId || 'Unknown';

    // Extract title
    const title = ident.briefTitle || ident.officialTitle || 'No title';

    // Extract status
    const overallStatus = status.overallStatus || 'Unknown';
    const lastUpdate = status.lastUpdatePostDateStruct?.date || 'Unknown';

    // Extract phase
    const phases = design.phases || [];
    const phase = phases.join(', ') || 'N/A';

    // Extract conditions
    const conditionsList = conditions.conditions || [];

    // Extract interventions
    const interventionsList = interventions.interventions?.map(i => i.name) || [];

    // Extract enrollment
    const enrollment = design.enrollmentInfo?.count || 0;

    // Extract sponsor
    const leadSponsor = sponsor.leadSponsor?.name || 'Unknown';

    // Extract description
    const briefSummary = desc.briefSummary || '';
    const detailedDescription = desc.detailedDescription || '';
    const abstract = briefSummary || detailedDescription.substring(0, 500);

    // Extract outcomes
    const primaryOutcomes = outcomes.primaryOutcomes?.map(o => o.measure) || [];

    // Build URL
    const url = `https://clinicaltrials.gov/study/${nctId}`;

    // Determine if trial has results
    const hasResults = !!study.resultsSection;

    // Extract study type
    const studyType = design.studyType || 'Interventional';

    // Extract start/completion dates
    const startDate = status.startDateStruct?.date || null;
    const completionDate = status.completionDateStruct?.date || status.primaryCompletionDateStruct?.date || null;

    // Extract publications (if available)
    const publications = study.derivedSection?.references?.map(ref => ({
      pmid: ref.pmid,
      citation: ref.citation
    })) || [];

    return {
      // Standard fields
      nctId,
      title,
      abstract,
      url,
      source: 'ClinicalTrials.gov',
      type: 'clinical-trial',

      // Trial-specific fields
      status: overallStatus,
      phase,
      studyType,
      enrollment,
      conditions: conditionsList,
      interventions: interventionsList,
      primaryOutcomes,
      leadSponsor,
      hasResults,

      // Dates
      startDate,
      completionDate,
      lastUpdate,

      // Publications
      publications,
      publicationCount: publications.length,

      // For UI compatibility
      journal: `ClinicalTrials.gov (${phase})`,
      year: startDate ? new Date(startDate).getFullYear() : 'Unknown',
      authors: leadSponsor,

      // Quality indicators
      qualityTags: this.generateQualityTags(overallStatus, phase, hasResults, enrollment)
    };
  }

  /**
   * Generate quality tags for trials
   */
  generateQualityTags(status, phase, hasResults, enrollment) {
    const tags = [];

    // Phase tags
    if (phase.includes('PHASE4')) {
      tags.push({ icon: '🏆', label: 'Phase 4', color: 'violet' });
    } else if (phase.includes('PHASE3')) {
      tags.push({ icon: '📊', label: 'Phase 3', color: 'emerald' });
    } else if (phase.includes('PHASE2')) {
      tags.push({ icon: '🔬', label: 'Phase 2', color: 'cyan' });
    } else if (phase.includes('PHASE1')) {
      tags.push({ icon: '🧪', label: 'Phase 1', color: 'sky' });
    }

    // Status tags
    if (status === 'COMPLETED') {
      tags.push({ icon: '✅', label: 'Completed', color: 'emerald' });
    } else if (status === 'RECRUITING' || status === 'ACTIVE_NOT_RECRUITING') {
      tags.push({ icon: '🔄', label: 'Active', color: 'lime' });
    }

    // Results availability
    if (hasResults) {
      tags.push({ icon: '📈', label: 'Results Available', color: 'violet' });
    }

    // Enrollment size
    if (enrollment > 1000) {
      tags.push({ icon: '👥', label: `Large (n=${enrollment})`, color: 'amber' });
    } else if (enrollment > 100) {
      tags.push({ icon: '👥', label: `n=${enrollment}`, color: 'sky' });
    }

    return tags;
  }

  /**
   * Get a single trial by NCT ID
   */
  async getTrial(nctId) {
    try {
      await this.respectRateLimit();

      console.log(`ClinicalTrials: Fetching trial ${nctId}...`);

      const response = await axios.get(`${this.baseUrl}/studies/${nctId}`, {
        params: { format: 'json' },
        timeout: 10000
      });

      if (response.data.studies && response.data.studies.length > 0) {
        return this.normalizeTrial(response.data.studies[0]);
      }

      return null;
    } catch (error) {
      console.error(`ClinicalTrials getTrial error: ${error.message}`);
      return null;
    }
  }

  /**
   * Search for trials by condition
   */
  async searchByCondition(condition, options = {}) {
    return this.searchTrials(condition, {
      ...options,
      condition
    });
  }

  /**
   * Search for trials by intervention (drug, device, etc.)
   */
  async searchByIntervention(intervention, options = {}) {
    return this.searchTrials('', {
      ...options,
      intervention
    });
  }

  /**
   * Search for completed trials with results
   */
  async searchCompletedWithResults(query, options = {}) {
    return this.searchTrials(query, {
      ...options,
      status: 'COMPLETED'
    });
  }

  /**
   * Search for Phase 3/4 trials (most relevant for clinical practice)
   */
  async searchLatePhaseTrias(query, options = {}) {
    return this.searchTrials(query, {
      ...options,
      phase: 'PHASE3|PHASE4'
    });
  }

  /**
   * Search for recruiting trials (for patient recruitment)
   */
  async searchRecruitingTrials(query, options = {}) {
    return this.searchTrials(query, {
      ...options,
      status: 'RECRUITING'
    });
  }

  /**
   * Check if query is likely asking about clinical trials
   */
  isTrialQuery(query) {
    const trialKeywords = [
      'trial', 'trials', 'clinical trial', 'study',
      'recruiting', 'enrollment', 'NCT',
      'phase 1', 'phase 2', 'phase 3', 'phase 4',
      'randomized controlled', 'RCT',
      'intervention study', 'treatment study'
    ];

    const lowerQuery = query.toLowerCase();
    return trialKeywords.some(keyword => lowerQuery.includes(keyword));
  }
}

module.exports = new ClinicalTrialsService();
