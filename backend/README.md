# Klosr backend

Vercel serverless functions that power the Klosr Chrome extension.

## Layout

```
backend/
├── api/                       # One file per endpoint — Vercel routes them automatically
│   ├── analyze.js             # Brief generation (sales / interview / pitch)
│   ├── chat.js                # Follow-up questions
│   ├── email.js               # Cold / follow-up email drafts
│   ├── find-email.js          # Apollo People Match email lookup
│   ├── autofill-context.js    # Infer user's company fields from their LinkedIn profile
│   ├── import-from-memory.js  # Parse pasted Claude memory into structured fields
│   ├── learn-icp.js           # Distil won/lost outcomes into an empirical ICP
│   └── ninjapear.js           # External enrichment layer (pluggable — see below)
├── lib/
│   ├── claude.js              # Anthropic SDK wrapper + web search tool
│   ├── cors.js                # CORS preamble shared by every handler
│   └── prompts.js             # System prompts for each mode
├── package.json
├── vercel.json
└── .env.example
```

## Deploy

```bash
cd backend
npm install
vercel deploy --prod
```

Vercel picks up `api/*.js` automatically. Each file exports a default async handler
`(req, res)` and becomes a route at `/api/<filename>`.

## Required env vars

See `.env.example`. Set them in **Vercel → Project → Settings → Environment Variables**.

Minimum to get working:

| Var                  | Needed by                 | Notes |
|----------------------|---------------------------|-------|
| `ANTHROPIC_API_KEY`  | every endpoint that uses Claude | required |
| `APOLLO_API_KEY`     | `/api/find-email`         | Apollo.io People Match. 402 returned if missing. 1 credit per successful reveal. |
| `PROXYCURL_API_KEY`  | `/api/ninjapear`          | Proxycurl (nubela.co) key — empty `{}` returned if missing (fails open) |
| `NINJAPEAR_API_KEY`  | `/api/ninjapear`          | legacy alias for `PROXYCURL_API_KEY`; either works |
| `SERPAPI_API_KEY`    | `/api/analyze`, `/api/chat` | Live Google search via SerpApi. Powers every brief + chat web signal. Without it, briefs still generate but have no fresh web data. |
| `CLAUDE_MODEL`       | every Claude call         | defaults to `claude-opus-4-7` |

## Pointing the extension at your deployment

The extension hits a fixed base URL. Open `../content.js` and replace
`https://api-endpoint-seven.vercel.app` with your deployment URL in these
constants at the top of the file:

```js
const API_URL            = "<your-url>/api/analyze";
const CHAT_URL           = "<your-url>/api/chat";
const EMAIL_URL          = "<your-url>/api/email";
const AUTOFILL_URL       = "<your-url>/api/autofill-context";
const FIND_EMAIL_URL     = "<your-url>/api/find-email";
const IMPORT_MEMORY_URL  = "<your-url>/api/import-from-memory";
const LEARN_ICP_URL      = "<your-url>/api/learn-icp";
const NINJAPEAR_URL      = "<your-url>/api/ninjapear";
```

Then reload the extension in `chrome://extensions`.

## NinjaPear — Proxycurl-backed enrichment

`api/ninjapear.js` wraps [Proxycurl](https://nubela.co/proxycurl). For every
brief / email / chat it calls:

1. `GET /proxycurl/api/v2/linkedin?url=<profileUrl>` — person profile
   (experiences, education, posts, skills, activities)
2. `GET /proxycurl/api/v2/linkedin/company?url=<companyUrl>` — company
   profile (description, size, HQ, funding, recent updates) — only if the
   person lookup resolves a current-company URL

The response is compacted (most fields trimmed or dropped) and returned
as `{ source: "proxycurl", person: {...}, company: {...} }`. This object
flows into the Claude prompt via the `VERIFIED ENRICHMENT (NinjaPear)`
block, so the model can cite facts with source tag `(NinjaPear)`.

**Key** goes in `PROXYCURL_API_KEY` (or `NINJAPEAR_API_KEY`, aliased).
Get one at https://nubela.co/dashboard/api/#keys. Missing key → handler
returns `{}` and every downstream call silently skips enrichment.
