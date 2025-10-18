const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
require('dotenv').config();

// Import new services
const cacheService = require('./services/cache.service');
const crossrefService = require('./services/crossref.service');
const unpaywallService = require('./services/unpaywall.service');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(cors());
// Increase JSON payload limit to handle enriched articles with citations, PDFs, funding, etc.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Retry utility with exponential backoff
const retryWithBackoff = async (fn, maxRetries = 3, initialDelay = 1000) => {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on client errors (4xx) except 429 (rate limit)
      if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries - 1) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms delay`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Medical Evidence API is running' });
});

// Cache statistics endpoint
app.get('/api/cache/stats', (req, res) => {
  const stats = cacheService.getStats();
  res.json({
    status: 'ok',
    cache: stats,
    message: `Cache is ${stats.enabled ? 'enabled' : 'disabled'} with ${stats.hitRate} hit rate`
  });
});

// Clear cache endpoint (for testing/debugging)
app.post('/api/cache/clear', (req, res) => {
  cacheService.clear();
  res.json({ status: 'ok', message: 'Cache cleared successfully' });
});

// Search PubMed endpoint
app.post('/api/search-pubmed', async (req, res) => {
  try {
    const { query, filters } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Try cache first
    const cachedResults = await cacheService.cacheSearch(query, filters, async () => {
      // If cache miss, perform the search below
      return await performPubMedSearch(query, filters);
    });

    return res.json({ articles: cachedResults });

  } catch (error) {
    console.error('PubMed search error:', error.message);
    let statusCode = 500;
    let errorMessage = 'Failed to search PubMed';
    let retryable = true;

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = 'PubMed request timed out. Please try again.';
      retryable = true;
    } else if (error.response?.status === 429) {
      errorMessage = 'Too many requests. Please wait a moment and try again.';
      statusCode = 429;
      retryable = true;
    } else if (error.response?.status >= 400 && error.response?.status < 500) {
      errorMessage = 'Invalid search query. Please try a different search.';
      statusCode = error.response.status;
      retryable = false;
    }

    res.status(statusCode).json({
      error: errorMessage,
      retryable: retryable
    });
  }
});

// Extracted search function for caching
async function performPubMedSearch(query, filters) {
  try {

    console.log('Original query:', query, '(length:', query.length, 'chars)');

    // Truncate very long queries to avoid URL length issues with PubMed GET requests
    // PubMed URLs have a ~2000 character limit, and we need room for filters too
    let searchQuery = query;
    const MAX_QUERY_LENGTH = 300;

    if (searchQuery.length > MAX_QUERY_LENGTH) {
      console.warn('Query too long, truncating from', searchQuery.length, 'to', MAX_QUERY_LENGTH, 'chars');
      // Try to truncate at a word boundary
      searchQuery = searchQuery.substring(0, MAX_QUERY_LENGTH);
      const lastSpace = searchQuery.lastIndexOf(' ');
      if (lastSpace > MAX_QUERY_LENGTH * 0.8) { // Only trim to word if we're not losing too much
        searchQuery = searchQuery.substring(0, lastSpace);
      }
      searchQuery = searchQuery.trim();
      console.log('Truncated query:', searchQuery);
    }

    console.log('Searching PubMed with filters:', filters);

    // Use query as-is - PubMed's ranking algorithm is already good
    // We'll do relevance scoring on the client side
    let searchTerm = searchQuery;

    // Add date range filter
    if (filters?.dateRange && filters.dateRange !== 'all') {
      const dateFilters = {
        '1year': '1',
        '5years': '5',
        '10years': '10'
      };
      if (dateFilters[filters.dateRange]) {
        searchTerm += ` AND ("last ${dateFilters[filters.dateRange]} years"[PDat])`;
      }
    }

    // Add study type filter
    if (filters?.studyType && filters.studyType !== 'all') {
      const studyTypeFilters = {
        'rct': 'Randomized Controlled Trial[ptyp]',
        'meta': 'Meta-Analysis[ptyp]',
        'review': 'Review[ptyp] OR Systematic Review[ptyp]',
        'clinical': 'Clinical Trial[ptyp]',
        'guideline': 'Guideline[ptyp] OR Practice Guideline[ptyp]'
      };
      if (studyTypeFilters[filters.studyType]) {
        searchTerm += ` AND ${studyTypeFilters[filters.studyType]}`;
      }
    }

    console.log('Final search term:', searchTerm);

    // Step 1: Search for article IDs with retry
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`;
    const searchParams = {
      db: 'pubmed',
      term: searchTerm,
      retmax: 20,
      retmode: 'json',
      sort: 'relevance',
      api_key: process.env.NCBI_API_KEY // Increases rate limit from 3 to 10 req/sec
    };

    const searchResponse = await retryWithBackoff(
      () => axios.get(searchUrl, { params: searchParams }),
      3,
      1000
    );
    const ids = searchResponse.data.esearchresult?.idlist || [];

    if (ids.length === 0) {
      return res.json({ articles: [] });
    }

    console.log('Found article IDs:', ids);

    // Step 2: Fetch article details with retry
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi`;
    const summaryParams = {
      db: 'pubmed',
      id: ids.join(','),
      retmode: 'json',
      api_key: process.env.NCBI_API_KEY
    };

    const summaryResponse = await retryWithBackoff(
      () => axios.get(summaryUrl, { params: summaryParams }),
      3,
      1000
    );
    const summaryData = summaryResponse.data.result;

    // Step 3: Fetch abstracts using efetch with retry and fallback
    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`;
    const fetchParams = {
      db: 'pubmed',
      id: ids.join(','),
      retmode: 'xml',
      rettype: 'abstract',
      api_key: process.env.NCBI_API_KEY
    };

    let abstractsMap = {};
    try {
      const fetchResponse = await retryWithBackoff(
        () => axios.get(fetchUrl, { params: fetchParams }),
        2,
        1000
      );
      const xmlData = fetchResponse.data;

      // Parse XML to extract abstracts (simple regex approach)
      ids.forEach(id => {
        const pmidRegex = new RegExp(`<PMID[^>]*>${id}</PMID>[\\s\\S]*?<Abstract>([\\s\\S]*?)</Abstract>`, 'i');
        const match = xmlData.match(pmidRegex);

        if (match) {
          // Extract text from AbstractText tags
          const abstractTextRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi;
          let abstractParts = [];
          let textMatch;

          while ((textMatch = abstractTextRegex.exec(match[1])) !== null) {
            // Remove any remaining XML tags and decode ALL HTML entities
            const cleanText = textMatch[1]
              .replace(/<[^>]+>/g, '')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
              .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec)) // Numeric entities
              .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16))) // Hex entities
              .trim();
            if (cleanText) {
              abstractParts.push(cleanText);
            }
          }

          if (abstractParts.length > 0) {
            abstractsMap[id] = abstractParts.join(' ');
          }
        }
      });
    } catch (err) {
      console.warn('Failed to fetch abstracts:', err.message);
      // Continue without abstracts if fetch fails
    }

    // Helper function to extract publication year
    const extractYear = (pubdate) => {
      if (!pubdate) return null;
      const yearMatch = pubdate.match(/\d{4}/);
      return yearMatch ? parseInt(yearMatch[0]) : null;
    };

    // Helper function to determine study type from publication types
    const getStudyType = (pubTypeList) => {
      if (!pubTypeList || pubTypeList.length === 0) return null;

      const types = pubTypeList.map(t => t.toLowerCase());

      if (types.some(t => t.includes('meta-analysis'))) return 'Meta-Analysis';
      if (types.some(t => t.includes('systematic review'))) return 'Systematic Review';
      if (types.some(t => t.includes('randomized controlled trial'))) return 'RCT';
      if (types.some(t => t.includes('clinical trial'))) return 'Clinical Trial';
      if (types.some(t => t.includes('review'))) return 'Review';
      if (types.some(t => t.includes('guideline') || t.includes('practice guideline'))) return 'Guideline';
      if (types.some(t => t.includes('case reports'))) return 'Case Report';
      if (types.some(t => t.includes('observational study'))) return 'Observational Study';

      return 'Research Article';
    };

    // Helper function to determine if article is recent (within 1 year)
    const isRecent = (year) => {
      if (!year) return false;
      const currentYear = new Date().getFullYear();
      return (currentYear - year) <= 1;
    };

    // Parse articles
    const articles = ids.map(id => {
      const article = summaryData[id];
      if (!article) return null;

      const pubYear = extractYear(article.pubdate);
      const studyType = getStudyType(article.pubtype);

      return {
        pmid: id,
        title: article.title || 'No title available',
        authors: article.authors?.slice(0, 3).map(a => a.name).join(', ') || 'Unknown authors',
        allAuthors: article.authors?.map(a => a.name).join(', ') || 'Unknown authors',
        journal: article.fulljournalname || article.source || 'Unknown journal',
        pubdate: article.pubdate || 'Unknown date',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        // New metadata fields
        studyType: studyType,
        publicationYear: pubYear,
        isRecent: isRecent(pubYear),
        publicationTypes: article.pubtype || [],
        abstract: abstractsMap[id] || null,
        doi: article.elocationid || null
      };
    }).filter(Boolean);

    console.log('Returning', articles.length, 'articles');

    // Step 4: Enrich articles with CrossRef metadata and Unpaywall full-text links
    console.log('Enriching articles with CrossRef and Unpaywall...');
    let enrichedArticles = await crossrefService.enrichArticles(articles);
    enrichedArticles = await unpaywallService.checkMultipleArticles(enrichedArticles);

    console.log('Final enriched articles count:', enrichedArticles.length);
    return enrichedArticles;

  } catch (error) {
    console.error('PubMed search error:', error.message);
    throw error; // Re-throw to be caught by outer try-catch
  }
}

