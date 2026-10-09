# SmartCare AI: frontend (no build, no install)

**To run: double-click `index.html`.** That's it. No Node, npm or Vite is needed.

## Connect it to your backend
Open `config.js` and set the one line:

    window.SMARTCARE_API_BASE = "http://localhost:8787";

Until a backend answers, every screen shows an honest "Can't reach the server" message with a Try again button. Nothing is faked.

Because the page is opened from disk, your backend must allow cross-origin requests (CORS). Alternatively, serve this folder from the backend itself and set the base to `""`.

## Screens (hash routes)
| Address | Who | What |
|---|---|---|
| `index.html#/` | public | Landing page |
| `#/register` | public | Patient registration |
| `#/token/<token>` | public | Token and status (refreshes every 15 s) |
| `#/queue` | public | Live board: tokens, departments, statuses only (every 10 s) |
| `#/staff/login` | staff | Sign-in, checked by the backend |
| `#/staff` | staff | Dashboard: counts, search, filters, queue |
| `#/staff/patients/<id>` | staff | Patient details and triage form |

## API the frontend expects (all under `/api`)
The full contract is at the top of `app.js`. To match a different backend, change the small `api` object in that file.

| Method and path | Auth |
|---|---|
| `GET /departments` | none |
| `POST /patients/register` | none |
| `GET /patients/status/:token` | none |
| `GET /queue/public` | none |
| `POST /staff/login` | none |
| `GET /staff/patients`, `GET /staff/patients/:id`, `PATCH /staff/patients/:id/triage` | Bearer token |

## Files
- `index.html`, `app.js`, `config.js`, `styles.css`, `favicon.svg`, `fonts/`: the whole site.
- `input.css`: only needed if you add new styling classes and want to rebuild `styles.css` with the Tailwind CLI. You can ignore it otherwise.
