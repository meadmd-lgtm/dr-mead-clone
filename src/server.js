'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Trim whitespace/CRLF from keys — Windows Add-Content adds \r which breaks auth
const ANTHROPIC_KEY   = (process.env.ANTHROPIC_API_KEY   || '').trim();
const ELEVENLABS_KEY  = (process.env.ELEVENLABS_API_KEY  || '').trim();
const ELEVENLABS_VOICE = (process.env.ELEVENLABS_VOICE_ID || '').trim();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Log every request so we can confirm browser→server communication
app.use((req, _res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(__dirname));   // serves src/index.html at http://localhost:3000/

const SYSTEM_PROMPT_BASE = `You are Dr. Mead — a chiropractor, naturopath, master herbalist, and doctor of indigenous medicine. You specialize in root-cause weight loss: finding the underlying medical reason a person's body will not release weight and fixing it naturally.

Your four root causes of weight retention:
1. Thyroid dysfunction — including subclinical issues missed by standard TSH-only testing. You look at Free T3, Free T4, Reverse T3, and antibodies.
2. Gut health — dysbiosis, leaky gut, SIBO, low stomach acid, enzyme deficiency, Candida. The gut-weight connection is real and often missed.
3. Hormone imbalance — cortisol dysregulation, estrogen dominance, low testosterone, insulin resistance, leptin resistance.
4. Toxic burden — heavy metals, environmental chemicals, mold, xenoestrogens. The body stores toxins in fat tissue to protect vital organs. This is why fat is often the last thing the body wants to release.

You created the "Your Fat May Not Be Your Fault" 8-week program to find and fix the specific root cause in each person.

Communication style:
- Lead with validation — many patients come to you after being dismissed or told their labs are "normal"
- Be warm, direct, and hopeful. You have seen real results that conventional medicine missed.
- Connect every symptom to a root cause and explain WHY the body is doing it
- Use plain language. You can go clinical when it helps, but you never talk over people.
- You are encouraging but honest — you do not promise miracles, you promise investigation
- You respect the wisdom of indigenous and herbal medicine traditions

When someone describes their struggle:
1. Validate: "What you're describing makes complete sense to me..."
2. Educate: explain the likely root cause at play
3. Direct: point them toward how to investigate and what natural solutions exist

Keep responses conversational and under 150 words — this is a voice conversation.
Do NOT use markdown formatting. No asterisks, no bullet points, no pound signs, no bold or italic. Speak in plain sentences only.

Important: You provide health education, not medical diagnosis or prescription. Always recommend working with a qualified practitioner. For emergencies, direct to emergency services immediately.`;

// ── Knowledge base loader ─────────────────────────────────────────────────────
function loadKnowledgeBase() {
  const knowledgeDir = path.join(__dirname, '..', 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return '';

  // Load in priority order: persona → program → expertise → articles → transcripts
  const folderOrder = ['persona', 'program', 'expertise', 'articles', 'transcripts'];
  const loaded = [];

  function readFolder(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Files first, then recurse into subdirs
    for (const e of entries.filter(e => !e.isDirectory())) {
      if (!e.name.endsWith('.md') || e.name === 'README.md') continue;
      const fullPath = path.join(dir, e.name);
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      // Skip files that are mostly template placeholders (< 200 chars of real content)
      const nonTemplateChars = content.replace(/^#.*$/gm,'').replace(/<!--.*?-->/gs,'').trim();
      if (nonTemplateChars.length < 200) return;
      const label = path.relative(knowledgeDir, fullPath).replace(/\\/g, '/');
      loaded.push({ label, content });
    }
    for (const e of entries.filter(e => e.isDirectory())) {
      readFolder(path.join(dir, e.name));
    }
  }

  // Read in priority order first
  for (const folder of folderOrder) {
    readFolder(path.join(knowledgeDir, folder));
  }
  // Then anything not in the priority list
  const extras = fs.readdirSync(knowledgeDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !folderOrder.includes(e.name));
  for (const e of extras) readFolder(path.join(knowledgeDir, e.name));

  if (loaded.length === 0) return '';

  const joined = loaded
    .map(f => `=== ${f.label} ===\n${f.content}`)
    .join('\n\n');

  console.log(`[Knowledge] Loaded ${loaded.length} file(s): ${loaded.map(f => f.label).join(', ')}`);
  console.log(`[Knowledge] Total size: ${Math.round(joined.length / 1000)}KB`);
  return joined;
}

const KNOWLEDGE = loadKnowledgeBase();
const SYSTEM_PROMPT = SYSTEM_PROMPT_BASE + (KNOWLEDGE
  ? `\n\n## YOUR KNOWLEDGE BASE\n\nDraw on the following documents when answering. Reference specific protocols, herbs, and recommendations from them whenever relevant. Speak as if this knowledge is your own lived clinical experience.\n\n${KNOWLEDGE}`
  : '');

// ── POST /api/chat ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    console.error('[/api/chat] Bad request: no messages array');
    return res.status(400).json({ error: 'messages array required' });
  }

  if (!ANTHROPIC_KEY) {
    console.error('[/api/chat] ANTHROPIC_API_KEY missing');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
  }

  const question = messages[messages.length - 1]?.content || '';
  console.log('\n[Chat] Question received:', question);
  console.log('[Chat] Calling Claude API...');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 512,
        system:     SYSTEM_PROMPT,
        messages
      })
    });

    console.log('[Chat] Claude HTTP status:', r.status);

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      console.error('[Chat] Claude error body:', JSON.stringify(e));
      return res.status(r.status).json({ error: e.error?.message || `Claude API error ${r.status}` });
    }

    const data = await r.json();
    const reply = data.content[0].text;
    console.log('[Chat] Claude reply:', reply);
    res.json({ reply });
  } catch (err) {
    console.error('[Chat] Network error:', err.message);
    res.status(502).json({ error: 'Could not reach Claude API: ' + err.message });
  }
});

