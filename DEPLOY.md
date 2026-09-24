# Deploying

This app needs: Postgres, one environment with normal outbound internet access (for
OpenRouter and your IMAP/SMTP mailbox), and a public URL (for tracking links to resolve).
Below: Coolify (Docker-based) and Railway both work — pick one.

## Coolify

1. Push this repo to GitHub/GitLab, then in Coolify: **New Resource → Application →
   Public/Private Repository**, pointing at it. Coolify will detect the `Dockerfile` and
   build from it (no Nixpacks guesswork needed).
2. Add a **Postgres** resource in the same Coolify project. Copy its internal connection
   string.
3. On the app resource, under **Environment Variables**, set:
   - `DATABASE_URL` — the Postgres connection string from step 2
   - `SESSION_SECRET` — any long random string
   - `CREDENTIAL_ENCRYPTION_KEY` — generate locally with
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
     and paste the output
   - `PUBLIC_URL` — the domain Coolify assigns this app (required for tracking links)
   - `PLATFORM_OPENROUTER_API_KEY` — optional platform-wide fallback key
4. Set the **Health Check Path** to `/healthz` in Coolify's app settings (the Dockerfile
   already exposes port 3000 and the app listens on `process.env.PORT`, which Coolify
   sets automatically).
5. Deploy. Migrations run automatically on boot — no separate migration step needed.

I built and booted this exact image's install/boot sequence (production-only
`npm install`, `NODE_ENV=production`, fresh database) locally before handing this off —
confirmed `/healthz` responds and migrations apply cleanly on a database that's never
seen this schema before. I could not build the actual Docker image itself (no Docker in
my environment), so the one thing to watch on first deploy is the build step itself —
if it fails, it's almost certainly a Docker-layer issue, not an application one.

## Railway (alternative)

## 1. Push this to GitHub

```
cd outreach-platform
git init
git add .
git commit -m "Initial outreach platform"
```
Push it to a new GitHub repo, then in Railway: **New Project → Deploy from GitHub repo**.

## 2. Add Postgres

In the Railway project: **New → Database → Add PostgreSQL**. Railway automatically injects
`DATABASE_URL` into your app's environment — you don't need to set it by hand.

## 3. Set environment variables

On the app service (not the Postgres one), under **Variables**, add:

| Variable | How to get it |
|---|---|
| `SESSION_SECRET` | Any long random string |
| `CREDENTIAL_ENCRYPTION_KEY` | Run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` locally and paste the output |
| `PLATFORM_OPENROUTER_API_KEY` | Optional — a platform-wide fallback key from openrouter.ai. Individual users can also set their own key under Settings instead. |
| `PUBLIC_URL` | Your Railway domain, e.g. `https://your-app.up.railway.app` — **required** for open/click tracking links to work; without it, tracking silently no-ops. |

`PORT` is set automatically by Railway — don't set it yourself.

## 4. Deploy

Railway builds and starts the app (`npm start`), which runs database migrations
automatically on boot before listening — you don't need a separate migration step.
`railway.json` is already configured with a `/healthz` healthcheck.

## 5. First run

1. Visit your Railway URL → you'll land on `/signup.html` → create an account.
2. **Mailboxes** → Add mailbox. For Spacemail, both IMAP and SMTP host are typically
   `mail.spacemail.com` (IMAP port 993, SMTP port 465) — check your Spacemail control
   panel if that doesn't work. Use **Test** before relying on it.
3. **Settings** → add your OpenRouter API key (or rely on the platform key if you set one).
4. **Client types** → add one, with tone notes, a skeleton, and 1-2 example emails.
5. **Assets** → add your demo link, booking link, and any case study files.
6. **Contacts** → add or import a few real contacts.
7. From a contact row, **Generate email** → review the draft → **Send now**. Confirm it
   actually shows up in Spacemail's own Sent folder — that's the core thing this rebuild
   was for.
8. Try a real reply from another inbox to that email, and confirm (within a few minutes)
   that it shows up as a `replied` event and stops any sequence enrollment for that contact.

## Known limitations to know about before relying on this

- **Single Node process.** The background workers (send jobs, sequence scheduler, reply
  poller) run as `setTimeout` loops inside the same process as the web server. This is
  fine for one Railway instance. If you ever scale to multiple instances, these loops
  need to move to a separate worker process (or a proper job queue) so they don't run
  redundantly on every instance.
- **No rate-limiting on login/signup.** Add this before exposing the app publicly beyond
  your own team.
- **File assets are stored in Postgres** (not local disk), which is the right call for a
  PaaS with an ephemeral filesystem — but keep attachments to normal case-study/one-pager
  sizes (a few MB), not large media.
