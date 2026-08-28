// The in-app assistant chat route — split out of index.js as part of
// breaking that monolith into modules. Pure relocation. Mounted with
// no prefix in index.js — the path below is the exact full path it
// always was.
const express = require('express');
const router = express.Router();
const { pool } = require('../lib/db');
const { authenticateToken } = require('../lib/auth');
const { assistantLimiter } = require('../rateLimiter');
const { isAssistantConfigured, chatWithAssistant } = require('../assistantChat');


// The in-app "how do I..." chatbot — see assistantChat.js for the actual
// system prompt/refusal rules. This route's own job is just: authenticate,
// rate-limit per user (LLM calls cost real tokens — assistantLimiter is a
// tighter, per-user ceiling on top of globalLimiter), and sanitize the
// client-supplied conversation before it ever reaches the model.
router.post('/api/assistant/chat', authenticateToken, assistantLimiter, async (req, res) => {
  if (!isAssistantConfigured()) {
    return res.status(503).json({ error: 'Assistant is not available right now.' });
  }
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }

  // Only 'user'/'assistant' entries ever reach the model — this is what
  // stops a client from injecting a fake {role: 'system', content: '...'}
  // to override the real system prompt built server-side below. Also caps
  // length (a long-running conversation just loses its oldest turns, not
  // an error) and per-message size, both purely to bound cost/abuse.
  const sanitized = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-12);
  if (sanitized.length === 0) {
    return res.status(400).json({ error: 'messages must contain at least one user/assistant message' });
  }

  try {
    let organizationName = null;
    if (req.user.role !== 'superadmin' && req.user.organizationId) {
      const orgRes = await pool.query('SELECT name FROM organizations WHERE id = $1', [req.user.organizationId]);
      organizationName = orgRes.rows[0]?.name || null;
    }
    const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.userId]);

    const reply = await chatWithAssistant(
      { name: userRes.rows[0]?.name, role: req.user.role, organizationName },
      sanitized
    );
    res.status(200).json({ reply });
  } catch (err) {
    console.error('Assistant chat error:', err);
    res.status(503).json({ error: 'Assistant is not available right now.' });
  }
});

module.exports = router;
