const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

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

// Search PubMed endpoint
app.post('/api/search-pubmed', async (req, res) => {
  try {
    const { query, filters } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

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

    // Use the query directly - PubMed handles natural language reasonably well
    // We can add keyword extraction later if needed as an optimization
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
      sort: 'relevance'
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
      retmode: 'json'
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
      rettype: 'abstract'
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
            // Remove any remaining XML tags and clean up
            const cleanText = textMatch[1]
              .replace(/<[^>]+>/g, '')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&amp;/g, '&')
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

    res.json({ articles });

  } catch (error) {
    console.error('PubMed search error:', error.message);

    // Determine error type and provide helpful message
    let statusCode = 500;
    let errorMessage = 'Failed to search PubMed';
    let retryable = true;

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      errorMessage = 'PubMed request timed out. Please try again.';
      statusCode = 504;
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      errorMessage = 'Unable to connect to PubMed. Please check your internet connection.';
      statusCode = 503;
    } else if (error.response?.status === 429) {
      errorMessage = 'PubMed rate limit exceeded. Please wait a moment and try again.';
      statusCode = 429;
    } else if (error.response?.status >= 500) {
      errorMessage = 'PubMed service is temporarily unavailable. Please try again later.';
      statusCode = 503;
    } else if (error.response?.status === 414) {
      errorMessage = 'Search query is too long. Please use a shorter question.';
      statusCode = 400;
      retryable = false;
    } else if (error.response?.status >= 400 && error.response?.status < 500) {
      errorMessage = 'Invalid search query. Please check your search terms.';
      statusCode = 400;
      retryable = false;
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
    const articlesContext = articles.map((a, i) => {
      let context = `[${i + 1}] ${a.title}\n   Authors: ${a.authors}\n   Journal: ${a.journal}, ${a.pubdate}\n   PMID: ${a.pmid}`;
      if (a.studyType) {
        context += `\n   Study Type: ${a.studyType}`;
      }
      if (a.abstract) {
        // Include abstract for context but truncate if too long
        const abstractPreview = a.abstract.length > 500
          ? a.abstract.substring(0, 500) + '...'
          : a.abstract;
        context += `\n   Abstract: ${abstractPreview}`;
      }
      return context;
    }).join('\n\n');

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

    // Add previous conversation if exists
    if (conversationHistory && conversationHistory.length > 0) {
      conversationHistory.forEach(msg => {
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Medical Evidence API server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔍 PubMed search: POST http://localhost:${PORT}/api/search-pubmed`);
  console.log(`🤖 Claude generate: POST http://localhost:${PORT}/api/generate-response`);
});