// Search Europe PMC endpoint
app.post('/api/search-europepmc', async (req, res) => {
  try {
    const { query, filters } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    console.log('Searching Europe PMC with query:', query);

    // Improve query construction - wrap main query in title/abstract search
    // Europe PMC syntax: (query) to search in title and abstract
    let searchQuery = `(${query})`;

    // Add filters to Europe PMC query
    let filterParams = '';

    // Add date range filter
    if (filters?.dateRange && filters.dateRange !== 'all') {
      const currentYear = new Date().getFullYear();
      const yearsAgo = {
        '1year': 1,
        '5years': 5,
        '10years': 10
      };
      const startYear = currentYear - (yearsAgo[filters.dateRange] || 0);
      filterParams += ` AND (FIRST_PDATE:[${startYear} TO ${currentYear}])`;
    }

    // Add study type filter
    if (filters?.studyType && filters.studyType !== 'all') {
      const studyTypeFilters = {
        'rct': 'randomized controlled trial',
        'meta': 'meta-analysis',
        'review': 'review OR systematic review',
        'clinical': 'clinical trial',
        'guideline': 'guideline'
      };
      if (studyTypeFilters[filters.studyType]) {
        filterParams += ` AND (${studyTypeFilters[filters.studyType]})`;
      }
    }

    const finalQuery = searchQuery + filterParams;
    console.log('Final Europe PMC query:', finalQuery);

    // Search Europe PMC
    const searchUrl = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
    const searchParams = {
      query: finalQuery,
      format: 'json',
      pageSize: 20,
      resultType: 'core',
      sort: 'relevance'
    };

    const response = await retryWithBackoff(
      () => axios.get(searchUrl, { params: searchParams }),
      3,
      1000
    );

    const results = response.data.resultList?.result || [];

    if (results.length === 0) {
      return res.json({ articles: [] });
    }

    console.log('Found', results.length, 'articles from Europe PMC');

    // Helper function to extract year
    const extractYear = (dateStr) => {
      if (!dateStr) return null;
      const yearMatch = dateStr.match(/\d{4}/);
      return yearMatch ? parseInt(yearMatch[0]) : null;
    };

    // Helper function to determine if article is recent
    const isRecent = (year) => {
      if (!year) return false;
      const currentYear = new Date().getFullYear();
      return (currentYear - year) <= 1;
    };

    // Helper function to map Europe PMC pub types to our categories
    const getStudyType = (pubTypeList) => {
      if (!pubTypeList || pubTypeList.length === 0) return null;

      const types = pubTypeList.map(t => t.toLowerCase());

      if (types.some(t => t.includes('meta-analysis'))) return 'Meta-Analysis';
      if (types.some(t => t.includes('systematic review'))) return 'Systematic Review';
      if (types.some(t => t.includes('randomized controlled trial'))) return 'RCT';
      if (types.some(t => t.includes('clinical trial'))) return 'Clinical Trial';
      if (types.some(t => t.includes('review'))) return 'Review';
      if (types.some(t => t.includes('guideline'))) return 'Guideline';

      return 'Research Article';
    };

    // Parse articles
    const articles = results.map(article => {
      const pubYear = extractYear(article.firstPublicationDate || article.pubYear);
      const studyType = getStudyType(article.pubTypeList?.pubType || []);

      // Build URL based on source
      let url = '';
      if (article.pmid) {
        url = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
      } else if (article.pmcid) {
        url = `https://europepmc.org/article/PMC/${article.pmcid.replace('PMC', '')}`;
      } else if (article.doi) {
        url = `https://doi.org/${article.doi}`;
      } else {
        url = `https://europepmc.org/article/${article.source}/${article.id}`;
      }

      return {
        pmid: article.pmid || article.id,
        title: article.title || 'No title available',
        authors: article.authorString || article.authorList?.author?.slice(0, 3).map(a => `${a.firstName || ''} ${a.lastName || ''}`.trim()).join(', ') || 'Unknown authors',
        allAuthors: article.authorString || 'Unknown authors',
        journal: article.journalTitle || article.journalInfo?.journal?.title || 'Unknown journal',
        pubdate: article.firstPublicationDate || article.pubYear || 'Unknown date',
        url: url,
        studyType: studyType,
        publicationYear: pubYear,
        isRecent: isRecent(pubYear),
        publicationTypes: article.pubTypeList?.pubType || [],
        abstract: article.abstractText || null,
        doi: article.doi || null,
        source: 'Europe PMC',
        hasFullText: article.isOpenAccess === 'Y' || article.inEPMC === 'Y'
      };
    }).filter(Boolean);

    console.log('Returning', articles.length, 'articles from Europe PMC');

    res.json({ articles });

  } catch (error) {
    console.error('Europe PMC search error:', error.message);

    let statusCode = 500;
    let errorMessage = 'Failed to search Europe PMC';
    let retryable = true;

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Europe PMC request timed out. Please try again.';
      statusCode = 504;
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      errorMessage = 'Unable to connect to Europe PMC. Please check your internet connection.';
      statusCode = 503;
    } else if (error.response?.status === 429) {
      errorMessage = 'Europe PMC rate limit exceeded. Please wait a moment and try again.';
      statusCode = 429;
    } else if (error.response?.status >= 500) {
      errorMessage = 'Europe PMC service is temporarily unavailable. Please try again later.';
      statusCode = 503;
    }

    res.status(statusCode).json({
      error: errorMessage,
      details: error.message,
      retryable: retryable
    });
  }
});

