const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Helper to escape user-provided values (tiny and safe for this demo)
function esc(s) {
  return String(s || '').replace(/[&<>\"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Root: a playful EnvZilla preview page. Accepts optional query params:
// ?pr=123&branch=feature-xyz to show where this preview came from.
app.get('/', (req, res) => {
  const pr = esc(req.query.pr) || 'unknown';
  const branch = esc(req.query.branch) || 'detached-head';
  const time = new Date().toISOString();

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>EnvZilla Preview — PR ${pr}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body{font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:2rem;background:#0f172a;color:#e6eef8}
      .card{background:#071024;padding:1.6rem;border-radius:12px;box-shadow:0 8px 30px rgba(2,6,23,.6)}
      h1{margin:0 0 .25rem;color:#7ee7c6}
      p.small{color:#9fb4c9;margin:.25rem 0}
      .badge{display:inline-block;background:#1f2937;color:#c7f9e3;padding:.2rem .6rem;border-radius:999px;font-weight:600}
      footer{margin-top:1.2rem;color:#7a98b3;font-size:.9rem}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>EnvZilla Preview 🔥🦖</h1>
      <div class="badge">PR: ${pr}</div>
      <div class="badge" style="margin-left:.5rem">branch: ${branch}</div>
      <p class="small">This is a live preview environment automatically created for your pull request. It is ephemeral — fang it, test it, then let it sleep.</p>

      <section style="margin-top:1rem">
        <h2 style="margin:.5rem 0;color:#bfe9d7">Quick checks</h2>
        <ul>
          <li>Server time: <strong>${time}</strong></li>
          <li>Preview URL: <strong>${esc(req.protocol + '://' + req.get('host') + req.originalUrl)}</strong></li>
          <li>Status: <span style="color:#9ff7a8;font-weight:700">Ready for QA ✅</span></li>
        </ul>
      </section>

      <section style="margin-top:1rem">
        <h2 style="margin:.5rem 0;color:#bfe9d7">Notes from the beast</h2>
        <p class="small">EnvZilla says: "Don't feed me sensitive secrets. I like logs, not your API keys."</p>
      </section>

      <footer>
        <div>Built with 🤖 + ☕ by EnvZilla</div>
      </footer>
    </div>
  </body>
</html>`);
});

// Health endpoint for orchestration
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`EnvZilla sample app roaring on port ${PORT} — press CTRL+C to calm the beast`);
});