// ── Markdown stripper ─────────────────────────────────────────────────────────
function stripMarkdown(text) {
  return text
    .replace(/#{1,6}\s+/g, '')          // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')    // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/__(.+?)__/g, '$1')        // __bold__
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/`{1,3}[^`]*`{1,3}/g, '')  // `code` and ```blocks```
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [link](url)
    .replace(/^[-*+]\s+/gm, '')         // bullet points
    .replace(/^\d+\.\s+/gm, '')         // numbered lists
    .replace(/^>\s+/gm, '')             // blockquotes
    .replace(/[-]{3,}/g, '')            // --- horizontal rules
    .replace(/\n{2,}/g, ' ')            // multiple newlines → space
    .replace(/\n/g, ' ')                // remaining newlines → space
    .replace(/\s{2,}/g, ' ')            // multiple spaces → single
    .trim();
}

// ── POST /api/speak ───────────────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    console.error('[/api/speak] Bad request: no text');
    return res.status(400).json({ error: 'text required' });
  }

  if (!ELEVENLABS_KEY || !ELEVENLABS_VOICE) {
    console.error('[/api/speak] ElevenLabs credentials missing');
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set in .env' });
  }

  const cleanText = stripMarkdown(text);
  console.log('[Speak] Calling ElevenLabs, text length:', cleanText.length, 'chars');

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key':   ELEVENLABS_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: cleanText,
          model_id:       'eleven_turbo_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.25 }
        })
      }
    );

    console.log('[Speak] ElevenLabs HTTP status:', r.status);

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      console.error('[Speak] ElevenLabs error body:', JSON.stringify(e));
      return res.status(r.status).json({ error: e.detail?.message || `ElevenLabs error ${r.status}` });
    }

    const buf = await r.arrayBuffer();
    console.log('[Speak] Audio received:', buf.byteLength, 'bytes — sending to browser');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[Speak] Network error:', err.message);
    res.status(502).json({ error: 'Could not reach ElevenLabs API: ' + err.message });
  }
});

// Explicit root fallback — ensures / always returns index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nDr. Mead AI running at http://localhost:${PORT}`);
  console.log(`Open this URL in Chrome: http://localhost:${PORT}/\n`);
  const preview = (k) => k ? `${k.slice(0, 10)}... (${k.length} chars)` : '✗ MISSING';
  console.log('  ANTHROPIC_API_KEY:  ', preview(ANTHROPIC_KEY));
  console.log('  ELEVENLABS_API_KEY: ', preview(ELEVENLABS_KEY));
  console.log('  ELEVENLABS_VOICE_ID:', preview(ELEVENLABS_VOICE));
  console.log('Keys loaded:',
    ANTHROPIC_KEY   ? 'ANTHROPIC ✓' : 'ANTHROPIC ✗',
    ELEVENLABS_KEY  ? 'ELEVENLABS ✓' : 'ELEVENLABS ✗',
    ELEVENLABS_VOICE ? 'VOICE_ID ✓'  : 'VOICE_ID ✗'
  );
});
