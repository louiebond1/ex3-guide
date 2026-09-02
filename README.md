# EX3 SmartRecruiters Guide — Handover

Written 2026-09-02 for whoever inherits this from Louie.

## What this is

An implementation/enablement guide site for SmartRecruiters, with an AI
assistant (chat + voice + WhatsApp) that answers questions grounded in an
OpenAI vector store of your knowledge docs. Also hosts a separate,
PIN-protected "Implementation HQ" area (SOW builder, cost estimator,
discovery tools) for internal consultants.

## Where things live

- **Live site**: https://ex3-guide-production.up.railway.app
- **Code**: `github.com/louiebond1/ex3-guide` — ⚠️ **this is Louie's personal
  GitHub account, not a company org.** See below.
- **Hosting**: Railway, project `hearty-clarity`, service `ex3-guide`
- **Code on this laptop**:
  `Documents/Codex/2026-05-27/whats-my-usage-limits/ex3-guide`

## ⚠ Do this first: get the code and hosting off personal accounts

Both the GitHub repo and the Railway project currently sit under Louie's
personal accounts, not company ones. Unlike a Railway project (which can be
transferred in the dashboard), **a GitHub repo under a personal account is
the bigger risk** — if that account is closed or access is revoked, the
company could lose the entire commit history with no warning.

Before Louie's last day:
1. Transfer the GitHub repo (`louiebond1/ex3-guide`) to a company GitHub
   org, or have someone with access create a company-owned fork/mirror and
   switch the `origin` remote and Railway's deploy source over to it.
2. Transfer the Railway project (`hearty-clarity`) to a company Railway
   team (Settings → Transfer Project), or redeploy from the migrated repo
   under a company Railway account.
3. Confirm who owns and pays for the API keys this depends on (see below) —
   if any are on Louie's personal accounts, rotate them to company-owned
   keys.

## Environment variables

No `.env.example` existed before this handover — here's everything the code
actually reads (grep `process.env` in `server.js`/`setup.js` to re-confirm
if code changes later):

- `OPENAI_API_KEY` — powers the assistant, TTS, and the eval harness.
- `ASSISTANT_ID`, `VECTOR_STORE_ID` — set automatically by `node setup.js`
  (see below); the assistant won't work without these.
- `OPENAI_ASSISTANT_MODEL` / `OPENAI_MODEL` / `OPENAI_TEXT_MODEL` — optional
  model overrides, sensible defaults exist in code.
- `DID_API_KEY` — D-ID, powers the talking-avatar video feature.
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` — voice synthesis.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` —
  WhatsApp integration.
- `ANALYTICS_PASSWORD` — gates the analytics dashboard.
- `IMPL_HQ_PASSWORD` — gates the Implementation HQ area (also has a UI
  unlock: tap the sidebar logo 5 times within 3 seconds).
- `PORT` — defaults to 3000, Railway sets this automatically.

To see the actual live values, check Railway → the `ex3-guide` service →
Variables tab. A `.env.local` file (gitignored) can override `.env` locally
for testing without touching real values.

## Setting up the AI assistant from scratch

If `ASSISTANT_ID`/`VECTOR_STORE_ID` are ever lost or you're standing this up
fresh:

```
node setup.js
```

This creates a new OpenAI Assistant + vector store and appends the IDs to
`.env.local` (or `.env` if no `.env.local` exists). It does **not** upload
knowledge documents — that's a separate step (see `sync-knowledge.js` /
`sync-knowledge.ps1` in the repo, and the `knowledge-docs/` folder locally,
which is excluded from git and from Railway deploys via `.railwayignore`
since the docs live in the vector store, not on disk in production).

## Day-to-day operation

- The assistant answers are grounded in whatever's in the OpenAI vector
  store — if SmartRecruiters changes something, update the relevant
  knowledge doc and re-run the sync script, not just the on-page content.
- Each AI answer now shows which source document(s) it cited ("Sources
  used") — useful for spotting when the assistant is drawing from an
  outdated doc.
- Questions get auto-routed by intent (stuck-on-a-step, consultant,
  candidate, general) so the assistant's tone/depth matches who's asking —
  see `classifyAssistantRequest()` in `server.js` if that routing ever needs
  tuning.

## Before deploying a code change

```
npm run check
```

Syntax-checks `server.js`, `impl-hq.js`, `setup.js`, and
`scripts/ai-eval.js`. There's also a small AI answer-quality eval suite:

```
npm run eval:ai
```

(needs the server running locally and `OPENAI_API_KEY` set — grades a set
of test questions against expected/forbidden terms defined in
`evals/smartrecruiters-ai-evals.json`).

Then deploy:

```
railway up --service ex3-guide
```

There's no staging environment — this deploys straight to production.
Check `railway logs` after deploying to confirm it booted cleanly, and load
the live site to sanity-check the assistant still responds.

## State of the code (as of this handover)

Good shape. As of 2026-09-02 there were ~4,000 lines of finished but
uncommitted local work sitting only on this laptop — reviewed, verified
(syntax-checked clean), committed, and deployed as part of this handover:

- Rate limiting on the AI/TTS/voice/avatar/WhatsApp endpoints, and graceful
  "not configured" errors instead of crashing when a key is missing.
- Source-citation display and context-aware question routing (above).
- A real XSS fix: AI-generated chat text was being inserted as raw HTML
  with no escaping; now it's escaped before rendering.
- The `npm run check` / `npm run eval:ai` tooling and the eval suite
  described above.

**Lesson for whoever picks this up**: check `git status` before assuming
what's live matches what's on disk — this repo had a month of real,
un-shipped work sitting locally with no other record of it existing.

## Who to ask

If `impl-hq.js` or `server.js` behavior looks confusing, check
`classifyAssistantRequest()` and `ROUTE_INSTRUCTIONS` in `server.js` first —
a lot of the assistant's tone/behavior is driven from there, not hardcoded
per-page.