// Claude API endpoint with conversation history support
app.post('/api/generate-response', async (req, res) => {
  try {
    const { query, articles, conversationHistory } = req.body;

    if (!query || !articles) {
      return res.status(400).json({ error: 'Query and articles are required' });
    }

    console.log('Generating response for query:', query);
    console.log('Conversation history length:', conversationHistory?.length || 0);

    // Format articles for the prompt - include abstracts for better context
    // Limit to top 15 articles to avoid 413 Payload Too Large errors
    const articlesToSend = articles.slice(0, 15);

    const articlesContext = articlesToSend.map((a, i) => {
      let context = `[${i + 1}] ${a.title}\n   Authors: ${a.authors}\n   Journal: ${a.journal}, ${a.pubdate}\n   PMID: ${a.pmid}`;
      if (a.studyType) {
        context += `\n   Study Type: ${a.studyType}`;
      }
      // Add citation count if available (from CrossRef enrichment)
      if (a.citationCount && a.citationCount > 0) {
        context += `\n   Citations: ${a.citationCount}`;
      }
      if (a.abstract) {
        // Truncate abstracts more aggressively to avoid payload issues
        const abstractPreview = a.abstract.length > 400
          ? a.abstract.substring(0, 400) + '...'
          : a.abstract;
        context += `\n   Abstract: ${abstractPreview}`;
      }
      return context;
    }).join('\n\n');

    console.log(`Sending ${articlesToSend.length} articles to Claude (truncated from ${articles.length})`);
    console.log(`Total context length: ${articlesContext.length} characters`);

    // Build system prompt
    const systemPrompt = `You are a medical information assistant that provides evidence-based answers. You help users explore medical topics through conversation, maintaining context from previous exchanges.

When answering:
1. CAREFULLY READ the abstracts provided - only cite sources that are actually relevant to the specific question
2. If a source doesn't directly address the question, DO NOT cite it
3. Consider the conversation history to provide contextual responses
4. Reference specific studies using [1], [2], etc. notation ONLY when the study directly supports your claim
5. Be concise but thorough (2-4 paragraphs for initial questions, briefer for follow-ups)
6. Include important caveats or limitations found in the studies
7. Use clear, professional language appropriate for healthcare contexts
8. For follow-up questions, acknowledge previous context naturally
9. If none of the provided sources are relevant, acknowledge this and provide general medical knowledge instead

IMPORTANT:
- Do NOT cite sources just because they're provided - only cite what's actually relevant
- Do NOT reproduce or quote exact text from articles. Paraphrase and synthesize information in your own words while citing sources.
- Quality over quantity - it's better to cite 2-3 highly relevant sources than all sources provided`;

    // Build messages array with conversation history
    const messages = [];

    // Add previous conversation if exists, but limit to last 10 exchanges (20 messages)
    // to avoid payload size issues
    if (conversationHistory && conversationHistory.length > 0) {
      const maxHistoryMessages = 20;
      const historyToInclude = conversationHistory.length > maxHistoryMessages
        ? conversationHistory.slice(-maxHistoryMessages)
        : conversationHistory;

      if (conversationHistory.length > maxHistoryMessages) {
        console.log(`Limiting conversation history from ${conversationHistory.length} to ${maxHistoryMessages} messages`);
      }

      historyToInclude.forEach(msg => {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        });
      });
    }

    // Add current query with articles context
    const currentPrompt = `User Question: ${query}

Relevant Research Articles from PubMed:
${articlesContext}

Please provide a clear, evidence-based response.

After your response, suggest 3 relevant follow-up questions that the user might want to ask. Format them as:

FOLLOW-UP QUESTIONS:
1. [Question 1]
2. [Question 2]
3. [Question 3]`;

    messages.push({
      role: 'user',
      content: currentPrompt
    });

    // Call Claude API with conversation history and retry logic
    const response = await retryWithBackoff(
      () => axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          system: systemPrompt,
          messages: messages
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        }
      ),
      3,
      2000
    );

    const aiResponse = response.data.content[0].text;
    console.log('Generated response successfully');
    console.log('Response length:', aiResponse.length, 'characters');

    // Extract follow-up questions from response
    let mainResponse = aiResponse;
    let followUpQuestions = [];

    try {
      const followUpMatch = aiResponse.match(/FOLLOW-UP QUESTIONS:\s*([\s\S]*)/i);
      if (followUpMatch) {
        // Split main response and follow-ups
        mainResponse = aiResponse.split(/FOLLOW-UP QUESTIONS:/i)[0].trim();

        // Extract questions (numbered list format)
        const questionsText = followUpMatch[1];
        const questionLines = questionsText.split('\n')
          .map(line => line.trim())
          .filter(line => /^\d+\.\s*.+/.test(line));

        followUpQuestions = questionLines.map(line =>
          line.replace(/^\d+\.\s*/, '').trim()
        ).filter(q => q.length > 0 && q.length < 300); // Limit question length

        console.log('Extracted', followUpQuestions.length, 'follow-up questions');
      }
    } catch (parseError) {
      console.warn('Failed to parse follow-up questions:', parseError.message);
      // Continue without follow-up questions if parsing fails
    }

    // Log usage stats for debugging
    const usage = response.data.usage;
    if (usage) {
      console.log('Token usage - Input:', usage.input_tokens, 'Output:', usage.output_tokens);
    }

    res.json({
      response: mainResponse,
      followUpQuestions: followUpQuestions
    });

  } catch (error) {
    console.error('Claude API error:', error.response?.data || error.message);

    // Determine error type and provide helpful message
    let statusCode = 500;
    let errorMessage = 'Failed to generate response';
    let retryable = true;

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = 'AI request timed out. Please try again.';
      statusCode = 504;
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      errorMessage = 'Unable to connect to AI service. Please check your internet connection.';
      statusCode = 503;
    } else if (error.response?.status === 429) {
      errorMessage = 'AI service rate limit exceeded. Please wait a moment and try again.';
      statusCode = 429;
    } else if (error.response?.status === 401) {
      errorMessage = 'AI service authentication failed. Please check API configuration.';
      statusCode = 500;
      retryable = false;
    } else if (error.response?.status >= 500) {
      errorMessage = 'AI service is temporarily unavailable. Please try again later.';
      statusCode = 503;
    } else if (error.response?.status === 400) {
      errorMessage = 'Invalid request to AI service. Please try rephrasing your question.';
      statusCode = 400;
      retryable = false;
    }

    res.status(statusCode).json({
      error: errorMessage,
      details: error.response?.data?.error?.message || error.message,
      retryable: retryable
    });
  }
});

