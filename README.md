# ScanGrade — frontend / backend split

Two independent projects that talk to each other over HTTP. Deploy them separately,
on separate hosts, with separate release cycles.

```
scangrade-app/
├── frontend/     ← static site, no server logic, deploy to Netlify/Vercel/GitHub Pages
└── backend/      ← Node/Express API, deploy to Render (needs a real server, not static hosting)
```

## What goes in the frontend
Everything the *browser* needs to draw the UI and talk to the API. No secrets, no database,
no AI calls happen here — it only ever calls `fetch()` against the backend.

- `index.html` — the entire UI: login screen, admin/teacher/student dashboards, icons, theme,
  camera capture, file upload, modals. All rendering and DOM logic.
- `config.js` — exactly one line that matters: `window.SCANGRADE_API_BASE`, the URL of your
  deployed backend. This is the only thing you edit when you move from local dev to production.

The frontend holds a JWT in `localStorage` after login and attaches it to every API call —
that's the only "state" it manages. It never sees your Gemini/Anthropic key.

## What goes in the backend
Everything that needs to be trusted: passwords, sessions, the database, and your AI API key.

- `server.js` — the whole API: login/auth, admin routes (create/disable teachers, security log),
  teacher routes (create students, grade exams), student routes (view results). Verifies every
  request's JWT and role before doing anything.
- `db.js` — the data layer. Currently a JSON file on disk (`backend/data/db.json`); swap this
  file alone for Postgres/Supabase later without touching `server.js`.
- `.env` (you create this, never commit it) — `GEMINI_API_KEY`, `JWT_SECRET`, admin credentials,
  and `FRONTEND_URL` (which frontend origin is allowed to call this API — CORS).

The backend never serves HTML — it's a pure JSON API. Nothing here is optional to keep private:
if it moved to the frontend, your Gemini key would be visible to anyone who opens dev tools.

## Run both locally
```bash
# Terminal 1 — backend
cd backend
cp .env.example .env
# edit .env: paste your GEMINI_API_KEY, set FRONTEND_URL=http://localhost:5500 (or * for now)
npm install
npm start
# → running on http://localhost:3000

# Terminal 2 — frontend (any static file server works)
cd frontend
python3 -m http.server 5500
# → open http://localhost:5500
```
`frontend/config.js` already points at `http://localhost:3000` by default, so this works out of the box.

## Deploy

**Backend → Render**
1. Push `backend/` to a GitHub repo (or the whole `scangrade-app/` repo, Render lets you set a root directory).
2. Render → New → Web Service → root directory `backend` → build `npm install` → start `npm start`.
3. Env vars: `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
   and `FRONTEND_URL` (set this once you know your frontend's deployed URL, step below).
4. Deploy → you get a URL like `https://scangrade-api.onrender.com`.

**Frontend → Netlify**
1. Push `frontend/` to a repo (or a subfolder of one).
2. Netlify → Add new site → deploy that folder as-is (no build command needed, it's static).
3. Before deploying, edit `frontend/config.js`:
   ```js
   window.SCANGRADE_API_BASE = 'https://scangrade-api.onrender.com';
   ```
4. Deploy → you get a URL like `https://scangrade.netlify.app`.
5. Go back to Render and set `FRONTEND_URL=https://scangrade.netlify.app` on the backend, so only
   your frontend can call your API. Redeploy the backend for it to take effect.

## Why split them at all
- You can redeploy the UI without touching the server (or vice versa).
- The backend can be swapped to a different host (Railway, Fly, your own VPS) without the frontend
  caring — it only needs the new URL in `config.js`.
- It's the shape real production apps take, so this maps directly onto what you'd explain in a
  demo or a report: "frontend," "backend," "database," as three distinct, honest pieces.

## HTTPS
Render and Netlify both give you `https://` automatically — free SSL, nothing to configure.
The `http://localhost:3000` in `config.js` is only for testing on your own machine and never
touches the internet; it gets replaced with your `https://...onrender.com` URL before you deploy.
If you ever host the backend somewhere that does *not* auto-provide HTTPS (a bare VPS, for
example), set `FORCE_HTTPS=true` in that host's env vars and the server will redirect any HTTP
request to HTTPS itself.

## Same caveats as before
- Free-tier Render disk is ephemeral — fine for demos, swap `db.js` for a real database for anything long-term.
- Change `JWT_SECRET` and `ADMIN_PASSWORD` before deploying.
- Never commit `.env` or your API key.
