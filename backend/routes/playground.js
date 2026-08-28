// Free-form code execution/trace routes — split out of index.js as
// part of breaking that monolith into modules. Pure relocation:
// nothing about any route's behavior changed, only where it lives.
// Mounted with no prefix in index.js (app.use(playgroundRouter)) —
// every path below is the exact full path it always was.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../lib/auth');
const { LANGUAGE_CONFIG, TRACE_CONFIG, executeInSandbox, executeTrace } = require('../lib/sandbox');

// ============================================================================
// 6. PLAYGROUND â€” free-form code execution, not tied to any problem
// ============================================================================

/**
 * Legacy raw-run endpoint, kept for backward compatibility with the existing
 * "Run Code" button on the problem-solving page. Functionally identical to
 * the Playground route below â€” both just return whatever the program printed.
 */
router.post('/api/execute/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!LANGUAGE_CONFIG[language]) return res.status(400).json({ error: 'Unsupported language' });

  const result = await executeInSandbox(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json({ output: result.output });
});

/**
 * The Playground: same sandbox, explicitly namespaced so the frontend can
 * treat it as its own "just write and run code" section, separate from any
 * problem/judge context. Supports optional custom stdin.
 */
router.post('/api/playground/execute/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!LANGUAGE_CONFIG[language]) return res.status(400).json({ error: 'Unsupported language' });

  const result = await executeInSandbox(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json({ output: result.output });
});

/**
 * Line-by-line execution trace for the IDE's "Visualize" panel. Runs the
 * student's program through its language's tracer harness once and returns
 * the full step-by-step trace for the frontend to scrub through client-side
 * â€” same run-once-return-everything shape as the execute routes above,
 * rather than a live/interactive stepping protocol. Only languages listed in
 * TRACE_CONFIG have a harness so far; everything else gets a clear 400.
 */
router.post('/api/playground/trace/:language', authenticateToken, async (req, res) => {
  const { language } = req.params;
  const { code, stdin } = req.body;

  if (!code) return res.status(400).json({ error: 'Code is required' });
  if (!TRACE_CONFIG[language]) {
    return res.status(400).json({ error: `Line-by-line tracing isn't available for ${language} yet.` });
  }

  const result = await executeTrace(language, code, stdin || '');
  if (!result.success) return res.status(400).json({ error: result.error });
  res.status(200).json(result.trace);
});


module.exports = router;