// Helper function to build PubMed query
function buildPubMedQuery(query, filters) {
  let searchTerm = query;

  // Add date range filter
  if (filters?.dateRange && filters.dateRange !== 'all') {
    const dateFilters = {
      '1year': '("2024/01/01"[Date - Publication] : "3000"[Date - Publication])',
      '5years': '("2020/01/01"[Date - Publication] : "3000"[Date - Publication])',
      '10years': '("2015/01/01"[Date - Publication] : "3000"[Date - Publication])',
    };
    if (dateFilters[filters.dateRange]) {
      searchTerm += ' AND ' + dateFilters[filters.dateRange];
    }
  }

  // Add study type filter
  if (filters?.studyType && filters.studyType !== 'all') {
    const studyTypeFilters = {
      'meta-analysis': 'AND (Meta-Analysis[pt])',
      'rct': 'AND (Randomized Controlled Trial[pt])',
      'review': 'AND (Review[pt] OR Systematic Review[pt])',
    };
    if (studyTypeFilters[filters.studyType]) {
      searchTerm += ' ' + studyTypeFilters[filters.studyType];
    }
  }

  return searchTerm;
}

// Helper function to build Europe PMC query
function buildEuropePMCQuery(query, filters) {
  let searchQuery = `(${query})`;
  let filterParams = '';

  // Add date range filter
  if (filters?.dateRange && filters.dateRange !== 'all') {
    const currentYear = new Date().getFullYear();
    const yearsAgo = { '1year': 1, '5years': 5, '10years': 10 };
    const years = yearsAgo[filters.dateRange];
    if (years) {
      const startYear = currentYear - years;
      filterParams += ` AND (FIRST_PDATE:[${startYear} TO ${currentYear}])`;
    }
  }

  // Add study type filter
  if (filters?.studyType && filters.studyType !== 'all') {
    const studyTypeFilters = {
      'meta-analysis': ' AND (PUB_TYPE:"Meta-Analysis")',
      'rct': ' AND (PUB_TYPE:"Randomized Controlled Trial")',
      'review': ' AND (PUB_TYPE:"Review" OR PUB_TYPE:"Systematic Review")',
    };
    if (studyTypeFilters[filters.studyType]) {
      filterParams += studyTypeFilters[filters.studyType];
    }
  }

  return searchQuery + filterParams;
}

