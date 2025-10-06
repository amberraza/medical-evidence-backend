const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Medical Evidence API is running' });
});

// Search PubMed endpoint
app.post('/api/search-pubmed', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    console.log('Searching PubMed for:', query);

    // Step 1: Search for article IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`;
    const searchParams = {
      db: 'pubmed',
      term: query,
      retmax: 5,
      retmode: 'json',
      sort: 'relevance'
    };

    const searchResponse = await axios.get(searchUrl, { params: searchParams });
    const ids = searchResponse.data.esearchresult?.idlist || [];

    if (ids.length === 0) {
      return res.json({ articles: [] });
    }

    console.log('Found article IDs:', ids);

    // Step 2: Fetch article details
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi`;
    const summaryParams = {
      db: 'pubmed',
      id: ids.join(','),
      retmode: 'json'
    };

    const summaryResponse = await axios.get(summaryUrl, { params: summaryParams });
    const summaryData = summaryResponse.data.result;

    // Parse articles
    const articles = ids.map(id => {
      const article = summaryData[id];
      if (!article) return null;

      return {
        pmid: id,
        title: article.title || 'No title available',
        authors: article.authors?.slice(0, 3).map(a => a.name).join(', ') || 'Unknown authors',
        journal: article.fulljournalname || article.source || 'Unknown journal',
        pubdate: article.pubdate || 'Unknown date',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
      };
    }).filter(Boolean);

    console.log('Returning', articles.length, 'articles');

    res.json({ articles });

  } catch (error) {
    console.error('PubMed search error:', error.message);
    res.status(500).json({ 
      error: 'Failed to search PubMed',
      details: error.message 
    });
  }
});

// Claude API endpoint
app.post('/api/generate-response', async (req, res) => {
  try {
    const { query, articles } = req.body;

    if (!query || !articles) {
      return res.status(400).json({ error: 'Query and articles are required' });
    }

    console.log('Generating response for query:', query);

    // Format articles for the prompt
    const articlesContext = articles.map((a, i) => 
      `[${i + 1}] ${a.title}\n   Authors: ${a.authors}\n   Journal: ${a.journal}, ${a.pubdate}\n   PMID: ${a.pmid}\n   URL: ${a.url}`
    ).join('\n\n');

    const prompt = `You are a medical information assistant that provides evidence-based answers. A user has asked a medical question, and I've retrieved relevant research articles from PubMed.

User Question: ${query}

Relevant Research Articles:
${articlesContext}

Please provide a clear, evidence-based response to the user's question. Your response should:
1. Directly answer the question based on the provided research
2. Reference specific studies using [1], [2], etc. notation when making claims
3. Be concise but thorough (2-4 paragraphs)
4. Include any important caveats or limitations
5. Use clear, professional language appropriate for healthcare contexts
6. Focus on the most recent and relevant findings

IMPORTANT: Do NOT reproduce or quote exact text from the articles. Paraphrase and synthesize the information in your own words while citing the sources.

Provide your response now:`;

    // Call Claude API
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          { role: 'user', content: prompt }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const aiResponse = response.data.content[0].text;
    console.log('Generated response successfully');

    res.json({ response: aiResponse });

  } catch (error) {
    console.error('Claude API error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to generate response',
      details: error.response?.data || error.message 
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