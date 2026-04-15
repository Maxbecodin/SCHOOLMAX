require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Firebase Admin init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PRICE_IDS = {
  starter:   'price_1TMXbgCO0CtAyaoTg6XpZ42f',
  pro:       'price_1TMXdzCO0CtAyaoTOoAvo9oM',
  unlimited: 'price_1TMXepCO0CtAyaoTE8CXcTVY',
};

const TIER_FOR_PRICE = Object.fromEntries(
  Object.entries(PRICE_IDS).map(([tier, id]) => [id, tier])
);

const app = express();

const ALLOWED_ORIGINS = [
  'http://localhost:8765',
  'https://schoolmax.vercel.app',
];

// Raw body for Stripe webhook — must come before express.json()
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Humanize ──
app.post('/humanize', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const apiKey = process.env.UND_KEY;
  if (!apiKey) return res.status(500).json({ error: 'UND_KEY not configured' });

  try {
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
    if (!submitRes.ok) {
      return res.status(submitRes.status).json({ error: submitBody.message || `Undetectable API error ${submitRes.status}` });
    }

    const id = submitBody.id;
    if (!id) return res.status(502).json({ error: 'Undetectable API did not return a document ID' });

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch('https://humanize.undetectable.ai/document', {
        method: 'POST',
        headers: { 'apikey': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const pollBody = await pollRes.json().catch(() => ({}));
      if (!pollRes.ok) continue;
      if (pollBody.output) return res.json({ output: pollBody.output });
    }

    res.status(504).json({ error: 'Undetectable API timed out' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI score check ──
app.post('/check', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const winstonKey = process.env.WINSTON_KEY;
  if (!winstonKey) return res.status(500).json({ error: 'WINSTON_KEY not configured' });

  try {
    const r = await fetch('https://api.gowinston.ai/v2/ai-content-detection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + winstonKey },
      body: JSON.stringify({ text, sentences: false })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.message || `Winston API error ${r.status}` });
    }

    const data = await r.json();
    res.json({ score: data?.score ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Create Stripe checkout session ──
app.post('/create-checkout', async (req, res) => {
  const { tier, userId, userEmail } = req.body;
  const priceId = PRICE_IDS[tier];
  if (!priceId) return res.status(400).json({ error: 'Invalid tier' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail,
      client_reference_id: userId,
      success_url: 'https://schoolmax.vercel.app/?upgraded=1',
      cancel_url: 'https://schoolmax.vercel.app/',
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe webhook ──
app.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const priceId = session.line_items?.data?.[0]?.price?.id;
    const tier = TIER_FOR_PRICE[priceId];

    if (userId && tier) {
      await db.collection('users').doc(userId).set({ tier }, { merge: true });
      console.log(`Upgraded ${userId} to ${tier}`);
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