// Helper function to perform multi-source search
async function performSearch(query, filters) {
  const searchPromises = [];

  // Search PubMed
  searchPromises.push(
    (async () => {
      try {
        const pubmedQuery = buildPubMedQuery(query, filters);
        const searchResponse = await retryWithBackoff(() =>
          axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
            params: {
              db: 'pubmed',
              term: pubmedQuery,
              retmax: 20,
              retmode: 'json',
              sort: 'relevance'
            }
          })
        );

        const ids = searchResponse.data.esearchresult.idlist;
        if (ids.length === 0) return [];

        const summaryResponse = await retryWithBackoff(() =>
          axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {
            params: {
              db: 'pubmed',
              id: ids.join(','),
              retmode: 'json'
            }
          })
        );

        return Object.values(summaryResponse.data.result).filter(item => item.uid).map(article => ({
          pmid: article.uid,
          title: article.title || 'No title',
          authors: article.authors?.map(a => a.name).join(', ') || 'Unknown',
          journal: article.fulljournalname || article.source || 'Unknown',
          year: article.pubdate?.split(' ')[0] || 'Unknown',
          doi: article.elocationid || null,
          abstract: null,
          source: 'PubMed',
          url: `https://pubmed.ncbi.nlm.nih.gov/${article.uid}/`
        }));
      } catch (err) {
        console.warn('PubMed search failed:', err.message);
        return [];
      }
    })()
  );

  // Search Europe PMC
  searchPromises.push(
    (async () => {
      try {
        const europePmcQuery = buildEuropePMCQuery(query, filters);
        const response = await retryWithBackoff(() =>
          axios.get('https://www.ebi.ac.uk/europepmc/webservices/rest/search', {
            params: {
              query: europePmcQuery,
              format: 'json',
              pageSize: 20,
              resultType: 'core',
              sort: 'relevance'
            }
          })
        );

        return (response.data.resultList?.result || []).map(article => {
          // Build URL based on available identifiers
          let url = '';
          if (article.pmid) {
            url = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
          } else if (article.pmcid) {
            url = `https://europepmc.org/article/PMC/${article.pmcid.replace('PMC', '')}`;
          } else if (article.doi) {
            url = `https://doi.org/${article.doi}`;
          }

          return {
            pmid: article.pmid || null,
            title: article.title || 'No title',
            authors: article.authorString || 'Unknown',
            journal: article.journalTitle || 'Unknown',
            year: article.pubYear || 'Unknown',
            doi: article.doi || null,
            abstract: article.abstractText || null,
            source: 'Europe PMC',
            url: url
          };
        });
      } catch (err) {
        console.warn('Europe PMC search failed:', err.message);
        return [];
      }
    })()
  );

  const results = await Promise.all(searchPromises);
  const allArticles = results.flat();

  // Deduplicate by PMID or title
  const seen = new Set();
  return allArticles.filter(article => {
    const key = article.pmid || article.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Deep Research endpoint
app.post('/api/deep-research', async (req, res) => {
  try {
    const { query, filters } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log('🔬 Deep research request:', query);

    // Stage 1: Initial search
    let initialArticles = await performSearch(query, filters);

    if (initialArticles.length === 0) {
      return res.status(404).json({
        error: 'No relevant articles found',
        retryable: true
      });
    }

    // Enrich initial articles with CrossRef and Unpaywall metadata
    console.log('Enriching initial articles with CrossRef and Unpaywall...');
    initialArticles = await crossrefService.enrichArticles(initialArticles);
    initialArticles = await unpaywallService.checkMultipleArticles(initialArticles);

    // Stage 2: Analyze results and generate follow-up questions
    const analysisPrompt = `You are a medical research expert. Analyze these research findings and:
1. Identify 3-5 specific follow-up questions that would provide deeper insight
2. Focus on: mechanisms, clinical outcomes, populations not covered, contradictions, recent advances

Original question: ${query}

Research findings:
${initialArticles.slice(0, 10).map(a => `- ${a.title} (${a.year}): ${a.abstract?.substring(0, 200)}...`).join('\n')}

Generate ONLY a JSON array of 3-5 follow-up question strings. No other text.
Example format: ["question 1", "question 2", "question 3"]`;

    const analysisResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: analysisPrompt
      }]
    });

    let followUpQuestions;
    try {
      const responseText = analysisResponse.content[0].text.trim();
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      followUpQuestions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      console.error('Failed to parse follow-up questions:', e);
      followUpQuestions = [];
    }

    // Stage 3: Search for each follow-up question
    const followUpResults = [];
    for (const fq of followUpQuestions.slice(0, 5)) {
      let articles = await performSearch(fq, filters);
      // Enrich follow-up articles too
      articles = await crossrefService.enrichArticles(articles);
      articles = await unpaywallService.checkMultipleArticles(articles);
      followUpResults.push({
        question: fq,
        articles: articles.slice(0, 5)
      });
    }

    // Stage 4: Generate comprehensive synthesis
    const synthesisPrompt = `Create a comprehensive medical research report.

ORIGINAL QUESTION: ${query}

INITIAL FINDINGS (${initialArticles.length} articles):
${initialArticles.slice(0, 10).map(a => `- ${a.title} (${a.year}, ${a.journal})`).join('\n')}

FOLLOW-UP RESEARCH:
${followUpResults.map(fr => `\n${fr.question}\n${fr.articles.map(a => `  - ${a.title} (${a.year})`).join('\n')}`).join('\n')}

Provide a detailed synthesis covering:
1. Key Findings (main takeaways)
2. Clinical Implications (practical applications)
3. Evidence Quality (strength of research)
4. Knowledge Gaps (what's still unknown)
5. Recommendations (evidence-based guidance)

IMPORTANT: Do NOT include a "Sources" section or reference list at the end. Sources will be displayed separately in the UI.

Format in clear markdown with headers.`;

    const synthesisResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: synthesisPrompt
      }]
    });

    res.json({
      synthesis: synthesisResponse.content[0].text,
      initialArticles: initialArticles.slice(0, 20),
      followUpQuestions,
      followUpResults: followUpResults.map(fr => ({
        question: fr.question,
        articleCount: fr.articles.length,
        topArticles: fr.articles.slice(0, 3)
      })),
      totalArticlesAnalyzed: initialArticles.length + followUpResults.reduce((sum, fr) => sum + fr.articles.length, 0)
    });

  } catch (error) {
    console.error('Deep research error:', error);
    res.status(500).json({
      error: 'Failed to complete deep research',
      details: error.message,
      retryable: true
    });
  }
});

