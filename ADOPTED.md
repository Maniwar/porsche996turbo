# 2003 Porsche 911 Turbo — AI concierge (adopted via concierge-kit)

Stamped 2026-07-10 from concierge-kit engine version
`98addb6231e80522a341d18b67f8d113b43db291` in **inquiry mode**.

## What was stamped into this output

| file | what it is |
| --- | --- |
| `embed-snippet.html` | copy-pasteable block for the product page: config global, state bridge, script tags |
| `assets/concierge.js` | the concierge widget, branded for 2003 Porsche 911 Turbo |
| `assets/concierge-kb.js` | client knowledge base (demo answers, starters, greeting) built from generated content |
| `admin.html` | the Concierge Studio — owner back-office (deploy next to the page, e.g. `/admin.html`) |
| `supabase/setup.sql` | complete idempotent backend schema + generated seeds (run in the Supabase SQL editor or let the deploy workflow apply it) |
| `supabase/functions/concierge/` | the edge function (index.ts, kb.ts, beats.ts, beats_test.ts) |
| `.github/workflows/deploy-concierge.yml` | deploys the function + schema, sets secrets, live-smokes the endpoint |
| `.github/workflows/conformance.yml` | weekly proof the admin knobs are connected (needs the evals harness) |
| `.github/workflows/persona.yml` | weekly advisory persona evals (needs the evals harness) |

Inquiry mode means **no checkout**: `checkout.js` and the commission edge
function are deliberately absent, the widget's commission button never
renders, and the generated content never offers it. Reserving happens the way
the page says it does (write to mberenji@gmail.com).

## What you must do next

1. **Provision Supabase** — either run `adopt provision`, or by hand: create a
   project, then fill the empty values in `embed-snippet.html`
   (`endpoint`, `supabaseUrl`, `supabaseAnonKey`) and the
   `SUPABASE_URL` / `SUPABASE_ANON_KEY` consts near the top of the script in
   `admin.html`, and re-deploy those files. Until then the widget runs in
   demo mode and the Studio shows its setup notice.
2. **Paste `embed-snippet.html`** just before `</body>` on the product page,
   and put `assets/concierge-kb.js` + `assets/concierge.js` where the snippet's
   `src` paths point (`assets/`).
3. **Add the GitHub repository secrets** the workflows need:
   - `SUPABASE_ACCESS_TOKEN` — personal access token (dashboard → Account → Access Tokens)
   - `SUPABASE_PROJECT_REF` — the project ref (the subdomain of your project URL)
   - `SUPABASE_DB_PASSWORD` — database password (best-effort `db push` step)
   - `SUPABASE_DB_URL` — the **Session pooler** connection string (IPv4; used to apply `setup.sql`)
   - `ANTHROPIC_API_KEY` — the model key
   - `RESEND_API_KEY` *(optional)* — transactional email (sign-in keys, notifications)
   - `EMAIL_FROM` *(optional)* — sender for those emails, e.g. `2003 Porsche 911 Turbo <mberenji@gmail.com>`
4. **Run Actions → Deploy Concierge.** It unit-tests the beat engine,
   type-checks, applies `setup.sql`, deploys the function, and smokes the live
   endpoint. A `503` on the chat check at this stage is expected — see below.

## Drafts-first: how enabling works

Everything a shopper could ever hear ships **disabled**:

- the master switch (`concierge_config.enabled`) seeds `false` — the endpoint
  answers 503 and the widget stays quietly in demo mode;
- every generated KB entry, SOP, form and goal seeds `enabled = false`;
- the generated evals seed `enabled = true` — they are the safety net you run
  *before* switching anything on.

To go live: open the Studio (`admin.html`), sign in with an admin address,
review every draft (Knowledge, SOPs, Forms, Goals — edit freely, enabling each
row as you approve it), run the evals, and only then flip the master switch in
Tuning. Nothing you have not personally enabled can reach a shopper.

## Typography note

The widget ships **no webfonts**. `typography.display` / `mono` / `body` in
your site config should name fonts the target page already loads — a
font-family stack that names an unloaded font silently falls back to the next
family in the stack, which is safe but plain.

## Evals harness

`conformance.yml` and `persona.yml` (and the advisory eval step in the deploy
workflow) expect an `evals/` harness in this repository; they skip themselves
with a notice until it is adopted in a later kit phase.
