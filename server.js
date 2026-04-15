require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:8765');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/humanize', async (req, res) => {
  const { content } = req.body;
  console.log('Content length:', content?.length, 'Content preview:', content?.slice(0, 100));
  if (!content) return res.status(400).json({ error: 'content is required' });

  const apiKey = process.env.UND_KEY;
  if (!apiKey) return res.status(500).json({ error: 'UND_KEY not configured' });

  try {
    console.log('Submitting', content.length, 'chars');
    const submitRes = await fetch('https://humanize.undetectable.ai/submit', {
      method: 'POST',
      headers: { 'apikey': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        readability: 'High School',
        purpose: 'Essay',
        strength: 'More Human',
        model: 'v11'
      })
    });

    const submitBody = await submitRes.json().catch(() => ({}));
    console.log('Submit response:', submitRes.status, JSON.stringify(submitBody).slice(0, 300));

    if (!submitRes.ok) {
      return res.status(submitRes.status).json({ error: submitBody.message || `Undetectable API error ${submitRes.status}` });
    }

    const id = submitBody.id;
    if (!id) return res.status(502).json({ error: 'Undetectable API did not return a document ID' });

    console.log('Polling document:', id);
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch('https://humanize.undetectable.ai/document', {
        method: 'POST',
        headers: { 'apikey': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const pollBody = await pollRes.json().catch(() => ({}));
      console.log(`Poll ${i + 1}:`, pollRes.status, JSON.stringify(pollBody).slice(0, 200));
      if (!pollRes.ok) continue;
      if (pollBody.output) {
        console.log('Done! Output length:', pollBody.output.length);
        return res.json({ output: pollBody.output });
      }
    }

    res.status(504).json({ error: 'Undetectable API timed out after 20 poll attempts' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/check', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const winstonKey = process.env.WINSTON_KEY;
  if (!winstonKey) return res.status(500).json({ error: 'WINSTON_KEY not configured' });

  try {
    const r = await fetch('https://api.gowinston.ai/v2/ai-content-detection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + winstonKey
      },
      body: JSON.stringify({ text, sentences: false })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.message || `Winston API error ${r.status}` });
    }

    const data = await r.json();
    console.log('Winston score:', data?.score);
    res.json({ score: data?.score ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3001, () => console.log('Proxy server running on http://localhost:3001'));