// Document Analysis endpoint
app.post('/api/analyze-document', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('📄 Document analysis request:', req.file.originalname);

    // Extract text based on file type
    let documentText = '';
    if (req.file.mimetype === 'application/pdf') {
      const parser = new PDFParse({ data: req.file.buffer });
      const result = await parser.getText();
      documentText = result.text;
      await parser.destroy();
    } else if (req.file.mimetype === 'text/plain') {
      documentText = req.file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Please upload PDF or TXT.' });
    }

    // Limit text length to avoid token limits (roughly 100k characters = ~25k tokens)
    if (documentText.length > 100000) {
      documentText = documentText.substring(0, 100000) + '\n\n[Document truncated due to length...]';
    }

    console.log(`Extracted ${documentText.length} characters from document`);

    // Analyze document with Claude
    const analysisResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Analyze this medical research document and provide a comprehensive summary:

DOCUMENT:
${documentText}

Provide analysis in the following format:

# Document Summary

## Title and Authors
[Extract title and authors if available]

## Research Type
[Identify: Clinical Trial, Meta-Analysis, Case Study, Review, etc.]

## Key Findings
- [Main findings as bullet points]

## Methods
[Brief description of methodology]

## Clinical Significance
[Practical implications for clinical practice]

## Limitations
[Study limitations if mentioned]

## Conclusions
[Main conclusions from the authors]

Format in clear markdown.`
      }]
    });

    const analysis = analysisResponse.content[0].text;

    res.json({
      analysis,
      documentLength: documentText.length,
      fileName: req.file.originalname
    });

  } catch (error) {
    console.error('Document analysis error:', error);
    res.status(500).json({
      error: 'Failed to analyze document',
      details: error.message
    });
  }
});

// Find Similar Papers endpoint
app.post('/api/find-similar', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('🔍 Finding similar papers for:', req.file.originalname);

    // Extract text
    let documentText = '';
    if (req.file.mimetype === 'application/pdf') {
      const parser = new PDFParse({ data: req.file.buffer });
      const result = await parser.getText();
      documentText = result.text;
      await parser.destroy();
    } else if (req.file.mimetype === 'text/plain') {
      documentText = req.file.buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Limit text for analysis
    const textSample = documentText.substring(0, 50000);

    // Use Claude to extract key concepts and generate search query
    const queryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extract the main medical topic and key concepts from this research document. Generate a concise PubMed search query (2-5 key terms) to find similar papers.

DOCUMENT EXCERPT:
${textSample}

Respond with ONLY the search query terms, nothing else.`
      }]
    });

    const searchQuery = queryResponse.content[0].text.trim();
    console.log('Generated search query:', searchQuery);

    // Search for similar papers
    const similarPapers = await performSearch(searchQuery, { dateRange: 'all', studyType: 'all' });

    res.json({
      searchQuery,
      papers: similarPapers.slice(0, 20),
      totalFound: similarPapers.length
    });

  } catch (error) {
    console.error('Find similar papers error:', error);
    res.status(500).json({
      error: 'Failed to find similar papers',
      details: error.message
    });
  }
});

// Drug Information endpoint
app.post('/api/drug-info', async (req, res) => {
  try {
    const { drugName } = req.body;

    if (!drugName) {
      return res.status(400).json({ error: 'Drug name is required' });
    }

    console.log(`📋 Fetching drug information for: ${drugName}`);

    // Use Claude to generate comprehensive drug information
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `As a medical information expert, provide comprehensive, evidence-based information about the medication "${drugName}".

Structure your response as a JSON object with the following fields:
- drugName: The medication name (as provided)
- genericName: Generic name if different from drugName (or null)
- brandNames: Array of common brand names (or empty array)
- overview: Brief description of the medication (string)
- indications: Array of FDA-approved indications
- dosing: String describing typical adult dosing
- sideEffects: Array of common side effects (>10% occurrence)
- seriousSideEffects: Array of serious/severe side effects to watch for
- contraindications: Array of absolute contraindications
- interactions: Array of major drug interactions (5-10 most important)
- monitoring: Array of monitoring parameters (labs, vitals, etc.)

Important guidelines:
1. Be accurate and evidence-based
2. If the drug doesn't exist or you're not confident, return an error message in the overview field
3. Use clear, professional medical terminology
4. Focus on clinically relevant information
5. Return valid JSON only, no additional text

Respond with valid JSON only.`
      }]
    });

    const content = response.content[0].text;

    // Try to parse the JSON response
    let drugInfo;
    try {
      // Clean the response - remove markdown code blocks if present
      const cleanedContent = content
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      drugInfo = JSON.parse(cleanedContent);
    } catch (parseError) {
      console.error('Failed to parse Claude response as JSON:', parseError);
      // If parsing fails, return a structured error response
      return res.json({
        drugName: drugName,
        overview: content,
        indications: [],
        sideEffects: [],
        interactions: []
      });
    }

    res.json(drugInfo);

  } catch (error) {
    console.error('Drug info error:', error);
    res.status(500).json({
      error: 'Failed to fetch drug information',
      details: error.message
    });
  }
});

// Clinical Guidelines Search endpoint
app.post('/api/search-guidelines', async (req, res) => {
  try {
    const { query, organization } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log(`📚 Searching guidelines for: ${query} (Organization: ${organization || 'all'})`);

    // Use Claude to search and compile relevant clinical guidelines
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `As a medical librarian and clinical guideline expert, search for relevant clinical practice guidelines about "${query}"${organization && organization !== 'all' ? ` specifically from ${organization}` : ''}.

Return a JSON array of guideline objects with the following structure:
[
  {
    "title": "Full guideline title",
    "organization": "Issuing organization (e.g., ACC/AHA, ADA, CHEST)",
    "year": "Year published or updated (YYYY)",
    "specialty": "Medical specialty",
    "summary": "Brief 2-3 sentence overview of the guideline",
    "keyRecommendations": ["Array of 3-5 key recommendations"],
    "url": "Official URL to the guideline (use real URLs when possible)"
  }
]

Important guidelines:
1. Focus on major, authoritative clinical practice guidelines from recognized organizations
2. Prioritize recent guidelines (last 5 years when possible)
3. Include 5-8 most relevant guidelines
4. Use real, accurate URLs when available
5. Be specific with recommendations
6. If no relevant guidelines exist, return an empty array
7. Common organizations: ACC/AHA, ADA, CHEST, IDSA, NCCN, ACOG, AAN, ESC, WHO, CDC, NICE, ASCO

Return valid JSON array only, no additional text.`
      }]
    });

    const content = response.content[0].text;

    // Parse the JSON response
    let guidelines;
    try {
      const cleanedContent = content
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      guidelines = JSON.parse(cleanedContent);

      // Ensure it's an array
      if (!Array.isArray(guidelines)) {
        guidelines = [];
      }
    } catch (parseError) {
      console.error('Failed to parse guidelines response as JSON:', parseError);
      guidelines = [];
    }

    res.json({
      query,
      organization: organization || 'all',
      guidelines,
      count: guidelines.length
    });

  } catch (error) {
    console.error('Guidelines search error:', error);
    res.status(500).json({
      error: 'Failed to search guidelines',
      details: error.message
    });
  }
});

// Evidence Alerts Management Endpoints

// In-memory storage for alerts (in production, use a database)
let evidenceAlerts = [];

// Create new alert
app.post('/api/alerts', async (req, res) => {
  try {
    const { id, topic, email, frequency, createdAt, active } = req.body;

    if (!topic || !email) {
      return res.status(400).json({ error: 'Topic and email are required' });
    }

    const alert = {
      id: id || Date.now().toString(),
      topic,
      email,
      frequency: frequency || 'weekly',
      createdAt: createdAt || new Date().toISOString(),
      active: active !== undefined ? active : true,
      lastChecked: null
    };

    evidenceAlerts.push(alert);

    console.log(`🔔 Created alert: ${topic} for ${email}`);

    res.json({
      success: true,
      alert,
      message: 'Alert created successfully'
    });

  } catch (error) {
    console.error('Create alert error:', error);
    res.status(500).json({
      error: 'Failed to create alert',
      details: error.message
    });
  }
});

// Update alert
app.put('/api/alerts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const alertIndex = evidenceAlerts.findIndex(a => a.id === id);

    if (alertIndex === -1) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    evidenceAlerts[alertIndex] = {
      ...evidenceAlerts[alertIndex],
      ...updates
    };

    console.log(`🔔 Updated alert: ${id}`);

    res.json({
      success: true,
      alert: evidenceAlerts[alertIndex],
      message: 'Alert updated successfully'
    });

  } catch (error) {
    console.error('Update alert error:', error);
    res.status(500).json({
      error: 'Failed to update alert',
      details: error.message
    });
  }
});

// Delete alert
app.delete('/api/alerts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const alertIndex = evidenceAlerts.findIndex(a => a.id === id);

    if (alertIndex === -1) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    evidenceAlerts = evidenceAlerts.filter(a => a.id !== id);

    console.log(`🔔 Deleted alert: ${id}`);

    res.json({
      success: true,
      message: 'Alert deleted successfully'
    });

  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({
      error: 'Failed to delete alert',
      details: error.message
    });
  }
});

// Check for new evidence for a specific alert
app.post('/api/alerts/:id/check', async (req, res) => {
  try {
    const { id } = req.params;

    const alert = evidenceAlerts.find(a => a.id === id);

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    console.log(`🔍 Checking for new evidence: ${alert.topic}`);

    // Calculate date range (since last check or past 7 days)
    const lastCheckDate = alert.lastChecked
      ? new Date(alert.lastChecked)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    const dateFilter = lastCheckDate.toISOString().split('T')[0].replace(/-/g, '/');

    // Search PubMed for new articles
    const pubmedResults = await performSearch(alert.topic, {
      dateRange: 'custom',
      startDate: dateFilter,
      studyType: 'all'
    });

    // Update last checked time
    const alertIndex = evidenceAlerts.findIndex(a => a.id === id);
    if (alertIndex !== -1) {
      evidenceAlerts[alertIndex].lastChecked = new Date().toISOString();
    }

    res.json({
      success: true,
      topic: alert.topic,
      newArticles: pubmedResults.slice(0, 10), // Return top 10 new articles
      count: pubmedResults.length,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Check alert error:', error);
    res.status(500).json({
      error: 'Failed to check for new evidence',
      details: error.message
    });
  }
});

// Get all alerts (for admin/debugging)
app.get('/api/alerts', async (req, res) => {
  try {
    res.json({
      alerts: evidenceAlerts,
      count: evidenceAlerts.length
    });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({
      error: 'Failed to retrieve alerts',
      details: error.message
    });
  }
});

// Visit Notes Generation endpoint
app.post('/api/generate-visit-note', async (req, res) => {
  try {
    const { transcription } = req.body;

    if (!transcription) {
      return res.status(400).json({ error: 'Transcription is required' });
    }

    console.log(`📝 Generating visit note from transcription (${transcription.length} chars)`);

    // Use Claude to generate structured SOAP note
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are an experienced medical scribe. Convert the following clinical visit transcription into a structured SOAP note (Subjective, Objective, Assessment, Plan).

Transcription:
${transcription}

Please generate a professional, well-formatted SOAP note with the following structure:

# SOAP Note

## Subjective
- Chief Complaint
- History of Present Illness
- Review of Systems (if applicable)
- Past Medical History (if mentioned)
- Medications (if mentioned)
- Allergies (if mentioned)
- Social History (if mentioned)

## Objective
- Vital Signs (if mentioned)
- Physical Examination Findings
- Lab Results (if mentioned)
- Imaging Results (if mentioned)

## Assessment
- Primary Diagnosis/Diagnoses with ICD codes if applicable
- Differential Diagnoses (if applicable)

## Plan
- Diagnostic Tests Ordered
- Treatments/Medications Prescribed
- Patient Education
- Follow-up Instructions
- Referrals (if applicable)

Guidelines:
1. Use clear, professional medical terminology
2. Be concise but comprehensive
3. Only include information that was actually mentioned in the transcription
4. If certain sections have no information, note "Not documented" or omit
5. Use markdown formatting for readability
6. Maintain patient privacy (don't include specific identifying information)

Generate the SOAP note now:`
      }]
    });

    const noteText = response.content[0].text;

    res.json({
      success: true,
      note: noteText,
      metadata: {
        generatedAt: new Date().toISOString(),
        wordCount: noteText.split(/\s+/).length,
        transcriptionLength: transcription.length
      }
    });

  } catch (error) {
    console.error('Generate visit note error:', error);
    res.status(500).json({
      error: 'Failed to generate visit note',
      details: error.message
    });
  }
});

// Query Enhancement Endpoints

// Preprocess query to extract medical entities
app.post('/api/preprocess-query', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log('Preprocessing query:', query);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `You are a medical search query optimizer. Extract the key medical concepts from this query and rewrite it as a concise medical literature search query.

Original query: "${query}"

Respond with ONLY the optimized search query, nothing else. Remove:
- Multiple choice options (A, B, C, D, E)
- Patient demographics unless critical to the medical question
- Non-medical context words
- Question words (what, which, how) unless they change medical meaning

Focus on:
- Medical conditions/diagnoses
- Treatments/interventions
- Diagnostic tests
- Clinical outcomes
- Key symptoms

Examples:
Input: "65-year-old man with anterior STEMI, BP 90/60. What is best treatment? A) Beta-blocker B) PCI C) Nitro"
Output: "anterior STEMI hypotension treatment primary PCI reperfusion"

Input: "What is the best medication for high blood pressure in diabetic patients?"
Output: "hypertension diabetes antihypertensive therapy ACE inhibitors"

Input: "My patient has a fever and productive cough with rust-colored sputum"
Output: "community acquired pneumonia rust colored sputum streptococcus pneumoniae"

Now process this query:`
      }]
    });

    const optimizedQuery = response.content[0].text.trim();

    console.log('Optimized query:', optimizedQuery);

    res.json({
      originalQuery: query,
      optimizedQuery: optimizedQuery
    });

  } catch (error) {
    console.error('Error preprocessing query:', error.message);
    res.status(500).json({
      error: 'Failed to preprocess query',
      details: error.message
    });
  }
});

// Generate query suggestions when no results found
app.post('/api/query-suggestions', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log('Generating query suggestions for:', query);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: `The user's medical literature search returned no results for this query:
"${query}"

Generate 3 alternative search queries that are more likely to find relevant medical literature. Each query should:
1. Use standard medical terminology (not lay terms)
2. Focus on clinical aspects (diagnosis, treatment, pathophysiology, outcomes)
3. Be concise and specific
4. Remove exam-style formatting if present
5. Use terms commonly found in medical journal article titles

Respond with ONLY valid JSON, no markdown formatting:
{
  "suggestions": [
    {"query": "...", "reason": "..."},
    {"query": "...", "reason": "..."},
    {"query": "...", "reason": "..."}
  ]
}

Example:
Input query: "65yo man STEMI choose A B C D E"
Response:
{
  "suggestions": [
    {
      "query": "STEMI treatment primary PCI versus thrombolysis",
      "reason": "Focuses on the main treatment decision in STEMI management"
    },
    {
      "query": "acute myocardial infarction reperfusion therapy guidelines",
      "reason": "Uses formal terminology and searches for clinical guidelines"
    },
    {
      "query": "ST elevation myocardial infarction emergency management",
      "reason": "Searches for emergency treatment protocols"
    }
  ]
}`
      }]
    });

    const content = response.content[0].text.trim();
    const cleanedContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const suggestions = JSON.parse(cleanedContent);

    console.log('Generated suggestions:', suggestions);

    res.json(suggestions);

  } catch (error) {
    console.error('Error generating query suggestions:', error.message);
    res.status(500).json({
      error: 'Failed to generate query suggestions',
      details: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Medical Evidence API server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔍 PubMed search: POST http://localhost:${PORT}/api/search-pubmed`);
  console.log(`🔬 Europe PMC search: POST http://localhost:${PORT}/api/search-europepmc`);
  console.log(`🤖 Claude generate: POST http://localhost:${PORT}/api/generate-response`);
  console.log(`🧬 Deep research: POST http://localhost:${PORT}/api/deep-research`);
  console.log(`📄 Document analysis: POST http://localhost:${PORT}/api/analyze-document`);
  console.log(`🔎 Find similar: POST http://localhost:${PORT}/api/find-similar`);
});