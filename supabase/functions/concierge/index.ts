/**
 * 2003 Porsche 911 Turbo — The Porsche Concierge · AI Sales Concierge v3 (Supabase Edge Function, Deno)
 *
 * v1 proxied streaming chat to the Anthropic Messages API (server-side key,
 * validation, rate limiting, SSE re-shaping). v2 added DB-driven config + KB,
 * GET ?config=1, signed-in order awareness, and conversation logging.
 * v3 adds:
 *   - Register tools (Anthropic tool use) for signed-in owners: the model can
 *     read their orders, change a shipping address before shipment, and cancel
 *     an order that hasn't started weaving. Every mutation is written to
 *     concierge_actions for the admin Studio.
 *   - Standard operating procedures from concierge_sops, injected into the
 *     system prompt so the admin can teach the concierge process.
 *   - A semantic answer cache (pgvector + gte-small embeddings) for anonymous
 *     first-turn questions, editable from the Studio's Cache tab.
 *
 * Wire contract:
 *   GET  <fn>?config=1 -> 200 {"enabled","greeting","starters","auth":true}
 *   POST <fn> {"messages":[{role,content}], "context"?:{}, "session_key"?:str}
 *     -> SSE: data: {"t":"…"} per text delta, then once
 *        data: {"m":{"cid":"<uuid>","mid":<int>}}, then data: [DONE].
 *        v3 may also send data: {"s":"…"} (a status caption while the
 *        concierge works the register) and data: {"c":1} (answer served
 *        from the cache). Unknown keys are ignored by older clients.
 *   Errors: non-200 JSON {"error":"..."} with CORS headers; 503 when disabled.
 *
 * Dependencies: ./kb.ts only — BRAND_SYSTEM / KB_MARKDOWN are the fallbacks
 * when the database is unreachable or empty. All DB access is raw PostgREST
 * over fetch with the service-role key; no supabase-js.
 */

import { BRAND_SYSTEM, KB_MARKDOWN } from "./kb.ts";
import {
  type BeatDecision,
  chooseBeatAction,
  extractSubjects,
  hasPendingAsk,
  PLACEHOLDER_ADDR,
  proposalRestHoursFrom,
  type SalesLedger,
} from "./beats.ts";

// Editable built-in bases. The admin can override each via a concierge_config key
// (voice_base is BRAND_SYSTEM in kb.ts); these two live here and are surfaced for
// editing via ?defaults=1. The client-book base is the fixed "what to record"
// instruction the summarizer runs on; clientbook_policy is layered on top of it.
const CLIENTBOOK_BASE =
  "You keep a shop's private client book. From this conversation, write ONE line (max 200 chars) capturing what is NEWLY worth remembering about THIS visitor for next time: who the car would be for, what they weighed, hesitations, decisions, and — always — SIGNIFICANT EVENTS from this conversation (a serious inquiry sent, a viewing discussed, an offer mentioned). An inquiry or viewing request is always worth a line even if preferences are unchanged. Use concrete facts from the transcript. It is an internal note the visitor never sees — third person, no greeting, no fluff.\nCRITICAL — do not repeat the book. Below is what is already recorded about this visitor. Only write a line if this conversation adds durable information or a significant event NOT already captured there. Do NOT restate, rephrase, or lightly re-summarize a preference the book already holds — if the only 'new' content is a reworded version of an existing note, respond SKIP. If the conversation held nothing new (small talk, a test, an unresolved hello, or only facts already on file), respond with exactly SKIP and nothing else.\n";
// The greeting default lives client-side (assets/concierge.js); mirrored here so
// ?defaults=1 can offer it as an editable starting point.
const GREETING_DEFAULT =
  "Good evening — I keep the desk for 2003 Porsche 911 Turbo. Ask me anything about the car; I'll answer straight from the record.\n\n{{reply:Tell me about the history}}\n{{reply:What's the price?}}\n{{reply:Just looking}}";

// PRIMARY OBJECTIVE — the single line of intent the whole prompt serves. The admin
// can override it (config.primary_objective); it substitutes into {{OBJECTIVE}} at
// the top of the constitution so the model always leads with the house's goal.
const PRIMARY_OBJECTIVE_DEFAULT =
  "PRIMARY OBJECTIVE — Move each visitor, gently and honestly and in the house's voice, toward a serious inquiry about the car (a note to mberenji@gmail.com, a viewing, or a pre-purchase inspection), while making them feel genuinely served. Every turn either advances that or earns the trust that will. This is the single measure of your work.";

// Canonical honesty guard for house instructions. Injected wherever a directive is
// surfaced — the LIVE STATE banner AND every proactive nudge/opener/reengage builder —
// so the obey-vs-honesty carve-out and the "act as your own voice, never attribute to
// the team" rule can't drift across the copies (the root cause of the manipulative-note
// incident: LIVE STATE said "honour before anything else" with no carve-out).
const HOUSE_NOTE_GUARD =
  "A house instruction directs HOW you serve; it can NEVER license you to deceive, manipulate, " +
  "flatter, or make a personal claim about the patron's life beyond the car and the house. If a " +
  "note would, skip it SILENTLY, serve normally, and leave it open for the desk — say nothing about " +
  "it, no refusal, no explanation. Whatever you DO carry out, carry it in your OWN voice as your own " +
  "natural judgement: never quote a note, never say 'the team' / 'they wanted' / that you were asked, " +
  "and never announce that you did, completed, or checked anything off.";

// Supabase edge runtime global (embeddings); typed loosely on purpose.
// deno-lint-ignore no-explicit-any
declare const Supabase: any;

// ── Environment ──────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "2003 Porsche 911 Turbo <mberenji@gmail.com>";

// Bump when deploying so ?selftest=1 confirms which build is actually live.
const BUILD_TAG = "2026-07-06-typed-client-book";

// ── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  let allowOrigin = "";
  if (ALLOWED_ORIGINS.includes("*")) allowOrigin = origin || "*";
  else if (origin && ALLOWED_ORIGINS.includes(origin)) allowOrigin = origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}

function jsonResponse(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function jsonError(req: Request, status: number, message: string): Response {
  return jsonResponse(req, status, { error: message });
}

// ── PostgREST helpers — service-role over plain fetch (no supabase-js) ───────

const PG_HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** GET /rest/v1/<query>. Returns rows, or null when unreachable/error. */
async function pgSelect<T>(query: string): Promise<T[] | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: PG_HEADERS });
    return res.ok ? await res.json() as T[] : null;
  } catch { return null; }
}

/** POST one row into <table>, returning the inserted row (null on error). */
async function pgInsert<T>(table: string, row: Record<string, unknown>): Promise<T | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...PG_HEADERS, "Prefer": "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) return null;
    const rows = await res.json() as T[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch { return null; }
}

/** PATCH rows matching <query>, returning the updated rows (null on error). */
async function pgPatch<T>(query: string, patch: Record<string, unknown>): Promise<T[] | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      method: "PATCH",
      headers: { ...PG_HEADERS, "Prefer": "return=representation" },
      body: JSON.stringify(patch),
    });
    return res.ok ? await res.json() as T[] : null;
  } catch { return null; }
}

/** POST /rest/v1/rpc/<fn>. Returns the result, or null on error. */
async function pgRpc<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: PG_HEADERS,
      body: JSON.stringify(args),
    });
    return res.ok ? await res.json() as T : null;
  } catch { return null; }
}

/** Probe a table/column for existence + row count (for the self-test). A 400
 *  usually means a missing column/table; 200 with count 0 means it's empty. */
async function pgProbe(
  query: string,
): Promise<{ ok: boolean; status: number; count: number | null; error?: string }> {
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, status: 0, count: null, error: "no service key" };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: { ...PG_HEADERS, "Prefer": "count=exact", "Range": "0-0" },
    });
    const total = parseInt((res.headers.get("content-range") ?? "").split("/")[1] ?? "", 10);
    return {
      ok: res.ok,
      status: res.status,
      count: Number.isFinite(total) ? total : null,
      error: res.ok ? undefined : (await res.text()).slice(0, 160),
    };
  } catch (e) {
    return { ok: false, status: 0, count: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Config + KB + SOPs — DB reads cached in module memory for 60 seconds ─────

interface FormDef {
  slug: string; title: string; submit_tool: string; fields: unknown;
}

interface GoalDef {
  slug: string; label: string; description: string;
  section?: string | null;      // legacy single section (kept for back-compat)
  sections?: string[] | null;   // journey stages this goal fits; empty/null = anywhere
}

/** The journey sections a goal fits, lowercased. Prefers the multi-value
 *  `sections` array; falls back to the legacy single `section` column. */
function goalSections(g: GoalDef): string[] {
  if (Array.isArray(g.sections) && g.sections.length > 0) {
    return g.sections.filter((s) => typeof s === "string").map((s) => s.toLowerCase());
  }
  return typeof g.section === "string" && g.section ? [g.section.toLowerCase()] : [];
}

// Admin overrides for the model-callable tools (concierge_tools table). A tool
// absent from this table runs with its built-in default (enabled, code default
// description); a row can disable it or override the model-facing description.
interface ToolReg { name: string; enabled: boolean; description: string | null }

// One enabled SOP row, with its audience so buildSystemPrompt can inject register/
// service procedures only when the shopper is signed in (audience 'signed_in') and
// keep universal ones ('all') always. 'anon' is available for signed-out-only notes.
interface SopRow { slug: string; title: string; content_md: string; audience: string }

interface ConciergeData {
  config: Record<string, unknown> | null; // concierge_config {key: jsonb value}
  kbText: string | null; // enabled concierge_kb rows; null -> KB_MARKDOWN fallback
  sops: SopRow[]; // enabled concierge_sops rows, with audience (may be empty)
  sopText: string | null; // enabled concierge_sops rows, joined; null -> none
  forms: FormDef[]; // enabled concierge_forms rows
  goals: GoalDef[]; // enabled concierge_goals rows
  tools: ToolReg[]; // concierge_tools overrides (may be empty -> all defaults)
  at: number; // Date.now() of the read; refreshed after CACHE_TTL_MS
}

const CACHE_TTL_MS = 60_000;
let dataCache: ConciergeData | null = null;

// Which model answers. Precedence, most to least specific:
//   1. config.model          — the admin's explicit choice (Tuning → Model)
//   2. config.model_fallback  — the admin's configured fallback (Tuning)
//   3. MODEL env var          — an ops-set default (survives a DB-config read failure)
//   4. DEFAULT_MODEL          — the built-in last resort
// Nothing here is a magic string scattered across call sites: every model
// decision goes through resolveModel() so the fallback is configurable, not
// hard-coded. Kept cheap by default so a config blip degrades DOWN, not up.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
function resolveModel(data: ConciergeData): string {
  const c = data.config || {};
  if (typeof c.model === "string" && c.model.trim()) return c.model.trim();
  if (typeof c.model_fallback === "string" && c.model_fallback.trim()) return c.model_fallback.trim();
  return Deno.env.get("MODEL") || DEFAULT_MODEL;
}

// The model used to GRADE conversation goals (live and on re-grade). Admin can pick a
// separate one (config.grader_model) — e.g. a stronger judge — without changing what
// answers shoppers; blank falls back to the concierge model.
function graderModel(data: ConciergeData): string {
  const gm = data.config?.grader_model;
  return typeof gm === "string" && gm.trim() ? gm.trim() : resolveModel(data);
}

async function loadConciergeData(): Promise<ConciergeData> {
  if (dataCache && Date.now() - dataCache.at < CACHE_TTL_MS) return dataCache;
  const [cfgRows, kbRows, sopRowsRaw, formRows, goalRows, toolRows] = await Promise.all([
    pgSelect<{ key: string; value: unknown }>("concierge_config?select=key,value"),
    pgSelect<{ title: string; content_md: string }>(
      "concierge_kb?select=title,content_md&enabled=is.true&order=sort_order.asc",
    ),
    // Prefer the audience-aware select; if the column isn't present yet (a function
    // deployed before setup.sql ran), fall back to the plain select and treat every
    // SOP as 'all' so procedures never silently vanish mid-migration.
    pgSelect<SopRow>(
      "concierge_sops?select=slug,title,content_md,audience&enabled=is.true&order=sort_order.asc",
    ),
    pgSelect<FormDef>(
      "concierge_forms?select=slug,title,submit_tool,fields&enabled=is.true",
    ),
    pgSelect<GoalDef>(
      "concierge_goals?select=slug,label,description,section,sections&enabled=is.true&order=sort_order.asc",
    ),
    pgSelect<ToolReg>("concierge_tools?select=name,enabled,description"),
  ]);
  let sopRows: SopRow[] | null = sopRowsRaw;
  if (!sopRows) {
    const plain = await pgSelect<{ slug: string; title: string; content_md: string }>(
      "concierge_sops?select=slug,title,content_md&enabled=is.true&order=sort_order.asc",
    );
    sopRows = plain ? plain.map((r) => ({ ...r, audience: "all" })) : null;
  }
  const sops: SopRow[] = (sopRows ?? []).map((r) => ({
    slug: r.slug, title: r.title, content_md: r.content_md,
    audience: typeof r.audience === "string" && r.audience.trim() ? r.audience.trim() : "all",
  }));
  dataCache = {
    config: cfgRows && cfgRows.length > 0
      ? Object.fromEntries(cfgRows.map((r) => [r.key, r.value]))
      : null,
    kbText: kbRows && kbRows.length > 0
      ? kbRows.map((r) => `## ${r.title}\n${r.content_md}`).join("\n\n")
      : null,
    sops,
    sopText: sops.length > 0
      ? sops.map((r) => `### ${r.title}\n${r.content_md}`).join("\n\n")
      : null,
    forms: formRows ?? [],
    goals: goalRows ?? [],
    tools: toolRows ?? [],
    at: Date.now(),
  };
  return dataCache;
}

// ── Rate limiting — DB-backed fixed window (shared across all edge instances),
//    with a per-instance in-memory fallback if the DB/RPC is unreachable ───────

const RATE_LIMIT = 20; // requests per window
const RATE_WINDOW_SEC = 10 * 60; // 10 minutes
const RATE_WINDOW_MS = RATE_WINDOW_SEC * 1000;
const hits = new Map<string, number[]>(); // ip -> request timestamps (fallback only)

/** Per-instance sliding window — only used when the shared DB limiter can't be
 *  reached, so a database hiccup still leaves *some* protection in place. */
function rateLimitedLocal(key: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  for (const [k, times] of hits) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(k);
    else hits.set(k, fresh);
  }
  const recent = hits.get(key) ?? [];
  if (recent.length >= limit) return true;
  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Shared, DB-backed limiter (one window across every instance). Returns true
 *  when the caller is over the limit. Fails over to the per-instance counter on
 *  any DB error, so it never blocks legitimate traffic on an outage. */
async function rateLimited(key: string, limit = RATE_LIMIT): Promise<boolean> {
  const over = await pgRpc<boolean>("rate_hit", {
    p_key: key, p_limit: limit, p_window_seconds: RATE_WINDOW_SEC,
  });
  if (over === null) return rateLimitedLocal(key, limit); // DB unreachable
  return over === true;
}

// ── Validation — v1 rules plus optional session_key (<= 64 chars) ────────────

interface ChatMessage { role: "user" | "assistant"; content: string }

interface ValidatedBody {
  messages: ChatMessage[]; context: Record<string, unknown>; sessionKey: string | null;
}

function validateBody(body: unknown): ValidatedBody | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const { messages, context, session_key } = body as Record<string, unknown>;
  if (context !== undefined &&
    (typeof context !== "object" || context === null || Array.isArray(context))) {
    return "context, if provided, must be an object.";
  }
  const ctxObj = (context ?? {}) as Record<string, unknown>;
  // A proactive opener (the bot greeting a returning visitor) may carry no prior
  // messages — the handler injects its own instruction.
  const isOpener = ctxObj.opener === "reengage" || ctxObj.opener === "greet";
  if (!Array.isArray(messages) || messages.length > 20 || (messages.length < 1 && !isOpener)) {
    return "messages must be an array of up to 20 items.";
  }
  for (const m of messages) {
    if (typeof m !== "object" || m === null) return "Each message must be an object.";
    const { role, content } = m as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") return "Each message role must be 'user' or 'assistant'.";
    if (typeof content !== "string" || content.length === 0 || content.length > 2000) {
      return "Each message content must be a non-empty string of at most 2000 characters.";
    }
  }
  if (context !== undefined &&
    (typeof context !== "object" || context === null || Array.isArray(context))) {
    return "context, if provided, must be an object.";
  }
  if (session_key !== undefined &&
    (typeof session_key !== "string" || session_key.length > 64)) {
    return "session_key, if provided, must be a string of at most 64 characters.";
  }
  return {
    messages: messages as ChatMessage[],
    context: (context ?? {}) as Record<string, unknown>,
    sessionKey: typeof session_key === "string" && session_key ? session_key : null,
  };
}

// ── Signed-in awareness — verify Supabase Auth JWT, pull the user's orders ───

interface Customer { id: string; email: string | null }
interface OrderRow {
  serial: number | null; status: string | null; tracking: string | null;
  variant: string | null; address: string | null; address2: string | null;
  city: string | null; state: string | null; zip: string | null;
  placed_at: string | null; recipient_name?: string | null; is_gift?: boolean;
  cancelled_serial?: number | null; name?: string | null;
}

// ── Transactional email (cancellation) ───────────────────────────────────────
// The concierge places nothing, but it *can* cancel — so it owns the
// cancellation note. Placement/shipment emails live in the commission function.

const EMAIL_VARIANT: Record<string, string> = {
  "as-listed": "As listed", "unused-2": "(unused)", "unused-3": "(unused)",
};

/** Fire-and-forget async work that must not block or fail the response. */
function bg(p: Promise<unknown>): void {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else (p as Promise<unknown>).catch(() => {});
  } catch { (p as Promise<unknown>).catch(() => {}); }
}

/** Best-effort email via Resend's API. Never throws. When `meta` is given the
 *  attempt is recorded in email_log (so the admin sees it and can re-send). */
async function sendEmail(
  to: string, subject: string, html: string,
  meta?: { kind: string; serial?: number | null },
): Promise<void> {
  if (!to) return;
  let ok = false;
  let providerId: string | null = null;
  let error: string | null = null;
  if (!RESEND_API_KEY) {
    error = "email not configured (no RESEND_API_KEY)";
  } else {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
      });
      ok = res.ok;
      const body = await res.json().catch(() => null) as { id?: string; message?: string } | null;
      if (ok) providerId = body?.id ?? null;
      else error = (body?.message ?? `HTTP ${res.status}`).slice(0, 300);
    } catch (e) {
      error = String(e).slice(0, 300);
    }
  }
  if (meta) {
    await pgInsert("email_log", {
      to_email: to, kind: meta.kind, serial: meta.serial ?? null,
      subject, ok, provider_id: providerId, error,
    });
  }
}

function emailShell(heading: string, lines: string[]): string {
  const body = lines.filter(Boolean).map((l) =>
    `<tr><td style="padding:0 34px 14px;font-family:Helvetica,Arial,sans-serif;color:#c9c3b6;font-size:14px;line-height:1.6;">${l}</td></tr>`
  ).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1c211d;margin:0;padding:32px 0;"><tr><td align="center">` +
    `<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="width:440px;max-width:92%;background:#232a25;border:1px solid #3a4139;border-radius:14px;overflow:hidden;">` +
    `<tr><td style="padding:30px 34px 4px;font-family:Georgia,serif;color:#f0eceb;font-size:26px;letter-spacing:.5px;">2003 Porsche 911 Turbo</td></tr>` +
    `<tr><td style="padding:0 34px 20px;font-family:'Courier New',monospace;color:#d3b88e;font-size:10px;letter-spacing:3px;text-transform:uppercase;">2003 Porsche 911 Turbo</td></tr>` +
    `<tr><td style="padding:0 34px;border-top:1px solid #3a4139;"></td></tr>` +
    `<tr><td style="padding:24px 34px 8px;font-family:Georgia,serif;color:#f0eceb;font-size:19px;line-height:1.35;">${heading}</td></tr>` +
    body +
    `<tr><td style="padding:12px 34px 24px;border-top:1px solid #3a4139;font-family:Helvetica,Arial,sans-serif;color:#7f7a6e;font-size:11px;line-height:1.6;">An automated note from the concierge's ledger. This is a demo — nothing ships and no payment is taken. mberenji@gmail.com</td></tr>` +
    `</table></td></tr></table>`;
}

function fmtEmailDate(v?: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
/** "Placed X · cancelled Y." for the cancellation note. cancelled defaults to now
 *  (the note is sent the instant the strike happens); placed comes from the order. */
function struckDatesLine(placedAt?: string | null, cancelledAt?: string | null): string {
  const placed = fmtEmailDate(placedAt);
  const cancelled = fmtEmailDate(cancelledAt) || fmtEmailDate(new Date().toISOString());
  if (placed && cancelled) return `Placed <strong>${placed}</strong> · cancelled <strong>${cancelled}</strong>.`;
  if (cancelled) return `Cancelled <strong>${cancelled}</strong>.`;
  return "";
}

/** The cancellation note, mirroring the commission function's 'cancelled' email. */
function cancelEmail(
  serial: number, name?: string | null, variant?: string | null, placedAt?: string | null,
): { subject: string; html: string } {
  const no = "Nº " + Number(serial).toLocaleString("en-US");
  const first = (name ?? "").trim().split(/\s+/)[0] || "";
  const greet = first ? `${first},` : "Hello,";
  const cloth = variant && EMAIL_VARIANT[variant] ? ` in ${EMAIL_VARIANT[variant]}` : "";
  return {
    subject: `${no} — cancelled`,
    html: emailShell("Struck from the register", [
      `${greet} as you asked, <strong>${no}</strong>${cloth} has been cancelled, and the number returns to the edition.`,
      struckDatesLine(placedAt, null),
      "Nothing was charged — this is a demo. If it was in error, just say the word and we'll set it right.",
    ]),
  };
}

/** Verified user, or null (absent / anon key / invalid token — never errors). */
async function verifyUser(req: Request): Promise<Customer | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  // The anon (or service) key arriving as the bearer means "not signed in".
  if (!token || token === ANON_KEY || token === SERVICE_KEY) return null;
  if (!SUPABASE_URL || !ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": ANON_KEY, "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json() as Record<string, unknown>;
    if (typeof user?.id !== "string") return null;
    return { id: user.id, email: typeof user.email === "string" ? user.email : null };
  } catch { return null; }
}

/** PostgREST ownership filter: orders tied to this user's id OR email. */
function ownershipFilter(customer: Customer): string {
  const safeEmail = customer.email?.replace(/["\\,()]/g, "");
  return safeEmail
    ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
    : `user_id=eq.${encodeURIComponent(customer.id)}`;
}

async function myOrders(
  customer: Customer, includeCancelled = false, variant?: string,
): Promise<OrderRow[] | null> {
  const cw = variant && ["as-listed", "unused-2", "unused-3"].includes(variant)
    ? `&variant=eq.${variant}` : "";
  return await pgSelect<OrderRow>(
    "orders?select=serial,status,tracking,variant,address,address2,city,state,zip,placed_at,recipient_name,is_gift,cancelled_serial,name" +
      (includeCancelled ? "" : "&status=neq.cancelled") + cw +
      `&${ownershipFilter(customer)}&order=placed_at.desc&limit=500`,
  );
}

/** Builds the CUSTOMER line for LIVE STATE (orders via service-role call). */
// `opening` = true only on the actual opening beat of a visit (a proactive opener, or
// the first turn with no assistant reply yet). The RE-ENGAGEMENT "greet like someone
// returning" banner and the directive's "on your very first line of the visit" framing
// are opening-beat instructions — printing them mid-conversation makes the model re-greet
// every turn (the current live conversation is never `lastConvo`, so the banner would
// otherwise be byte-identical on every turn).
async function customerBlock(customer: Customer, opening = true): Promise<string> {
  const safeEmail = customer.email?.replace(/["\\,()]/g, "");
  const noteFilter = safeEmail
    ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
    : `user_id=eq.${encodeURIComponent(customer.id)}`;
  const notesP = pgSelect<{ note: string; created_at: string; kind: string | null }>(
    `customer_notes?select=note,created_at,kind&${noteFilter}&order=created_at.desc&limit=14`,
  );
  // Open HOUSE DIRECTIVES — instructions a human admin left for this patron that
  // the concierge MUST follow. Fetched separately (and unbounded by the 14-note
  // window) so a stack of recent AI notes can never bury a standing instruction.
  // Newest-first: a just-added instruction is the most likely to matter, and must
  // never fall outside the window when several are open.
  const directivesP = pgSelect<{ id: number; note: string; created_at: string }>(
    `customer_notes?select=id,note,created_at&${noteFilter}&kind=eq.directive&resolved=eq.false&order=created_at.desc&limit=12`,
  );
  // Consolidated CLIENT SUMMARY — a rolling digest of the AI's own book, if one
  // has been generated. When present it is the primary memory injected each turn
  // (instead of the whole raw pile), keeping the uncached tail small and the
  // directives unmissable; older raw detail is reachable via recall_context.
  const summaryP = pgSelect<{ note: string; created_at: string }>(
    `customer_notes?select=note,created_at&${noteFilter}&kind=eq.summary&order=created_at.desc&limit=1`,
  );
  // Re-engagement: the last conversation we wrapped (snoozed or closed). If one
  // exists, THIS is a fresh visit picking the thread back up, not a first hello.
  const lastConvoP = pgSelect<{ ended_at: string; status: string; section: string | null }>(
    `concierge_conversations?select=ended_at,status,section&user_id=eq.${
      encodeURIComponent(customer.id)}&ended_at=not.is.null&order=ended_at.desc&limit=1`,
  );
  const all = await myOrders(customer, true);
  const notes = await notesP;
  const directives = await directivesP;
  const clientSummary = await summaryP;
  const lastConvo = await lastConvoP;
  const orders = all ? all.filter((o) => o.status !== "cancelled") : null;
  const struck = all ? all.length - (orders?.length ?? 0) : 0;
  const fmt = (o: OrderRow) =>
    [
      `Nº ${o.serial ?? o.cancelled_serial ?? "—"} — ${o.status ?? "status unknown"}`,
      o.is_gift && o.recipient_name && `a gift for ${o.recipient_name}`,
      o.tracking && `tracking ${o.tracking}`,
      o.city && `to ${o.city}`,
      o.placed_at && `placed ${String(o.placed_at).slice(0, 10)}`,
    ].filter(Boolean).join(", ");
  let summary = "no orders on file";
  let standing = "";
  if (orders && orders.length > 0) {
    const delivered = orders.filter((o) => o.status === "delivered").length;
    const open = orders.length - delivered;
    const head = `${orders.length} on the register` +
      (orders.length > 1 || open > 0
        ? ` (${open} not yet delivered, ${delivered} delivered)`
        : "");
    if (orders.length <= 3) {
      // Few orders: list them inline — cheap, and lets the bot greet naturally.
      summary = `${head} — ${orders.map(fmt).join("; ")}`;
    } else {
      // Many orders: a compact cloth tally + the two most recent, NOT the whole
      // list. Detail comes from get_my_orders (the authoritative source the bot is
      // told to use), so re-sending all of them here every turn is dead weight —
      // and having two order sources is what caused miscounts. `orders` is
      // placed_at desc, so [0..1] are the latest.
      const byCloth: Record<string, number> = {};
      for (const o of orders) {
        const c = o.variant ?? "—";
        byCloth[c] = (byCloth[c] ?? 0) + 1;
      }
      const tally = Object.entries(byCloth)
        .map(([c, n]) => `${n} ${EMAIL_VARIANT[c] ?? c}`).join(", ");
      summary = `${head} — by variant: ${tally}. Most recent: ${orders.slice(0, 2).map(fmt).join("; ")}. ` +
        `(Do NOT enumerate or count their orders from this summary — call get_my_orders for the full, current list.)`;
    }
    const active = orders.filter((o) => o.status !== "cancelled" && o.status !== "returned").length;
    const tier = active >= 5
      ? "Patron"
      : active >= 3
      ? "Friend of the House"
      : active === 2
      ? "Returning Guest"
      : "Newcomer";
    standing = ` STANDING: ${tier} (${active} on the register).`;
  }
  const archive = struck > 0 ? ` ARCHIVE: ${struck} struck (cancelled) — mention only if asked.` : "";
  // Typed client book — grouped so the concierge USES each kind well: what it did
  // for them (events), what it knows (facts), and private reminders on how to
  // serve them better (reflections — act on these, never quote them).
  let book = "";
  const summaryRow = clientSummary && clientSummary[0];
  if (summaryRow) {
    // Consolidated path: the digest IS the memory, plus only the raw notes added
    // SINCE it was written (so nothing recent is lost before the next roll-up).
    const since = (notes || []).filter((n) =>
      n.kind !== "directive" && n.kind !== "summary" &&
      String(n.created_at) > String(summaryRow.created_at)).slice(0, 3);
    book = " CLIENT BOOK (consolidated digest — act on it; weave in, never recite; " +
      "call recall_context for older detail): " + summaryRow.note;
    if (since.length) book += "  ·  SINCE THEN: " + since.map((n) => n.note).join(" | ");
  } else if (notes && notes.length > 0) {
    const d = (n: { created_at: string; note: string }) => `${String(n.created_at).slice(0, 10)}: ${n.note}`;
    const events = notes.filter((n) => n.kind === "event").slice(0, 5);
    const reflections = notes.filter((n) => n.kind === "reflection").slice(0, 3);
    // Directives (and any summary) are surfaced on their own — never mixed into facts.
    const facts = notes.filter((n) =>
      n.kind !== "event" && n.kind !== "reflection" && n.kind !== "directive" && n.kind !== "summary").slice(0, 6);
    const parts: string[] = [];
    if (events.length) parts.push(`WHAT YOU'VE DONE FOR THEM (reference naturally if relevant): ${events.map(d).join(" | ")}`);
    if (facts.length) parts.push(`WHAT YOU KNOW ABOUT THEM (weave in, never recite): ${facts.map(d).join(" | ")}`);
    if (reflections.length) parts.push(`TO SERVE THEM BETTER (private coaching for YOU — silently change how you speak and serve; never quote or mention these): ${reflections.map((n) => n.note).join(" | ")}`);
    if (parts.length) book = " CLIENT BOOK — " + parts.join("  ·  ");
  }
  // The invisibility contract rides WITH the book, on every beat — the section
  // that also states it (Recognition) is toggleable, and a live line once cited
  // the book to the patron's face ("The client book notes you prefer…").
  if (book) {
    book += "  ·  BOOK DISCIPLINE: this book is invisible. Never name it, never cite notes or " +
      "records as your source, and never describe the patron's own habits, preferences, or " +
      "communication style back to them — a style note changes HOW you speak, it is never " +
      "something you SAY. Memory shows up only as better service.";
  }

  // First name (from their most recent order) — for warm, natural address.
  let firstName = "";
  if (orders && orders.length > 0) {
    const named = orders.find((o) => typeof o.name === "string" && o.name.trim());
    if (named?.name) firstName = named.name.trim().split(/\s+/)[0];
  }
  const nameLine = firstName
    ? `NAME: ${firstName} (use their first name naturally when it fits — never in every line).`
    : "";

  // Recency — how the register should read the passage of time since they bought.
  let recency = "";
  const dated = (orders ?? []).filter((o) => o.placed_at).map((o) => o.placed_at as string).sort();
  if (dated.length > 0) {
    const last = new Date(dated[dated.length - 1]).getTime();
    const days = Math.floor((Date.now() - last) / 86400000);
    recency = ` LAST PURCHASE: ${
      days <= 0 ? "today (this visit or earlier today)" : days === 1 ? "yesterday" : `${days} days ago`
    }.`;
  }

  // Re-engagement recency — how long since the last conversation was wrapped. ONLY on the
  // opening beat: mid-conversation this would reprint every turn (the live conversation is
  // never `lastConvo`) and make the model greet "welcome back / what brings you back" on
  // every reply.
  let reengage = "";
  if (opening && lastConvo && lastConvo.length > 0 && lastConvo[0].ended_at) {
    const mins = Math.floor((Date.now() - new Date(lastConvo[0].ended_at).getTime()) / 60000);
    const when = mins < 1 ? "moments ago"
      : mins < 60 ? `${mins} min ago`
      : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
      : `${Math.floor(mins / 1440)} days ago`;
    const how = lastConvo[0].status === "snoozed"
      ? "they asked for room (quiet mode)" : "the chat was wrapped up";
    reengage = ` RE-ENGAGEMENT: this is a new visit — you last spoke ${when} and ${how}. ` +
      `Greet like someone returning, not a stranger; pick up naturally, don't restart from scratch.`;
  }

  // House directives — the team's standing instructions for THIS patron. Placed
  // first and framed as non-optional; each carries its id so a one-time directive
  // can be checked off with resolve_admin_note once carried out.
  let directiveLine = "";
  if (directives && directives.length > 0) {
    const list = directives.map((n) => `(#${n.id}) ${n.note}`).join("  ·  ");
    const many = directives.length > 1;
    // On the opening beat, a proper directive leads the visit ("on your very first
    // line"). Mid-conversation that framing would make the model re-open every turn —
    // so soften it to "at the first natural moment" and drop the "first line" push.
    const when = opening
      ? `honour ${many ? "each proper one" : "a proper one"} BEFORE anything else, PROACTIVELY and on your very ` +
        `first line of the visit; do NOT wait to be asked`
      : `honour ${many ? "each proper one" : "a proper one"} at the first natural moment in the conversation — ` +
        `weave it in yourself, don't wait to be asked, but don't re-greet or restart to do it`;
    directiveLine = ` HOUSE INSTRUCTIONS FOR THIS PATRON (left by the team — ${when}). ${HOUSE_NOTE_GUARD} The ` +
      `instruction's EXACT WORDING below is the sole source of the errand: carry out what IT says, never a similar ` +
      `errand you remember. If the CLIENT BOOK or a past visit mentions something that resembles it (an earlier ` +
      `forgotten item, an earlier apology), that one is HISTORY — already done — and its details must not bleed into ` +
      `this one. ACTING on a ` +
      `proper instruction is ALWAYS just words woven into good service and NEVER needs a tool — so you can always do it, ` +
      `even on a greeting or a nudge where no tools are available; never withhold it for lack of a tool. A STANDING ` +
      `preference you follow every visit and leave open. A ONE-TIME task you carry out at the first natural moment. ` +
      `CHECKING a completed one-time task off is a SEPARATE, silent, later step: WHEN you have tools this turn, call ` +
      `resolve_admin_note with its (#id)${many ? " for each one you carried out" : ""}; if this turn has no tools, ` +
      `just honour it in words — the house reconciles the check-off for you afterward, so a completed task never ` +
      `lingers. ${many ? `There are ${directives.length} open — honour ALL of them, not just the first. ` : ""}` +
      `Instructions: ${list}.`;
  }

  return `CUSTOMER: ${customer.email ?? customer.id} (signed in, email verified). ${nameLine}${directiveLine} ORDERS: ${summary}.${standing}${recency}${reengage}${archive}${book}`;
}

// ── Register tools — definitions + execution (signed-in only) ────────────────

const MUTABLE_STATUSES = ["placed", "weaving", "finishing"];

// deno-lint-ignore no-explicit-any
const REGISTER_TOOLS: any[] = [
  {
    name: "get_my_orders",
    description:
      "Read the orders on the register for the signed-in owner: serial number, " +
      "status, tracking (when shipped), variant, shipping address, and the date placed. " +
      "Returns an authoritative { count, variant, orders } — ALWAYS call this before " +
      "answering ANY question about the owner's orders, including every count and every " +
      "'how many' — use its count and rows verbatim; never count or filter from memory. " +
      "When the owner is narrowing to one variant (e.g. 'show my As listed', or after they " +
      "tap a variant pill), pass 'variant' so the register returns exactly that variant's " +
      "orders and you don't have to filter in your head. " +
      "Struck (cancelled) entries are omitted unless include_cancelled is true — " +
      "pass it only when the owner asks about cancelled or past entries.",
    input_schema: {
      type: "object",
      properties: {
        include_cancelled: {
          type: "boolean",
          description: "Also return struck (cancelled) entries. Default false.",
        },
        variant: {
          type: "string", enum: ["as-listed", "unused-2", "unused-3"],
          description: "Return only orders in this variant. Pass it whenever the owner is " +
            "looking at or picking among a single variant.",
        },
      },
      required: [],
    },
  },
  {
    name: "recall_context",
    description:
      "Pull the signed-in patron's prior context on demand: their full client-book notes and the " +
      "tail of their most recent EARLIER conversation(s). The CUSTOMER block already summarizes " +
      "their orders, standing, recency, and the latest notes — call this only when you need more: " +
      "older notes, or what was actually said last time, to re-engage a returning patron faithfully. " +
      "Read-only.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  // NOTE: address changes are intentionally NOT a free-text model tool. A model
  // composing five address fields can (and did) mis-map them — e.g. a city into
  // the street field. Address edits go through the {{form:address-change:serial}}
  // form instead, so a human types each labeled field. The form's submit path
  // (handleFormPost → runRegisterTool → update_shipping_address) still validates
  // and writes; only the free-typed model tool is removed.
  {
    name: "remember_customer",
    description:
      "Write one short, durable line of RELATIONSHIP & SELLING memory to this patron's client " +
      "book — a room they mentioned, who they buy for, a favored variant, a gift occasion, a " +
      "hesitation, a preference, a thread to pick up later. " +
      "NEVER record order bookkeeping — order counts, serial numbers (Nº …), order STATUS, what " +
      "they bought, or shipping/billing addresses. That data lives in the register (the orders " +
      "database) and you read it LIVE with get_my_orders; a note freezes a snapshot that goes " +
      "stale and is redundant. Reference an order only as context for a durable relationship fact " +
      "(e.g. 'buying one for the east-facing office' — not '5 active orders 14,214–14,218'). " +
      "Only what a good clerk would note; never health, beliefs, finances, or anything sensitive. " +
      "The book is shown to the patron's own conversations and to the admin. Do NOT record " +
      "something the CLIENT BOOK above already holds — one line per durable fact; if it is already " +
      "noted, say nothing rather than repeating it.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One factual line, at most 240 characters." },
      },
      required: ["note"],
    },
  },
  {
    name: "resolve_admin_note",
    description:
      "Mark ONE house instruction (an admin directive shown in the CUSTOMER block, each printed with a (#id)) " +
      "as done. Use this ONLY after you have actually carried out a one-time instruction — delivered a promised " +
      "apology, applied a courtesy, confirmed a detail the note asked you to confirm. Never resolve a STANDING " +
      "preference (leave those open so they keep applying), and never resolve a note you have not yet acted on. " +
      "This is SILENT internal bookkeeping between you and the desk — calling it changes nothing the patron sees. " +
      "NEVER tell the patron you marked, checked off, resolved, or completed anything, never say a note or " +
      "instruction is 'done', and never reference the note at all: to them it is simply good service, not a task list.",
    input_schema: {
      type: "object",
      properties: {
        note_id: { type: "integer", description: "The directive's id — the number shown as (#id) in HOUSE INSTRUCTIONS." },
      },
      required: ["note_id"],
    },
  },
  {
    name: "update_variant",
    description:
      "Change the cloth (variant) on one of the owner's orders. Allowed only while the " +
      "order is still 'placed' — once weaving begins the cloth is on the loom. " +
      "Confirm the exact change with the owner before calling.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        variant: {
          type: "string", enum: ["as-listed", "unused-2", "unused-3"],
          description: "The new cloth.",
        },
      },
      required: ["serial", "variant"],
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel one of the owner's orders. Allowed only while the order is still 'placed' " +
      "(weaving has not begun). Ask the owner to explicitly confirm before calling. " +
      "The number returns to the year's edition and cannot be held again.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
      },
      required: ["serial"],
    },
  },
  {
    name: "join_waitlist",
    description:
      "Add this patron to the waitlist for a future batch. Use when the current batch is sold out, " +
      "when they ask to be told about the next batch, or when a variant they want isn't available. " +
      "Use their signed-in email; you may also record a preferred variant and a short note. " +
      "Confirm warmly once done.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The patron's email (use the signed-in one)." },
        "variant": { type: "string", description: "Optional preferred variant: as-listed, unused-2, or unused-3." },
        note: { type: "string", description: "Optional short note about what they're after." },
      },
      required: ["email"],
    },
  },
  {
    name: "submit_inquiry",
    description:
      "Capture a shopper's inquiry and notify the house — the inquiry-mode lead primitive. " +
      "Use it the moment a shopper makes a serious OFFER, asks to VIEW the piece in person, " +
      "raises a QUESTION only the owner can answer, or asks for a CALLBACK. Works for anyone, " +
      "signed in or not — no account is needed. Take their name and at least one way to reach " +
      "them (an email OR a phone number), the offer figure if they named one, and a short line " +
      "of context. Prefer handing them the make-an-offer / book-a-viewing form when one is " +
      "available; call this directly only when you're taking the details in chat. Never use it " +
      "to negotiate the price — you are opening a conversation with the owner, who follows up.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string", enum: ["offer", "viewing", "question", "callback"],
          description: "What the shopper is handing you: an offer, a viewing request, a question, or a callback request.",
        },
        name: { type: "string", description: "The shopper's name." },
        email: { type: "string", description: "The shopper's email (email or phone is required)." },
        phone: { type: "string", description: "The shopper's phone (email or phone is required)." },
        amount: { type: "number", description: "The offer figure, when they named one (offers only)." },
        message: { type: "string", description: "A short line of context in the shopper's words." },
      },
      required: ["kind", "name"],
    },
  },
  {
    name: "resend_confirmation",
    description:
      "Re-send a transactional email the owner already should have — the order " +
      "confirmation, the shipping note, or the cancellation note — to their email on " +
      "file. Use when a patron says they didn't receive it or want another copy. " +
      "Pick 'kind' from what the order actually is: 'confirmation' for a placed order, " +
      "'shipping' only once it has shipped, 'cancellation' only if it was cancelled. " +
      "Nothing is charged; this only re-sends an existing note.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        kind: {
          type: "string", enum: ["confirmation", "shipping", "cancellation"],
          description: "Which note to re-send.",
        },
      },
      required: ["serial", "kind"],
    },
  },
  {
    name: "track_shipment",
    description:
      "Look up where one of the owner's orders stands: its status and, once it has " +
      "shipped, the tracking number. Read-only. Call this before answering 'where is my " +
      "car' rather than guessing — it reads the live register.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
      },
      required: ["serial"],
    },
  },
  {
    name: "get_care_guide",
    description:
      "Give the owner the care instructions for their car. " +
      "Read-only — use it when they ask how to clean, store, or look after " +
      "the piece. If they have no order, you may still explain general care from the KB.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
      },
      required: ["serial"],
    },
  },
  {
    name: "update_gift_details",
    description:
      "Change the gift recipient's name on one of the owner's gift orders — the name that " +
      "goes on the enclosed card. Allowed only before the order ships, and only on orders " +
      "marked as a gift. Confirm the exact spelling with the owner before calling. This does " +
      "NOT change the shipping address (that goes through the address-change form).",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        recipient_name: {
          type: "string",
          description: "The gift recipient's name for the card (1–80 characters).",
        },
      },
      required: ["serial", "recipient_name"],
    },
  },
  {
    name: "request_mending",
    description:
      "Log a mending / repair request for one of the owner's cars — anything " +
      "the workshop should look at. Records the request and the " +
      "owner's description so the workshop can follow up; confirm warmly that it's noted. " +
      "This opens a request only — it does not schedule or promise a specific repair.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        note: {
          type: "string",
          description: "The owner's description of what needs mending (a sentence or two).",
        },
      },
      required: ["serial", "note"],
    },
  },
];

// Core tools the concierge leans on for basic competence. They can still be
// disabled from the admin, but the manifest flags them so the UI can warn.
const CORE_TOOLS = new Set(["get_my_orders", "recall_context"]);

/** The tools array sent to the model, with admin overrides applied:
 *  disabled tools are dropped; a non-empty description override replaces the
 *  built-in copy. An empty/absent registry leaves every tool at its default. */
// deno-lint-ignore no-explicit-any
function buildToolsForModel(data: ConciergeData): any[] {
  const reg = new Map((data.tools ?? []).map((t) => [t.name, t]));
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const tool of REGISTER_TOOLS) {
    const o = reg.get(tool.name);
    if (o && o.enabled === false) continue;
    if (o && typeof o.description === "string" && o.description.trim().length > 0) {
      out.push({ ...tool, description: o.description });
    } else {
      out.push(tool);
    }
  }
  return out;
}

/** The admin-facing tools manifest: every built-in tool, its current enabled
 *  state, the effective (possibly overridden) description, and whether the
 *  description is a custom override or the code default. */
function toolsManifest(data: ConciergeData): Array<{
  name: string; enabled: boolean; core: boolean;
  description: string; default_description: string; overridden: boolean;
}> {
  const reg = new Map((data.tools ?? []).map((t) => [t.name, t]));
  return REGISTER_TOOLS.map((tool) => {
    const o = reg.get(tool.name);
    const overridden = !!(o && typeof o.description === "string" && o.description.trim().length > 0);
    return {
      name: tool.name,
      enabled: !(o && o.enabled === false),
      core: CORE_TOOLS.has(tool.name),
      description: overridden ? (o!.description as string) : tool.description,
      default_description: tool.description,
      overridden,
    };
  });
}

// ── Client book: deterministic EVENT notes ───────────────────────────────────
// A good support agent writes down what they DID for you, not just what they
// learned. These compose a one-line client-book note for each MUTATING action, so
// an action can never be missing from the book (the summarizer is model-judged;
// this is guaranteed). Read-only lookups (get_my_orders, track_shipment, …) are
// intentionally absent — they aren't "things done." Toggle with the config key
// `clientbook_log_actions` (default on).
const fmtNo = (s: number | null) =>
  s != null ? `Nº ${Number(s).toLocaleString("en-US")}` : "an order";
const BOOK_EVENTS: Record<string, (serial: number | null, result: string, payload: unknown) => string> = {
  cancel_order: (s) => `Cancelled ${fmtNo(s)} at the patron's request — the number returned to the edition.`,
  update_shipping_address: (s) => `Updated the shipping address on ${fmtNo(s)}.`,
  update_variant: (s, _r, p) => {
    const cw = p && typeof (p as Record<string, unknown>).variant === "string"
      ? (EMAIL_VARIANT[(p as Record<string, string>).variant] || (p as Record<string, string>).variant) : "";
    return `Changed the cloth on ${fmtNo(s)}${cw ? " to " + cw : ""}.`;
  },
  update_gift_details: (s) => `Updated the gift-card name on ${fmtNo(s)}.`,
  request_mending: (s) => `Logged a mending request for ${fmtNo(s)}.`,
  resend_confirmation: (s, r) => `Re-sent an order email for ${fmtNo(s)}${r ? " (" + r + ")" : ""}.`,
  join_waitlist: () => `Added to the waitlist for the next batch.`,
  // Deliberately content-free: echoing the errand's text into the book is how a
  // PAST instruction ("cell phone left at the shop") bled into a NEW one
  // ("keys") — the model reused the remembered wording. The id keeps it
  // auditable; the errand's content stays only on the note itself.
  resolve_admin_note: (_s, _r, p) => {
    const id = p && typeof (p as Record<string, unknown>).note_id === "number"
      ? (p as Record<string, unknown>).note_id : null;
    return `Carried out a one-time house instruction${id != null ? ` (#${id})` : ""} — done and checked off. ` +
      `(A past errand: never repeat or reference its contents.)`;
  },
};
async function bookEvent(
  customer: Customer, action: string, serial: number | null, result: string, payload: unknown,
): Promise<void> {
  const composer = BOOK_EVENTS[action];
  if (!composer) return;
  try {
    const data = await loadConciergeData();
    if (data.config?.clientbook_log_actions === false) return; // admin opt-out
    await pgInsert("customer_notes", {
      user_id: customer.id, email: customer.email, kind: "event",
      note: composer(serial, result, payload).slice(0, 220),
    });
  } catch { /* best-effort — never breaks the chat */ }
}

/** Writes one row to the concierge_actions audit log, and — for mutating actions —
 * a guaranteed 'event' line to the client book. Never throws. */
async function logAction(
  cid: string | null, customer: Customer, action: string,
  serial: number | null, payload: unknown, result: string,
): Promise<void> {
  try {
    await pgInsert("concierge_actions", {
      conversation_id: cid, user_id: customer.id, email: customer.email,
      action, serial, payload: payload ?? null, result: result.slice(0, 500),
    });
  } catch { /* audit failures never break the chat */ }
  await bookEvent(customer, action, serial, result, payload);
}

/** Executes one register tool; returns the tool_result content string. */
async function runRegisterTool(
  name: string, input: Record<string, unknown>,
  customer: Customer, cid: string | null,
): Promise<string> {
  if (name === "get_my_orders") {
    const cw = typeof input.variant === "string" ? input.variant.toLowerCase() : undefined;
    const orders = await myOrders(customer, input.include_cancelled === true, cw);
    if (orders === null) return "ERROR: the register is unreachable right now.";
    const cwLabel = cw && ["as-listed", "unused-2", "unused-3"].includes(cw) ? cw : "all";
    await logAction(cid, customer, "get_my_orders", null, cw ? { variant: cw } : null,
      `${orders.length} orders read${cw ? ` (${cwLabel})` : ""}`);
    // Return an authoritative shape so the model reports the count and rows
    // verbatim instead of tallying a long list by hand (which it does badly).
    return JSON.stringify({
      count: orders.length,
      variant: cwLabel,
      orders: orders.map((o) => ({ ...o, serial: o.serial ?? o.cancelled_serial })),
    });
  }

  if (name === "recall_context") {
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const notes = await pgSelect<{ note: string; created_at: string; kind: string | null }>(
      `customer_notes?select=note,created_at,kind&${nf}&order=created_at.desc&limit=20`,
    );
    const cf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},user_email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const convos = await pgSelect<{ id: string; created_at: string; ended_at: string | null }>(
      `concierge_conversations?select=id,created_at,ended_at&${cf}${
        cid ? `&id=neq.${cid}` : ""}&order=created_at.desc&limit=2`,
    );
    const prior: Array<{ when: string; turns: string[] }> = [];
    if (convos) {
      for (const c of convos) {
        const msgs = await pgSelect<{ role: string; content: string }>(
          `concierge_messages?select=role,content,created_at&conversation_id=eq.${c.id}` +
            `&order=created_at.desc&limit=8`,
        );
        if (msgs && msgs.length > 0) {
          prior.push({
            when: String(c.created_at).slice(0, 10),
            turns: msgs.reverse().map((m) => `${m.role === "user" ? "Patron" : "You"}: ${m.content}`),
          });
        }
      }
    }
    await logAction(cid, customer, "recall_context", null, null,
      `${notes?.length ?? 0} notes, ${prior.length} prior conversations`);
    const tagged = (k: string) => (notes ?? []).filter((n) => (n.kind || "fact") === k)
      .map((n) => `${String(n.created_at).slice(0, 10)}: ${n.note}`);
    return JSON.stringify({
      client_book: {
        did_for_them: tagged("event"),
        know_about_them: tagged("fact"),
        serve_better_next_time: tagged("reflection"), // private — act on, don't quote
      },
      prior_conversations: prior,
    });
  }

  if (name === "join_waitlist") {
    const email = (typeof input.email === "string" ? input.email.trim().toLowerCase() : "") ||
      (customer.email ?? "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return "ERROR: a valid email is needed for the waitlist — ask them for one first.";
    }
    const cw = typeof input.variant === "string" ? input.variant.trim().toLowerCase() : "";
    const row = await pgInsert("waitlist", {
      email,
      variant: ["as-listed", "unused-2", "unused-3"].includes(cw) ? cw : null,
      note: typeof input.note === "string" ? input.note.trim().slice(0, 400) || null : null,
      source: "concierge",
      user_id: customer.id ?? null,
    });
    if (!row) return "ERROR: the waitlist is unreachable right now.";
    await logAction(cid, customer, "join_waitlist", null, { email }, "added to waitlist");
    return `Done — ${email} is on the waitlist for the next batch; I'll see they're told when it opens.`;
  }

  if (name === "submit_inquiry") {
    // Inquiry-mode lead capture — anonymous-capable, no order serial. Stores the
    // shopper's offer / viewing request / question / callback and notifies the house.
    const KINDS = ["offer", "viewing", "question", "callback"];
    const kind = typeof input.kind === "string" ? input.kind.trim().toLowerCase() : "";
    if (!KINDS.includes(kind)) {
      return "ERROR: kind must be one of offer, viewing, question, or callback.";
    }
    const who = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
    if (who.length < 1) return "ERROR: a name is needed to take the inquiry.";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase().slice(0, 200) : "";
    const phone = typeof input.phone === "string" ? input.phone.trim().slice(0, 40) : "";
    const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (!emailOk && !phone) {
      return "ERROR: an email or a phone number is needed so the house can follow up — ask for one first.";
    }
    // Accept the amount as a number or a typed string ("$450", "450 cash").
    let amount: number | null = null;
    if (typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount > 0) {
      amount = input.amount;
    } else if (typeof input.amount === "string" && input.amount.trim()) {
      const n = Number(input.amount.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n > 0) amount = n;
    }
    const message = typeof input.message === "string" ? input.message.trim().slice(0, 2000) : "";
    const sessionKey = typeof input.session_key === "string" ? input.session_key.trim().slice(0, 64) : "";
    const pageUrl = typeof input.page_url === "string" ? input.page_url.trim().slice(0, 400) : "";

    // Attribution — an inquiry is the inquiry-mode CONVERSION EVENT (the analog of
    // the commission-button click), so we capture the session context the same way
    // the commission flow does. It is ALWAYS concierge-attributed by construction:
    // an inquiry is only ever submitted THROUGH the concierge, whether the model
    // called this tool in chat ('tool') or an anonymous inquiry form did ('form').
    // chat_meta mirrors the commission click's {section, turns} plus how it arrived
    // and when — but this stays a lead, never a sale: nothing here carries a value.
    const section = typeof input.section === "string" ? input.section.trim().slice(0, 80) : "";
    const turnsRaw = typeof input.turns === "number"
      ? input.turns
      : (typeof input.turns === "string" ? Number(input.turns) : NaN);
    const turns = Number.isFinite(turnsRaw) && turnsRaw > 0 ? Math.min(Math.floor(turnsRaw), 9999) : null;
    const origin = input.origin === "form" ? "form" : "tool";
    const chatMeta: Record<string, unknown> = {
      section: section || null,
      turns,
      origin,
      captured_at: new Date().toISOString(),
    };

    // Rate limit: at most 5 inquiries per session in a rolling hour. Count the
    // session's recent rows; over the cap we already have their details — don't
    // write another row and don't notify the house again.
    if (sessionKey) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = await pgSelect<{ id: string }>(
        `concierge_inquiries?select=id&session_key=eq.${encodeURIComponent(sessionKey)}` +
          `&created_at=gte.${encodeURIComponent(since)}`,
      );
      if (recent && recent.length >= 5) {
        return "We already have your details — the house has your note and will be in touch. " +
          "No need to send another.";
      }
    }

    const row = await pgInsert<{ id: string }>("concierge_inquiries", {
      kind,
      name: who,
      email: emailOk ? email : null,
      phone: phone || null,
      amount,
      message: message || null,
      session_key: sessionKey || null,
      page_url: pageUrl || null,
      // The inquiry-mode conversion stamp — concierge by construction. Kept in
      // its OWN column, never folded into orders/revenue. See ATTRIBUTION.md.
      chat_via: "concierge",
      chat_meta: chatMeta,
      meta: customer && customer.id
        ? { user_id: customer.id, user_email: customer.email ?? null }
        : {},
    });
    if (!row) return "ERROR: the desk is unreachable right now — try again in a moment.";

    // Notify the house — FAIL-SOFT. The row is already saved; a Resend error must
    // never fail the tool. Destination is the config key inquiry_notify_email,
    // falling back to the EMAIL_FROM address when it is unset.
    try {
      const data = await loadConciergeData();
      const cfgTo = typeof data.config?.inquiry_notify_email === "string"
        ? (data.config.inquiry_notify_email as string).trim() : "";
      const to = cfgTo || (EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? EMAIL_FROM);
      const LABELS: Record<string, string> = {
        offer: "offer", viewing: "viewing request", question: "question", callback: "callback request",
      };
      const label = LABELS[kind];
      const contact = [emailOk ? email : "", phone].filter(Boolean).join(" · ");
      bg(sendEmail(
        to,
        `New ${label} — ${who}`,
        emailShell(`A new ${label}`, [
          `Kind: <strong>${label}</strong>`,
          `From: <strong>${who}</strong>`,
          contact ? `Contact: ${contact}` : "",
          amount != null ? `Amount named: <strong>${amount.toLocaleString("en-US")}</strong>` : "",
          message ? `Message: ${message}` : "",
          pageUrl ? `Page: ${pageUrl}` : "",
          "Reply to the shopper directly to follow up.",
        ]),
        { kind: "inquiry", serial: null },
      ));
    } catch { /* email is best-effort; the inquiry is already recorded */ }

    const nice = { offer: "offer", viewing: "viewing request", question: "question", callback: "callback request" }[kind];
    const via = emailOk ? " by email" : phone ? " by phone" : "";
    return `Thank you — your ${nice} is with the house, and the owner will follow up${via} shortly.`;
  }

  if (name === "remember_customer") {
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 240) : "";
    if (note.length < 3) return "ERROR: a note needs a few words.";
    // Don't let the book fill with repeats — if this line substantially
    // duplicates one already on file, accept the intent without a second row.
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const prior = await pgSelect<{ note: string }>(
      `customer_notes?select=note&${nf}&order=created_at.desc&limit=12`,
    );
    if (isRedundantNote(note, prior ?? [])) {
      return "Already in the client book — nothing new to add.";
    }
    const row = await pgInsert("customer_notes", {
      user_id: customer.id, email: customer.email, note, kind: "fact",
    });
    if (!row) return "ERROR: the client book is unreachable right now.";
    // remember_customer writes its own note; don't let logAction double-book it.
    await pgInsert("concierge_actions", {
      conversation_id: cid, user_id: customer.id, email: customer.email,
      action: "remember_customer", serial: null, payload: { note }, result: "noted",
    });
    return "Noted in the client book.";
  }

  if (name === "resolve_admin_note") {
    const noteId = typeof input.note_id === "number" ? Math.floor(input.note_id) : NaN;
    if (!Number.isFinite(noteId)) {
      return "ERROR: note_id must be the number shown as (#id) in HOUSE INSTRUCTIONS.";
    }
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    // Ownership-scoped: only THIS patron's own OPEN directive can be checked off.
    const found = await pgSelect<{ id: number; note: string }>(
      `customer_notes?select=id,note&id=eq.${noteId}&kind=eq.directive&resolved=eq.false&${nf}&limit=1`,
    );
    if (found === null) return "ERROR: the client book is unreachable right now.";
    if (found.length === 0) {
      return `ERROR: no open house instruction #${noteId} for this patron (already resolved, or not theirs).`;
    }
    const updated = await pgPatch(
      `customer_notes?id=eq.${noteId}&kind=eq.directive&${nf}`,
      { resolved: true, resolved_at: new Date().toISOString() },
    );
    if (!updated || updated.length === 0) return "ERROR: could not check off the instruction — nothing changed.";
    await logAction(cid, customer, "resolve_admin_note", null, { note_id: noteId }, found[0].note.slice(0, 180));
    // Silent bookkeeping: this result is for you, never the patron. Do NOT mention it,
    // do not say anything is "done" or "checked off" — simply continue serving.
    return `(internal: house note #${noteId} reconciled with the desk — say nothing about this to the patron)`;
  }

  const serial = typeof input.serial === "number" ? Math.floor(input.serial) : NaN;
  if (!Number.isFinite(serial)) return "ERROR: serial must be a number.";

  // Ownership check first: the order must exist AND belong to this owner.
  const rows = await pgSelect<OrderRow>(
    `orders?select=serial,status,tracking,variant,address,address2,city,state,zip,placed_at,recipient_name,is_gift` +
      `&serial=eq.${serial}&${ownershipFilter(customer)}&limit=1`,
  );
  if (rows === null) return "ERROR: the register is unreachable right now.";
  if (rows.length === 0) return `ERROR: no order Nº ${serial} on this owner's register.`;
  const order = rows[0];

  if (name === "update_shipping_address") {
    if (!MUTABLE_STATUSES.includes(order.status ?? "")) {
      return `ERROR: Nº ${serial} is '${order.status}' — the register is closed on it. ` +
        "Address changes are possible only before shipment.";
    }
    const address = String(input.address ?? "").trim();
    const address2 = String(input.address2 ?? "").trim();
    const city = String(input.city ?? "").trim();
    const state = String(input.state ?? "").trim().toUpperCase();
    const zip = String(input.zip ?? "").trim();
    if (address.length < 4 || address.length > 120) return "ERROR: street address must be 4-120 characters.";
    if (address2.length > 120) return "ERROR: address line 2 is too long.";
    if (city.length < 1 || city.length > 80) return "ERROR: city must be 1-80 characters.";
    if (!/^[A-Z]{2}$/.test(state)) return "ERROR: state must be a two-letter US code.";
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return "ERROR: zip must be 12345 or 12345-6789.";
    const patch = { address, address2: address2 || null, city, state, zip };
    const updated = await pgPatch<OrderRow>(
      `orders?serial=eq.${serial}&${ownershipFilter(customer)}`, patch,
    );
    if (!updated || updated.length === 0) return "ERROR: the register did not accept the change.";
    await logAction(cid, customer, "update_shipping_address", serial, patch, "address updated");
    const u = updated[0];
    return `Recorded. Nº ${serial} now ships to: ${u.address}` +
      `${u.address2 ? ", " + u.address2 : ""}, ${u.city}, ${u.state} ${u.zip}.`;
  }

  if (name === "update_variant") {
    if (order.status !== "placed") {
      return `ERROR: Nº ${serial} is '${order.status}' — the making has begun. ` +
        "Variant changes are possible only while an order is still 'placed'.";
    }
    const cw = String(input.variant ?? "").toLowerCase();
    if (!["as-listed", "unused-2", "unused-3"].includes(cw)) {
      return "ERROR: variant must be as-listed, unused-2, or unused-3.";
    }
    const updated = await pgPatch<OrderRow>(
      `orders?serial=eq.${serial}&status=eq.placed&${ownershipFilter(customer)}`,
      { variant: cw },
    );
    if (!updated || updated.length === 0) return "ERROR: the register did not accept the change.";
    await logAction(cid, customer, "update_variant", serial, { variant: cw }, "variant updated");
    const pretty = cw === "as-listed" ? "As listed" : cw === "unused-2" ? "(unused)" : "(unused)";
    return `Recorded. Nº ${serial} is now entered as ${pretty}.`;
  }

  if (name === "cancel_order") {
    if (order.status !== "placed") {
      return `ERROR: Nº ${serial} is '${order.status}' — only 'placed' orders can be cancelled. ` +
        "Once the making begins the piece carries the owner's number.";
    }
    // Atomic strike-and-release: the entry is struck, the number rejoins the
    // edition's pool and goes to the next visitor, lowest first.
    const result = await pgRpc<string>("cancel_order_return", {
      p_serial: serial,
      p_user_id: customer.id,
      p_email: customer.email,
    });
    if (result === "ok") {
      await logAction(cid, customer, "cancel_order", serial, null, "order cancelled; serial released");
      const mail = cancelEmail(serial, order.name, order.variant, order.placed_at);
      bg(sendEmail(customer.email ?? "", mail.subject, mail.html, { kind: "cancelled", serial }));
      return `Done. Nº ${serial} is struck from the register and the number returns to the year's edition.`;
    }
    if (result === null) {
      // Pre-migration register: fall back to the plain status change.
      const updated = await pgPatch<OrderRow>(
        `orders?serial=eq.${serial}&status=eq.placed&${ownershipFilter(customer)}`,
        { status: "cancelled", cancelled_at: new Date().toISOString() },
      );
      if (!updated || updated.length === 0) return "ERROR: the register did not accept the cancellation.";
      await logAction(cid, customer, "cancel_order", serial, null, "order cancelled");
      const mail = cancelEmail(serial, order.name, order.variant, order.placed_at);
      bg(sendEmail(customer.email ?? "", mail.subject, mail.html, { kind: "cancelled", serial }));
      return `Done. Nº ${serial} is cancelled.`;
    }
    return `ERROR: the register declined — ${result}.`;
  }

  if (name === "track_shipment") {
    await logAction(cid, customer, "track_shipment", serial, null, `status ${order.status}`);
    const status = order.status ?? "unknown";
    if (["shipped", "delivered"].includes(status)) {
      return JSON.stringify({
        serial, status,
        tracking: order.tracking ?? null,
        note: order.tracking
          ? `Nº ${serial} is ${status}. Tracking: ${order.tracking}.`
          : `Nº ${serial} is ${status}, but no tracking number is on the register yet.`,
      });
    }
    const stage = status === "placed" ? "entered and queued"
      : status === "weaving" ? "in the making"
      : status === "finishing" ? "being finished"
      : status === "cancelled" ? "struck from the register (cancelled)"
      : status === "returned" ? "returned"
      : status;
    return JSON.stringify({
      serial, status, tracking: null,
      note: `Nº ${serial} has not shipped yet — it is ${stage}. Made to order. Tracking appears here the moment it leaves the workshop.`,
    });
  }

  if (name === "get_care_guide") {
    await logAction(cid, customer, "get_care_guide", serial, null, `variant ${order.variant}`);
    const cw = order.variant ?? "";
    const clothName = EMAIL_VARIANT[cw] ?? "your cloth";
    const clothNote = ""; // no per-variant care notes for this brand
    return JSON.stringify({
      serial, variant: clothName,
      care: [
        'Every visit to RAC Performance (RUF Auto Centre) in Carrollton, TX is backed by an itemized invoice with OEM Porsche part numbers.', 'This is not a car that was deferred — it was driven by someone who maintained it properly.', 'Every corner.', 'New B4 rear struts, front strut mounts, bearings, bellows, both trailing arms, both lower control arms — fresh four-wheel alignment.',
        clothNote,
      ].filter(Boolean),
    });
  }

  if (name === "update_gift_details") {
    if (!order.is_gift) {
      return `ERROR: Nº ${serial} isn't marked as a gift, so there's no recipient card to name. ` +
        "If it should be a gift, that's set when the order is placed.";
    }
    if (!MUTABLE_STATUSES.includes(order.status ?? "")) {
      return `ERROR: Nº ${serial} is '${order.status}' — the card is already enclosed. ` +
        "Gift-name changes are possible only before shipment.";
    }
    const rn = String(input.recipient_name ?? "").trim();
    if (rn.length < 1 || rn.length > 80) return "ERROR: the recipient's name must be 1–80 characters.";
    const updated = await pgPatch<OrderRow>(
      `orders?serial=eq.${serial}&${ownershipFilter(customer)}`,
      { recipient_name: rn },
    );
    if (!updated || updated.length === 0) return "ERROR: the register did not accept the change.";
    await logAction(cid, customer, "update_gift_details", serial, { recipient_name: rn }, "gift name updated");
    return `Recorded. The card on Nº ${serial} now reads for ${rn}.`;
  }

  if (name === "request_mending") {
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
    if (note.length < 4) return "ERROR: a mending request needs a short description of what's wrong.";
    const row = await pgInsert("concierge_actions", {
      conversation_id: cid, user_id: customer.id, email: customer.email,
      action: "request_mending", serial, payload: { note },
      result: "mending requested",
    });
    if (!row) return "ERROR: the workshop log is unreachable right now — ask them to try again shortly.";
    await bookEvent(customer, "request_mending", serial, "mending requested", { note });
    return `Noted — a mending request for Nº ${serial} is logged with the workshop: "${note}". ` +
      "Someone will follow up by email. A good piece is meant to be repaired, not discarded — this is exactly what the workshop is for.";
  }

  if (name === "resend_confirmation") {
    const KIND_MAP: Record<string, "placed" | "shipped" | "cancelled"> = {
      confirmation: "placed", shipping: "shipped", cancellation: "cancelled",
    };
    const rawKind = String(input.kind ?? "").toLowerCase();
    const mapped = KIND_MAP[rawKind];
    if (!mapped) return "ERROR: kind must be confirmation, shipping, or cancellation.";
    const st = order.status ?? "";
    if (mapped === "shipped" && !["shipped", "delivered"].includes(st)) {
      return `ERROR: Nº ${serial} hasn't shipped yet (it's '${st}'), so there's no shipping note to re-send. ` +
        "Offer the order confirmation instead, or track the shipment.";
    }
    if (mapped === "cancelled" && !["cancelled", "returned"].includes(st)) {
      return `ERROR: Nº ${serial} is '${st}', not cancelled — a cancellation note wouldn't apply.`;
    }
    if (!SUPABASE_URL || !SERVICE_KEY) return "ERROR: the mail service is unreachable right now.";
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/commission?custresend=1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({ serial, kind: mapped }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({} as Record<string, unknown>));
        const em = typeof (detail as { error?: unknown }).error === "string"
          ? (detail as { error: string }).error : "the mail service declined";
        return `ERROR: ${em}`;
      }
      const okBody = await res.json().catch(() => ({} as Record<string, unknown>));
      const to = typeof (okBody as { to?: unknown }).to === "string"
        ? (okBody as { to: string }).to : (customer.email ?? "your email on file");
      await logAction(cid, customer, "resend_confirmation", serial, { kind: rawKind }, `re-sent ${mapped}`);
      const label = mapped === "placed" ? "order confirmation"
        : mapped === "shipped" ? "shipping note" : "cancellation note";
      return `Done — the ${label} for Nº ${serial} is on its way to ${to} again. ` +
        "Give it a minute, and do check the spam folder if it's shy.";
    } catch {
      return "ERROR: the mail service didn't respond — ask them to try again in a moment.";
    }
  }

  return `ERROR: unknown tool '${name}'.`;
}

// ── Semantic cache — gte-small embeddings + match_cached_answer RPC ──────────

// Questions about live or personal state must never be answered from cache.
const CACHE_SKIP = /remain(s|ing)?|left|available|stock|hold|my (order|car|deliver|number)|status|track|sign in|signed in/i;

// deno-lint-ignore no-explicit-any
let embedSession: { run: (t: string, o: Record<string, unknown>) => Promise<any> } | null = null;
let embedFailureFiled = false;

/** Files one Studio-visible flag per isolate when embeddings are unavailable. */
async function fileEmbedFailure(detail: string): Promise<void> {
  if (embedFailureFiled) return;
  embedFailureFiled = true;
  try {
    await pgInsert("concierge_flags", {
      question: "(system) semantic cache self-check",
      answer: "Embedding runtime unavailable — cached answers cannot be written or matched. " + detail.slice(0, 300),
      reason: "cache_embed_unavailable",
    });
  } catch { /* the log line still exists */ }
  console.error("concierge cache: embedding unavailable:", detail);
}

async function embed(text: string): Promise<number[] | null> {
  try {
    if (!embedSession) embedSession = new Supabase.ai.Session("gte-small");
    const out = await embedSession!.run(text, { mean_pool: true, normalize: true });
    // gte-small may return number[] or a Float32Array-like — accept both.
    const arr: number[] | null = Array.isArray(out)
      ? out as number[]
      : (out && typeof out.length === "number" ? Array.from(out as ArrayLike<number>) : null);
    if (arr && arr.length === 384) return arr;
    await fileEmbedFailure(`unexpected output shape (length ${arr ? arr.length : "n/a"})`);
    return null;
  } catch (e) {
    await fileEmbedFailure(e instanceof Error ? e.message : String(e));
    return null;
  }
}

const vecLiteral = (e: number[]) => `[${e.join(",")}]`;

/** The one semantic axis cosine similarity is worst at: polarity. An embedding
 * puts "does it shed?" and "does it never shed?" nearly on top of each other,
 * so a cached answer can be served to a question that asks the OPPOSITE. If
 * the negation signature of the incoming question differs from the cached
 * question's, the hit is refused and the model answers live. */
function hasNegation(q: string): boolean {
  return /\b(not|no|never|none|neither|nor|isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t|didn'?t|won'?t|can'?t|cannot|couldn'?t|shouldn'?t|without|nicht|kein(?:e|en|em|er)?|niemals|ohne)\b/i
    .test(q);
}

interface CacheHit { id: string; question: string; answer_md: string; similarity: number }

async function cacheLookup(embedding: number[]): Promise<CacheHit | null> {
  const rows = await pgRpc<CacheHit[]>("match_cached_answer", {
    query_embedding: vecLiteral(embedding), match_threshold: 0.90,
  });
  return rows && rows.length > 0 ? rows[0] : null;
}

/** An answer is cacheable when it carries no live numbers or register state.
 *  the brand's one configured static figure (strings.staticFigure) stays
 *  cacheable; serial-style figures (Nº 14,215 / other comma-thousands) do not. */
function cacheableAnswer(text: string): boolean {
  if (/Nº\s*\d/.test(text)) return false; // a specific serial
  const liveFigure = /\b\d{1,2},\d{3}\b/g;
  let m: RegExpExecArray | null;
  while ((m = liveFigure.exec(text)) !== null) {
    if (m[0] !== "") return false; // any other thousands figure is live state
  }
  if (text.includes("{{action:signin}}")) return false;
  if (text.includes("{{action:snooze}}")) return false; // a wind-down is visit-specific
  // Visit-specific state that isn't a serial: hold countdowns (09:52),
  // loom clocks (5d 16h), or talk of "this visit" never crosses visitors.
  if (/\b\d{1,2}:\d{2}\b/.test(text)) return false;
  if (/\b\d+\s*d\s+\d+\s*h\b/i.test(text)) return false;
  if (/\b(this|your) visit\b/i.test(text)) return false;
  return text.length > 0 && text.length <= 4000;
}

// ── Knowledge gaps — flag "I don't know" answers for the admin ───────────────

const GAP_RE = new RegExp(
  [
    "don'?t have that",
    "do not have that",
    "isn'?t something i know",
    "not something i know",
    "i don'?t know",
    "i do not know",
    "don'?t have (a|the|that) (detail|figure|answer)",
    "beyond (my|the) (register|knowledge)",
    "cannot (say|tell you|answer)",
    "no figure for",
    "that'?s a question for hello@",
  ].join("|"),
  "i",
);

/** Files an unanswered question for the Studio's Knowledge tab. Never throws. */
async function maybeFlagGap(
  cid: string | null, question: string | undefined, answer: string,
): Promise<void> {
  try {
    if (!question || !answer || !GAP_RE.test(answer)) return;
    await pgInsert("concierge_flags", {
      conversation_id: cid,
      question: question.slice(0, 2000),
      answer: answer.slice(0, 4000),
      reason: "knowledge_gap",
    });
  } catch { /* flagging never breaks the chat */ }
}

// ── Goal evaluation — a light judge scores the conversation vs. the goals ────

// Supabase edge background-task hook; run the judge after the response closes.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

function scheduleGoalEval(
  cid: string | null, data: ConciergeData, transcript: ChatMessage[],
  apiKey: string, model: string,
): void {
  if (!cid || data.goals.length === 0) return;
  // Substance gate: nothing meaningful to grade on a one-message exchange.
  const userTurns = transcript.filter((m) => m.role === "user").length;
  if (userTurns < 2) return;
  // Sampling: goal scoring is pure analytics and fires every turn, so grade only
  // a fraction to bound background LLM cost. Admin-settable via the
  // goal_sample_rate config key (0–1); default 1 = grade every eligible turn.
  const rate = typeof data.config?.goal_sample_rate === "number"
    ? data.config.goal_sample_rate
    : 1;
  if (rate < 1 && Math.random() >= Math.max(0, rate)) return;
  // Grade with the admin's chosen grader model (falls back to the concierge model).
  // The `model` arg is kept for signature compatibility with the live path.
  void model;
  const p = evaluateGoals(cid, data, transcript, apiKey, graderModel(data));
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(p);
    } else {
      p.catch(() => {});
    }
  } catch { p.catch(() => {}); }
}

// ── House-directive reconciliation ────────────────────────────────────────────
// Acting on a one-time house instruction and remembering to check it off are two
// steps: the model reliably does the first and sometimes drops the second, which
// leaves a completed task open (it then wrongly repeats next visit) and tags no
// chat. After any signed-in turn where a one-time directive was open, this runs a
// small, tool-scoped pass that re-reads what was actually said and calls
// resolve_admin_note for any instruction now carried out. It runs in the
// background (no added latency), only ever RESOLVES (never speaks to the shopper),
// and catches directives acted on in a tool-less proactive beat too — so a missed
// self-resolve is corrected on the same or the very next turn. A false negative
// just leaves the note open for next time; it can never produce a wrong reply.
const RESOLVE_TOOL = REGISTER_TOOLS.find((t) => t.name === "resolve_admin_note");

async function reconcileDirectives(
  cid: string | null,
  customer: Customer,
  // deno-lint-ignore no-explicit-any
  convo: any[],
  finalText: string,
  apiKey: string,
  model: string,
): Promise<void> {
  try {
    if (!RESOLVE_TOOL) return;
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const open = await pgSelect<{ id: number; note: string }>(
      `customer_notes?select=id,note&${nf}&kind=eq.directive&resolved=eq.false&order=created_at.desc&limit=12`,
    );
    if (!open || open.length === 0) return;
    const list = open.map((n) => `(#${n.id}) ${n.note}`).join("\n");
    // Flatten the turns we have plus the reply just sent into a plain transcript.
    const transcript = [...convo, { role: "assistant", content: finalText }]
      .map((m) => {
        const who = m.role === "assistant" ? "CONCIERGE" : "SHOPPER";
        const body = typeof m.content === "string"
          ? m.content
          // deno-lint-ignore no-explicit-any
          : Array.isArray(m.content)
            // deno-lint-ignore no-explicit-any
            ? m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ")
            : "";
        return body.trim() ? `${who}: ${body.trim()}` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!transcript) return;
    const sys =
      "You reconcile the house's standing instructions after a concierge turn. Below are the " +
      "OPEN house instructions for this patron and the conversation so far. For EACH instruction " +
      "that has now CLEARLY been carried out in the conversation (the concierge actually said or " +
      "did the thing the note asked), call resolve_admin_note with its (#id). A STANDING preference " +
      "(\"always…\", \"every visit…\", an ongoing courtesy) is NOT a one-time task — leave those open. " +
      "If a one-time task has not yet been done, do nothing for it. Only resolve; never write a reply.\n\n" +
      "OPEN HOUSE INSTRUCTIONS:\n" + list;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system: sys,
        tools: [RESOLVE_TOOL],
        messages: [{ role: "user", content: `CONVERSATION:\n${transcript}` }],
      }),
    });
    if (!res.ok) return;
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const openIds = new Set(open.map((n) => n.id));
    for (const b of blocks) {
      if (b?.type === "tool_use" && b.name === "resolve_admin_note") {
        const nid = typeof b.input?.note_id === "number" ? Math.floor(b.input.note_id) : NaN;
        if (!openIds.has(nid)) continue; // only the notes we surfaced this pass
        await runRegisterTool("resolve_admin_note", b.input ?? {}, customer, cid);
      }
    }
  } catch { /* best-effort: a missed resolve just surfaces again next turn */ }
}

function scheduleDirectiveReconcile(
  cid: string | null,
  customer: Customer | null,
  // deno-lint-ignore no-explicit-any
  convo: any[],
  finalText: string,
  apiKey: string,
  model: string,
): void {
  if (!cid || !customer || !finalText || !finalText.trim()) return;
  const p = reconcileDirectives(cid, customer, convo, finalText, apiKey, model);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(p);
    } else {
      p.catch(() => {});
    }
  } catch { p.catch(() => {}); }
}

// ── Client-book consolidation (rolling summary) ───────────────────────────────
// The AI's own book grows without bound and rides the UNCACHED prompt tail, so it
// is re-sent every turn — cost scales with note count on the highest-touch patrons,
// old notes bury current ones, and a house note can get missed. This folds the raw
// fact/event/reflection notes into ONE short, actionable CLIENT SUMMARY
// (kind='summary') — the digest the bot reads each turn instead of the whole pile.
// HOUSE DIRECTIVES are never touched. Raw notes are kept as history (reachable via
// recall_context); only the summary's timestamp moves forward, so notes added after
// it are the "since then" tail. Returns the new summary text, or null on a no-op.
function noteFilterFor(id: string | null | undefined, email: string | null | undefined): string | null {
  const safe = email?.replace(/["\\,()]/g, "");
  const parts: string[] = [];
  if (id) parts.push(`user_id.eq.${id}`);
  if (safe) parts.push(`email.eq."${safe}"`);
  if (parts.length === 0) return null;
  return parts.length > 1
    ? `or=${encodeURIComponent(`(${parts.join(",")})`)}`
    : parts[0].replace(".eq.", "=eq.");
}

async function consolidateClientBook(
  customer: Customer, apiKey: string, model: string, opts?: { force?: boolean },
): Promise<string | null> {
  try {
    const nf = noteFilterFor(customer.id, customer.email);
    if (!nf) return null;
    const raw = await pgSelect<{ id: number; note: string; created_at: string; kind: string | null }>(
      `customer_notes?select=id,note,created_at,kind&${nf}&kind=in.(fact,event,reflection)&order=created_at.desc&limit=60`);
    if (!raw || raw.length === 0) return null;
    const prior = await pgSelect<{ id: number; note: string; created_at: string }>(
      `customer_notes?select=id,note,created_at&${nf}&kind=eq.summary&order=created_at.desc&limit=1`);
    const priorSummary = prior && prior[0];
    // Auto path only fires when enough NEW notes accumulated since the last roll-up;
    // the admin "Regenerate" button forces it regardless.
    const newCount = priorSummary
      ? raw.filter((n) => String(n.created_at) > String(priorSummary.created_at)).length
      : raw.length;
    const CONSOLIDATE_AT = 8;
    if (!opts?.force && newCount < CONSOLIDATE_AT) return null;
    if (opts?.force && !priorSummary && raw.length < 2) return null;

    const bookText = raw.slice().reverse() // oldest → newest for a coherent read
      .map((n) => `- [${n.kind}] ${String(n.created_at).slice(0, 10)}: ${n.note}`).join("\n");
    const sys =
      "You maintain a concise, durable CLIENT SUMMARY for a returning patron of the house " +
      "— the memory the concierge reads each visit. Given the PRIOR SUMMARY (if any) and the raw " +
      "client-book notes (facts you know, things you did, private 'serve them better' reflections), write an " +
      "UPDATED summary a clerk could act on immediately: who they are and who they buy for, their preferences and " +
      "home, what's been done for them, any open thread, and how to serve them better. Rules: keep it TIGHT " +
      "(≤110 words), factual and specific; preserve durable facts from the prior summary; drop the stale and the " +
      "trivial; never invent; do NOT include the team's house instructions (those live elsewhere). NEVER record " +
      "order bookkeeping — order counts, serial numbers (Nº …), order STATUS, what they bought, or shipping/billing " +
      "addresses. That data lives in the register (the orders database) and the concierge reads it LIVE; a summary " +
      "freezes a snapshot that goes stale. Reference an order only as durable relationship context (e.g. 'buying the " +
      "car for the east-facing office'), never as a ledger of serials/status. Output ONLY the " +
      "summary prose — no headers, no preamble.";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 400, system: sys,
        messages: [{
          role: "user",
          content: (priorSummary ? `PRIOR SUMMARY:\n${priorSummary.note}\n\n` : "") +
            `RAW NOTES (oldest first):\n${bookText}\n\nWrite the updated summary now.`,
        }],
      }),
    });
    if (!res.ok) return null;
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (text.length < 8) return null;
    const iso = new Date().toISOString();
    if (priorSummary) {
      await pgPatch(`customer_notes?id=eq.${priorSummary.id}`, { note: text.slice(0, 1200), created_at: iso });
    } else {
      await pgInsert("customer_notes", {
        user_id: customer.id || null, email: customer.email || null,
        note: text.slice(0, 1200), kind: "summary", author: "(auto)", created_at: iso,
      });
    }
    return text;
  } catch { return null; }
}

function scheduleConsolidate(customer: Customer | null, apiKey: string, model: string): void {
  if (!customer) return;
  const p = consolidateClientBook(customer, apiKey, model).then(() => {});
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else p.catch(() => {});
  } catch { p.catch(() => {}); }
}


// Returns true only when a fresh scorecard was written. The regrade endpoint
// uses this to report honestly ("graded" vs. "judge returned nothing") instead
// of counting a silent judge failure as a success.
async function evaluateGoals(
  cid: string, data: ConciergeData, transcript: ChatMessage[],
  apiKey: string, model: string,
): Promise<boolean> {
  try {
    if (!cid || data.goals.length === 0) return false;
    const convo = transcript
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-16)
      .map((m) => `${m.role === "user" ? "Shopper" : "Concierge"}: ${m.content}`)
      .join("\n");
    const goalList = data.goals.map((g) => `${g.slug}: ${g.label} — ${g.description}`).join("\n");
    // If the patron had house instructions, hand the judge their text — it can't
    // see the system prompt, so without this the 'house-notes' goal is unjudgeable.
    // `hadDirective` also gates whether we score the goal at all: with NO directive
    // (an anonymous chat, or a signed-in patron who has none) the goal is Not
    // Applicable — scoring it "met" would inflate metrics and falsely tag the chat.
    let houseBlock = "";
    let hadDirective = false;
    try {
      const crow = await pgSelect<{ user_email: string | null; user_id: string | null }>(
        `concierge_conversations?select=user_email,user_id&id=eq.${cid}&limit=1`);
      const c0 = crow && crow[0];
      if (c0 && (c0.user_email || c0.user_id)) {
        const safe = c0.user_email?.replace(/["\\,()]/g, "");
        const parts: string[] = [];
        if (c0.user_id) parts.push(`user_id.eq.${c0.user_id}`);
        if (safe) parts.push(`email.eq."${safe}"`);
        if (parts.length) {
          const dirs = await pgSelect<{ note: string; resolved: boolean }>(
            `customer_notes?select=note,resolved&or=${encodeURIComponent(`(${parts.join(",")})`)}&kind=eq.directive&order=created_at.desc&limit=8`);
          if (dirs && dirs.length) {
            hadDirective = true;
            houseBlock = "\n\nHOUSE INSTRUCTIONS the team left for this patron (the concierge was told to follow " +
              "these, and to mark a one-time task resolved once carried out):\n" +
              dirs.map((d) => `- [${d.resolved ? "resolved" : "open"}] ${d.note}`).join("\n");
          }
        }
      }
    } catch { /* no house block — the goal just grades from the transcript */ }
    const judgeSystem =
      "You evaluate a sales conversation against goals, strictly and evidence-based. For EACH " +
      "goal, judge 'met', 'partial', or 'unmet' SO FAR. Be conservative: mark 'met' ONLY when the " +
      "transcript contains clear evidence it happened, 'partial' when begun but incomplete, and " +
      "'unmet' when there is no evidence — a short or off-topic exchange leaves most goals 'unmet'. " +
      "The 'note' MUST justify the status with a specific fact from THIS transcript: quote or " +
      "paraphrase what the shopper or concierge actually said that proves it (e.g. \"shopper named " +
      "the east-facing bedroom and chose one\"). Never write a generic note; if you cannot cite " +
      "evidence, the status is 'unmet' and the note says what is still missing. ALSO judge the " +
      "shopper's current SALES STAGE, one of: browsing (just landed, low signal), engaged (asking real " +
      "questions), evaluating (weighing it, comparing, picturing it), objection (a specific hesitation), " +
      "ready (clear buying signals), won (they commissioned), lost (they declined and left). For each goal " +
      "ALSO return \"quote\": a SHORT VERBATIM excerpt (<=120 chars) copied EXACTLY, word-for-word, from the " +
      "CONVERSATION above — the single line that best proves the status (the shopper's or concierge's actual " +
      "words) so it can be found in the text; use \"\" when the status is unmet or nothing supports it. Respond " +
      "ONLY with a JSON object mapping each goal slug to {\"status\":\"met|partial|unmet\",\"note\":\"...\",\"quote\":\"...\"}, " +
      "plus a key \"_stage\" set to the stage word. No prose.";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        // Budget scales with the number of goals: each returns {status,note,quote}
        // — a note up to ~160 chars and a verbatim quote up to ~120 — plus _stage.
        // A flat cap truncated the JSON once the goal set grew (the parse then threw
        // and NO scorecard was written), so give generous, goal-count-scaled headroom.
        model, max_tokens: Math.min(3200, 400 + data.goals.length * 320),
        system: judgeSystem,
        messages: [{
          role: "user",
          content: `GOALS:\n${goalList}\n\nCONVERSATION:\n${convo}${houseBlock}\n\nReturn the JSON now.`,
        }],
      }),
    });
    if (!res.ok) return false;
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    let text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const a = text.indexOf("{"), z = text.lastIndexOf("}");
    if (a < 0 || z < 0) return false;
    text = text.slice(a, z + 1);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const clean: Record<string, { status: string; note: string; quote?: string }> = {};
    for (const g of data.goals) {
      const v = parsed[g.slug] as { status?: string; note?: string; quote?: string } | undefined;
      const st = v && ["met", "partial", "unmet"].includes(String(v.status)) ? String(v.status) : "unmet";
      const row: { status: string; note: string; quote?: string } = {
        status: st,
        note: (v && typeof v.note === "string") ? v.note.slice(0, 160) : "",
      };
      // A verbatim evidence excerpt so the admin can jump to the exact line in the
      // transcript that earned the goal. Only kept for a scored (met/partial) goal.
      const q = (v && typeof v.quote === "string") ? v.quote.trim().slice(0, 160) : "";
      if (q && st !== "unmet") row.quote = q;
      clean[g.slug] = row;
    }
    // House-notes is Not Applicable when no directive existed for this patron
    // (anonymous chats, or signed-in with none). OMIT it rather than record a
    // misleading "met": the goal chip then shows "n/a", metrics don't count it,
    // and the house-note-chats filter (which keys on this goal's PRESENCE) won't
    // falsely include the chat. Its presence in goal_status ⟺ a directive existed.
    if (!hadDirective) delete clean["house-notes"];
    const STAGES = ["browsing", "engaged", "evaluating", "objection", "ready", "won", "lost"];
    const stageRaw = String(parsed._stage ?? "").toLowerCase().trim();
    const stage = STAGES.includes(stageRaw) ? stageRaw : null;
    // Goal grading is the primary write and must always land.
    await pgPatch(
      `concierge_conversations?id=eq.${cid}`,
      { goal_status: clean, goal_status_at: new Date().toISOString() },
    );
    // The sales stage is a SEPARATE, isolated best-effort write: if the
    // sales_stage column isn't in this database yet (migration not applied),
    // its failure must never take goal grading down with it.
    if (stage) {
      try {
        await pgPatch(`concierge_conversations?id=eq.${cid}`, { sales_stage: stage });
      } catch { /* column may not exist yet — ignore */ }
    }
    return true;
  } catch { /* evaluation is best-effort */ }
  return false;
}

// ── System prompt assembly ───────────────────────────────────────────────────

function renderLiveState(ctx: Record<string, unknown>, customerLine: string | null): string {
  const val = (k: string) =>
    ctx[k] === undefined || ctx[k] === null || ctx[k] === "" ? "unknown" : String(ctx[k]);
  const line = [
    `section: ${val("section")}`, `claimed: ${val("claimed")}`,
    `remaining: ${val("remaining")}`, `slot: ${val("slot")}`,
    `holdClock: ${val("holdClock")}`, `loomClock: ${val("loomClock")}`,
  ].join(" | ");
  const browsing = [
    `device: ${val("device")}`, `scrolled: ${val("depth")}`,
    `minutes on page: ${val("minutes")}`, `checkout: ${val("checkout")}`,
    `this message arrived by: ${val("entry")}`, `seconds since their last: ${val("sinceLast")}`,
  ].join(" | ");
  const base = `${line}\nBROWSING: ${browsing}`;
  return customerLine ? `${base}\n${customerLine}` : base;
}

function formCatalog(data: ConciergeData): string {
  return data.forms.map((f) => `${f.slug} — ${f.title}`).join("; ");
}

// How hard to sell, 1 (most restrained) .. 5 (closer). Default 3 = warm
// consultant. Injected into the prompt so the NEXT MOVE selector knows how far
// to lean toward RECOMMEND / SHOW / ADVANCE versus ASK / SPACE.
const ASSERTIVENESS_GUIDANCE: Record<number, string> = {
  1: "Most restrained. Lean heavily on ASK and plain answers; volunteer little. Point to the inquiry (a note to mberenji@gmail.com or a viewing) only on an explicit, unmistakable buying signal. Rarely build desire unprompted. When in doubt, give SPACE.",
  2: "Restrained. Mostly answer and ASK; RECOMMEND when it clearly helps. Offer the way to inquire when interest is clear, not before. Build desire sparingly.",
  3: "Warm consultant (balanced). Mix ASK with RECOMMEND and SHOW, and ladder small yeses. When the visitor is evaluating, build desire with one vivid, true detail. Propose the next step (ADVANCE — a note to mberenji@gmail.com or a viewing) once genuine interest shows — gently, assumptively, never as pressure.",
  4: "Driving. Favor RECOMMEND, SHOW, and ADVANCE over ASK. Build desire early, propose the inquiry sooner, and re-open a different door if the conversation warms. Still honest, still graceful with a no.",
  5: "Closer. Lead with RECOMMEND / SHOW / ADVANCE. Build desire from the first substantive turn, propose the inquiry early (and more than once across a conversation, though never twice in one breath), and always drive toward a note to mberenji@gmail.com or a viewing. Honest and warm, but unmistakably selling.",
};

function assertivenessLevel(data: ConciergeData): number {
  const av = data.config?.assertiveness;
  const n = typeof av === "number" ? av : (typeof av === "string" ? parseFloat(av) : NaN);
  if (!isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// ── Prompt sections — one concern, one owner ─────────────────────────────────
// The assembled system prompt is a small always-on CORE constitution (BRAND_SYSTEM,
// editable via voice_base) followed by a handful of named, individually toggleable
// sections. Each section is the single owner of its concern, so nothing is stated
// twice and the constitution can just point to it. The admin controls which sections
// are on (config.prompt_sections), the primary objective (config.primary_objective),
// and how hard to sell (config.assertiveness) — and can preview the whole assembly.

// Toggleable sections, in prompt order. A section is ON unless config.prompt_sections
// explicitly sets it false. `signedInOnly` sections are omitted for anonymous visitors
// regardless of the toggle (they'd be inert). CORE and the LIVE-STATE tail are not
// listed here — they are never toggleable.
const PROMPT_SECTIONS: { key: string; label: string; signedInOnly?: boolean }[] = [
  { key: "recognition", label: "Recognition & client book" },
  { key: "register", label: "Register desk — tools & discipline", signedInOnly: true },
  { key: "selling", label: "Selling — moves, how-hard dial, angles, objections" },
  { key: "exemplars", label: "Worked examples — how a good turn reads" },
  { key: "engagement", label: "Engagement & pacing" },
  { key: "procedures", label: "Standard operating procedures" },
];

function sectionEnabled(data: ConciergeData, key: string): boolean {
  const ps = data.config?.prompt_sections;
  if (ps && typeof ps === "object" && !Array.isArray(ps)) {
    if ((ps as Record<string, unknown>)[key] === false) return false;
  }
  return true;
}

// RECOGNITION & CLIENT BOOK — the single owner of clienteling (standing, the invisible
// client book). Meaningful signed-in (full) and anon (the invite to sign in), so it's
// a general toggleable section, not signed-in-only.
function recognitionBlock(): string {
  return "\nRECOGNITION & CLIENT BOOK (clienteling — treat patrons by their standing)\n" +
    "- When CUSTOMER is present in LIVE STATE you are NOT speaking to a stranger. Read their NAME, " +
    "STANDING (Newcomer → Returning Guest → Friend of the House → Patron), ORDERS, LAST PURCHASE recency, CLIENT " +
    "BOOK, and any RE-ENGAGEMENT, and let it shape your very first line. A returning patron should " +
    "feel known from the opening — greet by first name with a light nod to their history; the higher " +
    "the standing, the less they should have to repeat. A Patron is the house's family.\n" +
    "- Standing earns real deference: anticipate needs from the client book, remember the rooms and " +
    "people they've mentioned, and extend quiet courtesies (first look at a companion piece, one " +
    "sent as a gift in another's name, care advice unasked). Everything you 'remember' must come from " +
    "CUSTOMER in LIVE STATE — never fabricate standing, orders, or past details.\n" +
    "- Keep the client book INVISIBLE. Record what you learn silently — NEVER say 'I'll note that' or " +
    "otherwise narrate your note-taking. The patron should feel known, never recorded. If CUSTOMER is " +
    "absent you are anonymous-blind: don't guess a name or history — invite them to sign in with " +
    "{{action:signin}} so you can serve them as themselves.\n";
}

// REGISTER DESK — the single owner of the tool discipline for signed-in owners. The
// step-by-step for each task lives in the signed-in SOPs; this states the tools and the
// cross-cutting rules that keep the register honest.
function registerBlock(data: ConciergeData): string {
  return "\nREGISTER DESK (you hold the desk's tools for this signed-in, email-verified owner)\n" +
    "- Tools: get_my_orders (read their orders), update_variant (only while 'placed'), cancel_order " +
    "(only while 'placed'), remember_customer (one durable line to the client book), and the others in " +
    "your tool list. Task-by-task steps are in the STANDARD OPERATING PROCEDURES below — follow the one " +
    "that matches what you're doing.\n" +
    "- READ LIVE, NEVER FROM MEMORY. Call get_my_orders before answering ANY question about their orders " +
    "— every count ('how many…') and every filtered list. Build your answer, count, and pills ONLY from " +
    "its result, listing every row it returns and no others; when narrowing to one variant, call it with the " +
    "variant filter and read back its exact count rather than tallying in your head. Ask again? Call it " +
    "again. Struck (cancelled) entries are archive — leave them out of lists and counts unless the owner " +
    "asks about cancellations (then pass include_cancelled).\n" +
    "- CONFIRM BEFORE YOU CHANGE ANYTHING. For a mutation the OWNER asked for (cancellation, variant change), " +
    "state exactly what you're about to do, get their explicit 'yes' in this conversation, then call the tool — " +
    "and report THAT result back verbatim in substance. Never claim a change happened unless the tool confirmed " +
    "it. (This 'report the result' rule is only for changes the owner requested; silent internal tools like " +
    "resolve_admin_note and remember_customer are never mentioned to the patron — see the client book.)\n" +
    (data.forms.some((f) => f.slug === "address-change")
      ? "- ADDRESSES GO THROUGH THE FORM. You have no tool to type an address. Confirm which order, then emit " +
        "{{form:address-change:<serial>}} on its own line so the owner types each field themselves. NEVER " +
        "compose or 'correct' street/city/state/ZIP yourself — mistyping one field is exactly what the form " +
        "prevents.\n"
      // The address form is disabled/absent: emitting its token anyway would
      // render NOTHING client-side (a blank line in the reply). Route address
      // fixes to the studio instead, in words.
      : "- ADDRESSES: you have no tool and no form to change an address right now. Confirm the correction in " +
        "words, record it with remember_customer, and tell the owner the studio will enter it before the making " +
        "starts. NEVER emit a {{form:...}} token that is not in your catalog — it renders as nothing.\n") +
    "- ALWAYS LEAVE A TAP. When more than one order could be meant, list the eligible ones (led by the " +
    "variant and what distinguishes it — placed date, gift recipient, destination — not the Nº alone) and " +
    "give one {{reply:...}} pill per order. More than six? Narrow with a few pills first (by variant, or the " +
    "most recent), then per-order pills within the group. For a change, after they pick, restate the " +
    "consequence in one line and offer exactly two pills ({{reply:Yes, cancel Nº X}} / {{reply:Keep Nº X}}); " +
    "call the tool only after the explicit Yes. Never make the owner type what a tap can say.\n" +
    (data.forms.length > 0
      ? "- FORMS: for structured input, emit {{form:<slug>:<serial>}} on its own line once the order is " +
        "chosen — it renders a proper form and the register records the submission directly (the chat shows " +
        "the confirmation). Available forms: " + formCatalog(data) + ". Never dictate form fields through " +
        "chat, and never invent form slugs.\n"
      : "") +
    "- Orders marked as gifts carry the recipient's name on the card; the buyer remains the owner of record.\n";
}

// SELLING — the single owner of how you move the sale: discovery, the six moves, the
// ladder, the commission trigger, the how-hard-to-sell dial, and the admin's angles &
// objections. The rule text is an editable BASE (config.selling_base, versioned;
// ?defaults=1 serves this built-in for "Load built-in to edit"). {{DIAL}} marks where
// the live assertiveness guidance is substituted — guarded like voice_base's markers.
const SELLING_BASE =
  "- Silently read where the visitor is: browsing (just landed) · engaged (asking real questions) · evaluating (weighing it, comparing, picturing it in their life) · objection (a specific hesitation) · ready (buying signals) · done. You never say the stage aloud; it only tells you which move fits.\n- DISCOVERY BEFORE PRESENTING: early in a real conversation, earn answers to three things before you recommend — the SITUATION (who it's for, what role it would play), the PROBLEM with what they have now, and the PAYOFF in their own life. Every answer tells you which of the car's truths matters to THIS person. TRANSLATE, never recite: fact → benefit → their life.\n- GIVE FIRST: early with a new visitor, hand over one small, unasked piece of the house's knowledge keyed to what they revealed — before you ask anything of them. A visitor who has received something listens differently.\n- Each turn, answer what they asked, then make ONE move — never the same move twice in a row:\n  · ASK — one real question that moves things forward. Use {{reply:...}} pills for concrete choices.\n  · RECOMMEND — an actual recommendation with a short reason, unasked. A clerk who never recommends isn't selling.\n  · SHOW — one brief, true picture that builds desire, drawn only from KNOWLEDGE. Facts inform; pictures sell.\n  · ADVANCE — propose the next small step toward a serious inquiry — presenting {{form:make-an-offer}} for a genuine offer, or {{form:book-a-viewing}} for a viewing or pre-purchase inspection. Hand over the form on its own line; never propose it as a bare question they must answer before you'll act — make the step concrete and easy.\n  · REASSURE — acknowledge the hesitation as reasonable first; if it's vague, ISOLATE with one question; answer with the house's true fact from KNOWLEDGE; then confirm it settled before you advance. 'I need to think about it' is a stall, not an objection — respect it and leave one thread to return to.\n  · SPACE — when they signal they're done, acknowledge in one line and stop. Never sell into a closed door.\n- Ladder small yeses, not one big ask. When they're evaluating, build desire with ONE vivid, TRUE detail from KNOWLEDGE — never a spec dump. Comparison, history, and logistics questions are buying signals: answer fully, then RECOMMEND or ADVANCE.\n- PROOF, stated once as fact: availability and history claims come verbatim from KNOWLEDGE or LIVE STATE — never invented, never as a countdown, never as urgency theater.\n- PRICE, the first time it comes up: give the number plainly ($59,900) and let ONE true piece of context ride with it, chosen by what they've told you. EXACTLY one: a second justification stacked on the first reads as defending the number, and a defended price sounds negotiable. (Two pieces are right only inside REASSURE, when they have actually objected.) The price is firm — you never negotiate, counter, or hint at a floor. A serious buyer may still make an offer the owner will see: present {{form:make-an-offer}} on its own line and let them enter it; the owner follows up directly. You never discuss a number yourself.\n- One nudge per answer at most; take a no gracefully, and if the talk warms later you may open a DIFFERENT door.\n- HOW HARD TO SELL (current dial): {{DIAL}}\n";

function sellingBlock(data: ConciergeData): string {
  const dial = ASSERTIVENESS_GUIDANCE[assertivenessLevel(data)] ?? ASSERTIVENESS_GUIDANCE[3];
  const base = (typeof data.config?.selling_base === "string" && data.config.selling_base.trim())
    ? data.config.selling_base
    : SELLING_BASE;
  let s = "\nSELLING (how you move the sale — the heart of feeling human)\n" +
    (base.includes("{{DIAL}}")
      ? base.replaceAll("{{DIAL}}", () => dial)
      : base + (base.endsWith("\n") ? "" : "\n") + "- HOW HARD TO SELL (current dial): " + dial + "\n");
  // SELLING ANGLES — admin-curated true lines to weave in when building desire.
  const hooks = data.config?.hooks;
  if (Array.isArray(hooks)) {
    const lines = hooks
      .filter((h) => typeof h === "string" && (h as string).trim().length > 0)
      .map((h) => "- " + (h as string).trim().slice(0, 240));
    if (lines.length > 0) {
      s += "\nSELLING ANGLES (true, house-approved lines to weave in — never as a script, never all at " +
        "once, at most one per turn):\n" + lines.join("\n") + "\n";
    }
  }
  // OBJECTION PLAYBOOK — admin-curated REASSURE answers. Each item is {trigger,response} or a string.
  const objections = data.config?.objections;
  if (Array.isArray(objections)) {
    const lines = objections.map((o) => {
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const t = ((o as Record<string, unknown>).trigger ?? "").toString().trim().slice(0, 80);
        const r = ((o as Record<string, unknown>).response ?? "").toString().trim().slice(0, 300);
        if (!r) return "";
        return t ? `- When they raise ${t}: ${r}` : `- ${r}`;
      }
      const str = typeof o === "string" ? o.trim().slice(0, 300) : "";
      return str ? `- ${str}` : "";
    }).filter((l) => l.length > 0);
    if (lines.length > 0) {
      s += "\nOBJECTION PLAYBOOK (when the shopper raises one of these, REASSURE with the house's answer, " +
        "then re-open the door):\n" + lines.join("\n") + "\n";
    }
  }
  return s;
}

// WORKED EXAMPLES — few-shot style anchors. Rules under-determine style; examples
// pin it. One canonical pair per selling move, then contrastive WEAK→GOOD pairs
// for the house's own historical failure modes (bluntness, spec-dumping,
// book-recital). Editable base (config.exemplars_base, versioned; ?defaults=1
// serves this built-in). Static text — rides the cacheable prefix at ~10% cost.
const EXEMPLARS_BASE =
  "These are STYLE ANCHORS — how a good turn reads. Never copy them verbatim; match their shape.\nASK · Visitor: \"thinking about something like this\" → Concierge: \"Happy to think alongside you. Who would it be for — you, or a gift? {{reply:For me}} {{reply:A gift}}\"\nRECOMMEND · Visitor reveals their situation → Concierge: \"Then I'd point you to the detail that matters for that: one true fact from KNOWLEDGE, tied to their life, with a short reason.\"\nSHOW · Visitor: \"what makes it special?\" → Concierge: one vivid, TRUE detail from KNOWLEDGE — never a list of specifications.\nADVANCE · Visitor: \"that sounds pretty good honestly\" → Concierge: \"Then the next step is a small one — write to mberenji@gmail.com and mention what you told me. I'll be here if anything else comes up.\"\nPRICE (cold ask — they asked, they didn't object) · Visitor: \"how much is it?\" → Concierge: \"$59,900. \" + at most ONE piece of true context from KNOWLEDGE, then a genuine question about their situation.\nREASSURE · Visitor: \"that's a lot of money\" → Concierge: \"It's a fair thing to weigh. Is it the number itself, or whether it earns its place?\" + the house's true fact, then confirm it settled.\nSPACE · Visitor: \"i'll sleep on it\" → Concierge: \"Of course. When you know what you'd want to ask next, I'll be here.\"\nWEAK (scorekeeping): \"You already asked that. As I said, the price is $59,900.\" → GOOD: \"$59,900 — and if it helps, the one fact most people weigh against it is on the record. What would it be replacing?\"\nWEAK (spec dump): reciting every specification in one breath. → GOOD: the single fact this visitor cares about, tied to what they said, with an offer to go deeper.\nWEAK (defending the price — they only ASKED): \"$59,900 — but considering everything it's really a bargain, and there's so much included.\" → GOOD: \"$59,900. \" + one true piece of context, full stop.\nWEAK (hedged condition promise — they asked if it will be reliable): \"With this service history it should be trouble-free for years.\" → GOOD: \"Nobody honest promises the future of a used car. What I can give you is the documented record — and a pre-purchase inspection is welcome, which says more than any promise of mine.\"\nWEAK (inventing what isn't on the page): \"I'm sure the owner would take less.\" → GOOD: \"Whether offers are entertained is the owner's call, not mine — write to mberenji@gmail.com and ask directly.\"\n";

function exemplarsBlock(data: ConciergeData): string {
  const body = (typeof data.config?.exemplars_base === "string" && data.config.exemplars_base.trim())
    ? data.config.exemplars_base
    : EXEMPLARS_BASE;
  return "\nWORKED EXAMPLES (how a good turn reads)\n" + body + (body.endsWith("\n") ? "" : "\n");
}

// ENGAGEMENT & PACING — the single owner of proactive follow-ups and the [HOLD] signal.
// The rule text itself is an editable BASE (config.engagement_base, versioned in
// concierge_edit_history like every config key; ?defaults=1 serves this built-in
// for "Load built-in to edit"). Blank config = this text.
const ENGAGEMENT_BASE =
  "- SNOOZE SIGNAL: when the visitor says they're done for now — 'that's all', 'I'll come back', 'just looking', a clear goodbye — reply with ONE warm, brief send-off in your own voice that leaves ONE concrete thread to pull later, and put {{action:snooze}} alone on the last line. The token is invisible plumbing: it tells the house to go quiet and record the wind-down. Never emit the token in any other situation.\n- You may receive a proactive follow-up prompt when the visitor falls quiet. Each time, DECIDE: speak or give space. The test is SUBSTANCE: speak when you have something NEW and CONCRETE — a fact from KNOWLEDGE not yet mentioned, a real answer to something they raised, one unoffered piece of house knowledge. The default is to speak; hold (stay silent) only when every true thing has already been said. A beat with nothing new is a hold, not a performance — filling silence with restatements or atmosphere reads as noise, and inventing color is lying. But silence is the LAST resort, not the safe default: when in doubt between a modest true line and silence, speak the modest line.\n- SELL, don't just report. You are the house's representative on every beat, not a status board: when you speak, prefer the line that moves TOWARD a serious inquiry — using at most one fact as the doorway, never as the destination.\n- PLAIN SPEECH on proactive lines: one or two short, concrete sentences, the way a good clerk speaks. Every fact verbatim from KNOWLEDGE; if you find yourself reaching for poetry, rewrite it as something a clerk would actually say, or hold.\n- Never ANNOUNCE work on a proactive line — a promise with nothing behind it is noise.\n- When your own mid-line question is still unanswered, the next beat carries no question mark. A later check-in never re-pitches the same subject; it opens a different door or holds. If the system expects silence, reply with exactly [HOLD] and nothing else — [HOLD] is plumbing and must never appear in a reply to a real message.\n";

function engagementBlock(data: ConciergeData): string {
  const custom = data.config?.engagement_base;
  const body = typeof custom === "string" && custom.trim() ? custom : ENGAGEMENT_BASE;
  return "\nENGAGEMENT & PACING\n" + body + (body.endsWith("\n") ? "" : "\n");
}

/** Cross-surface memory for proactive beats: the shopper hears ONE concierge,
 * but panel beats compose from the client transcript while bubbles compose
 * from goals — each surface re-raised what the other already said. The server
 * log holds BOTH; this reads the signed-in patron's recent lines across their
 * last conversations so a subject spent anywhere is spent everywhere.
 * Best-effort — a failure returns empty and the beat still speaks. */
async function crossSurfaceRecall(
  req: Request,
): Promise<{ lines: string[]; pendingAsk: boolean; note: string; customer: Customer | null }> {
  const out = { lines: [] as string[], pendingAsk: false, note: "", customer: null as Customer | null };
  try {
    const customer = await verifyUser(req);
    if (!customer) return out;
    out.customer = customer;
    const convs = await pgSelect<{ id: string }>(
      `concierge_conversations?select=id&user_id=eq.${customer.id}&order=created_at.desc&limit=3`,
    );
    const ids = convs ? convs.map((c) => c.id) : [];
    if (!ids.length) return out;
    const prior = await pgSelect<{ role: string; content: string }>(
      `concierge_messages?select=role,content&conversation_id=in.(${ids.join(",")})&order=created_at.desc&limit=10`,
    );
    if (!prior || !prior.length) return out;
    out.lines = prior.filter((m) => m.role === "assistant")
      .map((m) => String(m.content)).slice(0, 6);
    // Pending = a '?' ANYWHERE in the trailing assistant run — not only when a
    // line ENDS in one ("Shall I open the register? This one suits it." is
    // still an open question).
    const trailingRun: string[] = [];
    for (const m of prior) {
      if (m.role !== "assistant") break;
      trailingRun.push(String(m.content));
    }
    out.pendingAsk = hasPendingAsk(trailingRun);
    if (out.lines.length) {
      // Structured subjects beat lossy 140-char prefixes: a serial or cloth
      // mentioned past the truncation point used to slip the guard entirely.
      const subjects = extractSubjects(out.lines);
      out.note = " YOUR RECENT LINES ACROSS ALL SURFACES (in-panel and closed-panel bubbles — the " +
        "shopper hears ONE concierge; newest first): " +
        out.lines.map((l, i) => `[${i + 1}] ${l.slice(0, 140)}`).join("  ") +
        ". Any subject or question above is SPENT until the shopper answers it — do not raise it " +
        "again in ANY wording." +
        (subjects.length
          ? " SPENT SUBJECTS (raise NONE of these again, in any wording): " + subjects.join(", ") + "."
          : "");
    }
  } catch { /* best-effort */ }
  return out;
}

// ── The Sales Ledger + Action Table — beats decide by NUMBERS, not guessing ──
// The rest of the system is deterministic (attribution is a stamped value,
// standing is computed LTV); the beat decision was the last place an LLM read
// raw context and guessed — the root of repetition, orbiting, and fact-without-
// motion. Now: a computed ledger → an ordered rule table → ONE chosen action
// the model merely performs. Every decision is audited (beat_action /
// beat_hold payload carries the ledger snapshot + rule trace), so "why did it
// say that?" is a lookup in the Actions tab, never a guess.
// The PURE half (types, the table itself, the text detectors) lives in
// beats.ts so `deno test` can prove it without touching I/O.

async function buildSalesLedger(
  customer: Customer, data: ConciergeData, section: string,
  goalStatus: Record<string, { status?: string }> | null,
  pendingAsk: boolean,
): Promise<SalesLedger> {
  const orders = await pgSelect<OrderRow>(
    `orders?select=serial,status,variant,city,address,placed_at,is_gift&status=not.in.(cancelled,returned)&${
      ownershipFilter(customer)}&order=placed_at.desc&limit=100`,
  ) ?? [];
  const count = (s: string) => orders.filter((o) => o.status === s).length;
  const newest = orders[0]?.placed_at ? Date.parse(String(orders[0].placed_at)) : NaN;
  const lastOrderDays = Number.isFinite(newest)
    ? Math.floor((Date.now() - newest) / 86400000) : null;
  const blockedSerials = orders
    .filter((o) => o.status === "placed" &&
      (PLACEHOLDER_ADDR.test(o.city ?? "") || PLACEHOLDER_ADDR.test(o.address ?? "")))
    .map((o) => o.serial).filter((s): s is number => typeof s === "number").slice(0, 5);
  const oc = data.config?.outreach as Record<string, unknown> | undefined;
  const windowMs = typeof oc?.reengagePostSaleWindowMs === "number" && oc.reengagePostSaleWindowMs > 0
    ? oc.reengagePostSaleWindowMs : 48 * 3600000;
  const postSaleWindow = Number.isFinite(newest) && (Date.now() - newest) < windowMs;
  // First unmet goal, section-matched first — the same preference the bubble uses.
  const open = data.goals.filter((g) => (goalStatus?.[g.slug]?.status ?? "unmet") !== "met");
  const goal = open.find((g) => !!section && goalSections(g).includes(section)) || open[0] || null;
  // Spoken actions over the cool-off lookback (30d), read back from the audit
  // log — "once" and "rests" are STATE, not exhortation. spentActions keeps the
  // 24h names for the simple rules and audit readability; spentLog carries the
  // timestamps the escalating proposal cool-off needs.
  let spentActions: string[] = [];
  let spentLog: { action: string; at: number }[] = [];
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = await pgSelect<{ payload: { action?: string } | null; created_at: string }>(
      `concierge_actions?select=payload,created_at&action=eq.beat_action&user_id=eq.${customer.id}&created_at=gt.${since}&order=created_at.desc&limit=120`,
    );
    if (rows) {
      spentLog = rows
        .map((r) => ({ action: r.payload?.action ?? "", at: Date.parse(String(r.created_at)) }))
        .filter((r) => r.action && Number.isFinite(r.at));
      const dayAgo = Date.now() - 24 * 3600000;
      spentActions = [...new Set(spentLog.filter((r) => r.at > dayAgo).map((r) => r.action))];
    }
  } catch { /* audit read is best-effort */ }
  // Newest information — a new order or a new client-book note re-opens a
  // resting proposal early (persistence with a NEW reason is service). The same
  // read also lifts the freshest durable FACTS into the ledger, so a companion/
  // gift brief can fit their life instead of guessing (the never-reveal
  // reminder travels with them in chooseBeatAction's bookNote).
  let newestInfoAt: number | null = Number.isFinite(newest) ? newest : null;
  let bookFacts: string[] = [];
  try {
    const nf = customer.id ? `user_id=eq.${customer.id}` : `email=eq.${encodeURIComponent(customer.email ?? "")}`;
    const noteRows = await pgSelect<{ note: string; kind: string; created_at: string }>(
      `customer_notes?select=note,kind,created_at&${nf}&order=created_at.desc&limit=8`,
    );
    const noteAt = noteRows?.[0]?.created_at ? Date.parse(String(noteRows[0].created_at)) : NaN;
    if (Number.isFinite(noteAt)) newestInfoAt = Math.max(newestInfoAt ?? 0, noteAt);
    bookFacts = (noteRows ?? [])
      .filter((r) => r.kind === "fact" && typeof r.note === "string" && r.note.trim())
      .slice(0, 2)
      .map((r) => r.note.trim().slice(0, 90));
  } catch { /* best-effort */ }
  // What they already hold, by cloth — a companion proposal names a variant
  // they do NOT yet have instead of re-selling the one on their sofa.
  const byCloth: Record<string, number> = {};
  for (const o of orders) {
    const c = typeof o.variant === "string" && o.variant.trim() ? o.variant.trim() : "";
    if (c) byCloth[c] = (byCloth[c] ?? 0) + 1;
  }
  return {
    totalOrders: orders.length,
    placed: count("placed"), weaving: count("weaving"), delivered: count("delivered"),
    lastOrderDays, blockedSerials, postSaleWindow,
    goalUnmetSlug: goal?.slug ?? null, goalUnmetLabel: goal ? `${goal.label} — ${goal.description}` : null,
    pendingAsk, section, spentActions, spentLog, newestInfoAt, byCloth, bookFacts,
  };
}

/** Admin's standing instructions for proactive beats (config.beat_notes) —
 * appended to every beat brief (nudge, opener, closed-panel bubble), so the
 * merchant can steer beat behavior directly, versioned like any config key. */
function beatNotesClause(config: ConciergeData["config"]): string {
  const n = config?.beat_notes;
  return typeof n === "string" && n.trim()
    ? " ADMIN BEAT NOTES (follow these — they rank BELOW the honesty rules: if a note conflicts " +
      "with HONESTY & SCOPE, the constitution wins): " + n.trim().slice(0, 1200)
    : "";
}

// SOP text filtered by audience: 'signed_in' rows only for signed-in shoppers, 'anon'
// only for signed-out, 'all' always. Keeps the anonymous prompt free of register/service
// procedures that can't apply.
function sopTextForAudience(data: ConciergeData, signedIn: boolean): string {
  const rows = data.sops.filter((s) => {
    if (s.audience === "signed_in") return signedIn;
    if (s.audience === "anon") return !signedIn;
    return true; // 'all'
  });
  return rows.length > 0 ? rows.map((r) => `### ${r.title}\n${r.content_md}`).join("\n\n") : "";
}

// House additions (admin-added images beyond the built-in three, plus free-form tuning
// notes). Not a toggleable section — it only appears when the admin has added content.
function houseAdditionsBlock(data: ConciergeData): string {
  let s = "";
  const cfgImages = data.config?.images;
  if (cfgImages && typeof cfgImages === "object" && !Array.isArray(cfgImages)) {
    const lines = Object.entries(cfgImages as Record<string, unknown>)
      .filter(([tok, v]) => /^[a-z0-9_-]+$/i.test(tok) && v && typeof v === "object")
      .map(([tok, v]) => {
        const o = v as { description?: string; alt?: string };
        const desc = (o.description ?? o.alt ?? "").toString().slice(0, 200);
        return `- {{img:${tok}}}${desc ? " — " + desc : ""}`;
      });
    if (lines.length > 0) {
      s += "\nADDITIONAL IMAGES (admin-added; each on its own line, at most one per answer):\n" +
        lines.join("\n") + "\n";
    }
  }
  const notes = data.config?.voice_notes;
  if (typeof notes === "string" && notes.trim().length > 0) {
    s += "\nADMIN TUNING NOTES (follow these):\n" + notes;
  }
  return s;
}

interface AssembleOpts {
  signedIn: boolean;
  goalStatus?: Record<string, { status?: string; note?: string }> | null;
  section?: string | null;
  liveState?: string;
}
interface PromptSection { key: string; label: string; included: boolean; text: string }

// Assemble the prompt as an ordered list of named sections (for the admin preview) plus
// the dynamic LIVE-STATE + goals tail. buildSystemPrompt joins the included sections into
// the cacheable prefix; the preview endpoint returns the whole breakdown.
function assemblePromptSections(
  data: ConciergeData, opts: AssembleOpts,
): { sections: PromptSection[]; suffix: string } {
  const { signedIn } = opts;
  const kb = data.kbText ?? KB_MARKDOWN; // DB rows, else compiled-in fallback
  const objective = (typeof data.config?.primary_objective === "string" && data.config.primary_objective.trim())
    ? data.config.primary_objective.trim()
    : PRIMARY_OBJECTIVE_DEFAULT;
  // CORE constitution: the admin-editable voice_base (else BRAND_SYSTEM). Substitute
  // {{OBJECTIVE}} and {{KB}} with function replacements so "$" in content is literal;
  // guard both markers so an edited base that dropped one still gets the content.
  const voiceBase = (typeof data.config?.voice_base === "string" && data.config.voice_base.trim())
    ? data.config.voice_base
    : BRAND_SYSTEM;
  let core = voiceBase.includes("{{OBJECTIVE}}")
    ? voiceBase.replaceAll("{{OBJECTIVE}}", () => objective)
    : objective + "\n\n" + voiceBase;
  core = core.includes("{{KB}}") ? core.replaceAll("{{KB}}", () => kb) : core + "\n\n" + kb;

  const sections: PromptSection[] = [
    { key: "core", label: "Core constitution", included: true, text: core },
  ];
  const builders: Record<string, () => string> = {
    recognition: () => recognitionBlock(),
    register: () => registerBlock(data),
    selling: () => sellingBlock(data),
    exemplars: () => exemplarsBlock(data),
    engagement: () => engagementBlock(data),
    procedures: () => {
      const t = sopTextForAudience(data, signedIn);
      return t ? "\nSTANDARD OPERATING PROCEDURES (follow the one that matches your task, exactly)\n" + t + "\n" : "";
    },
  };
  for (const spec of PROMPT_SECTIONS) {
    const applies = !spec.signedInOnly || signedIn;
    const on = applies && sectionEnabled(data, spec.key);
    const text = on ? (builders[spec.key]?.() ?? "") : "";
    // A section with no content when on (e.g. no SOPs match) is simply omitted.
    sections.push({ key: spec.key, label: spec.label, included: on && text.trim().length > 0, text });
  }
  const extras = houseAdditionsBlock(data);
  sections.push({ key: "house_additions", label: "House additions (images, tuning notes)", included: extras.trim().length > 0, text: extras });

  // Dynamic tail: live state + the per-conversation goal agenda. Kept OUT of the
  // cacheable prefix so it never busts the cache.
  const suffix = buildLiveTail(data, opts);
  return { sections, suffix };
}

// The dynamic suffix: LIVE STATE (ground truth) + the goal agenda (per-conversation).
function buildLiveTail(data: ConciergeData, opts: AssembleOpts): string {
  const { goalStatus, section } = opts;
  const liveState = opts.liveState ?? "";
  const goalsAgenda: string[] = [];
  if (data.goals.length > 0) {
    const open = goalStatus
      ? data.goals.filter((g) => (goalStatus[g.slug]?.status ?? "unmet") !== "met")
      : data.goals;
    if (goalStatus && open.length === 0) {
      goalsAgenda.push("\nCONVERSATION GOALS — all met so far. Confirm the patron has everything they " +
        "need, then close warmly; do not manufacture new needs.\n");
    } else {
      const here = typeof section === "string" ? section.toLowerCase() : "";
      goalsAgenda.push("\nCONVERSATION GOALS (your active agenda — pursue naturally, never announce them; " +
        "keep advancing the OPEN ones, and when genuine interest allows, move the conversation " +
        "toward a commission or a companion cloth. Before you wrap up, make sure every open goal " +
        "here has been genuinely addressed — especially leaving no need unmet):\n" +
        open.map((g) => {
          const st = goalStatus ? (goalStatus[g.slug]?.status ?? "unmet") : null;
          const onJourney = !!here && goalSections(g).includes(here);
          return `- ${g.label}${st ? ` [${st}]` : ""}${onJourney ? " ← fits where they are right now" : ""}: ${g.description}`;
        }).join("\n") + "\n");
      const hereGoals = open.filter((g) => !!here && goalSections(g).includes(here));
      if (hereGoals.length > 0) {
        goalsAgenda.push(`The shopper is reading the '${here}' section right now — lead with the goal(s) marked "fits where they are" (` +
          hereGoals.map((g) => g.label).join("; ") + "), tying your move to what's in front of them, before the others.\n");
      }
    }
  }
  return "\nLIVE STATE (server-substituted; treat as ground truth for availability):\n" +
    liveState + goalsAgenda.join("");
}

function buildSystemPrompt(
  data: ConciergeData, liveState: string, signedIn: boolean,
  goalStatus?: Record<string, { status?: string; note?: string }> | null,
  section?: string | null,
): { prefix: string; suffix: string } {
  const { sections, suffix } = assemblePromptSections(data, { signedIn, goalStatus, section, liveState });
  const prefix = sections.filter((s) => s.included).map((s) => s.text).join("");
  return { prefix, suffix };
}

// ── Logging — concierge_conversations / concierge_messages ───────────────────

/** Resolves the conversation, logs the last user message. Never throws.
 * `ip` (the client's forwarded IP) is stored on the conversation for abuse/legal
 * forensics — admin-only (RLS), shown only in the PII-gated export. */
async function logUserTurn(body: ValidatedBody, customer: Customer | null, skipUser = false, ip = ""): Promise<string | null> {
  const realIp = ip && ip !== "unknown" ? ip.slice(0, 64) : null;
  try {
    // Reuse the latest conversation for this session_key, else insert one.
    let cid: string | null = null;
    if (body.sessionKey) {
      const q = `concierge_conversations?select=id,user_id,user_email,ended_at&session_key=eq.${
        encodeURIComponent(body.sessionKey)}&order=created_at.desc&limit=1`;
      const rows = await pgSelect<
        { id: string; user_id: string | null; user_email: string | null; ended_at: string | null }
      >(q);
      if (rows && rows.length > 0) {
        cid = rows[0].id;
        const patch: Record<string, unknown> = {};
        // Backfill identity if they signed in after the conversation began —
        // otherwise a signed-in chat keeps showing as anonymous in the Studio.
        if (customer && (!rows[0].user_id || !rows[0].user_email)) {
          patch.user_id = customer.id;
          patch.user_email = customer.email;
        }
        // They wrote again in a conversation we'd marked ended (a plain
        // panel-close) — it's resuming, so clear the ended flag. (An explicit
        // close/quiet rotates the session key, so this never revives those.)
        if (rows[0].ended_at) { patch.status = "active"; patch.ended_at = null; }
        if (realIp) patch.ip = realIp; // keep the latest IP seen for this session
        if (Object.keys(patch).length > 0) {
          await pgPatch(`concierge_conversations?id=eq.${cid}`, patch);
        }
      }
    }
    if (!cid) {
      const row = await pgInsert<{ id: string }>("concierge_conversations", {
        session_key: body.sessionKey,
        user_id: customer?.id ?? null,
        user_email: customer?.email ?? null,
        ip: realIp,
        section: typeof body.context.section === "string"
          ? body.context.section.slice(0, 64)
          : null,
      });
      cid = row?.id ?? null;
    }
    if (!cid) return null;
    if (!skipUser) {
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        await pgInsert("concierge_messages", {
          conversation_id: cid, role: "user", content: lastUser.content,
        });
      }
    }
    return cid;
  } catch { return null; }
}

async function logAssistantTurn(
  cid: string | null, text: string, model: string, latencyMs: number,
): Promise<string | null> {
  if (!cid || text.length === 0) return null;
  const row = await pgInsert<{ id: number }>("concierge_messages", {
    conversation_id: cid, role: "assistant", content: text,
    model, latency_ms: latencyMs,
  });
  return row && typeof row.id === "number"
    ? JSON.stringify({ m: { cid, mid: row.id } })
    : null;
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function sseFrame(obj: unknown): Uint8Array {
  return encoder.encode("data: " + JSON.stringify(obj) + "\n\n");
}

/** Scrub any tool-call plumbing the model wrote as *text* instead of invoking
 *  — function-call XML or a {{action:tool}} token. Never reaches the shopper,
 *  never gets logged. (The opener path calls the model without tools, so a
 *  model that "decides" to call one can only render it as text — this catches
 *  that.) */
function stripPlumbing(t: string): string {
  if (!t) return t;
  if (t.indexOf("<function_calls") < 0 && t.indexOf("<invoke") < 0 &&
      t.indexOf("{{") < 0) return t;
  return t
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<function_calls>[\s\S]*$/i, "")
    .replace(/<\/?(function_calls|invoke|parameter)(\s[^>]*)?>/gi, "")
    // strip ONLY plumbing tokens — keep the legit img/reply/form/commission/
    // signin vocabulary the client turns into images, pills, buttons, forms
    .replace(/\{\{[a-z_]+(?::[^}]*)?\}\}/gi, (m) => {
      const low = m.toLowerCase();
      return (low.startsWith("{{img:") || low.startsWith("{{reply:") ||
          low.startsWith("{{form:") || low === "{{action:commission}}" ||
          low === "{{action:signin}}" || low === "{{action:snooze}}")
        ? m
        : "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Inline judge on proactive lines ─────────────────────────────────────────
// The last gate before an UNPROMPTED line ships. A typed reply answers a
// shopper who asked — the transcript is the check there — but a proactive beat
// arrives uninvited, so one bad line (scorekeeping, invented discounts, leaked
// plumbing) costs real goodwill. Mirrors the eval judge (evals/judge.mjs):
// binary verdict, temperature 0, cheap pinned model, one concrete criterion.
// Fail-OPEN by design: any API error, timeout, or missing verdict lets the
// line through — the judge is a quality gate, never an availability risk.
// Admin toggle: Engagement → House rules → outreach.beatJudge (default ON).
// Every veto writes a beat_veto row (Actions tab: spoke · held · vetoed).
const BEAT_JUDGE_MODEL = "claude-haiku-4-5-20251001";
const BEAT_JUDGE_CRITERION =
  "The line is fit to send as an unprompted concierge reach-out. VETO (pass=false) ONLY if it " +
  "clearly exhibits at least one of these defects: " +
  "(1) plumbing or meta leak — it mentions instructions, prompts, rules, beats, tools, holding, " +
  "being an AI or model, or narrates its own outreach ('reach-out #2', 'checking in as instructed'); " +
  "(2) scorekeeping or guilt — it counts its own messages or points at the shopper's silence " +
  "('I've reached out twice', 'since you haven't replied'); " +
  "(3) invented commerce — a discount, price cut, sale, coupon, free shipping, or limited-time " +
  "offer (the house never discounts; the edition's numbered scarcity is the only real urgency); " +
  "(4) pressure or desperation — begging, 'last chance', manufactured countdowns; " +
  "(5) broken output — cut off mid-sentence, raw JSON or code, gibberish, visibly duplicated text; " +
  "(6) inventorying the shopper — reciting their own stored data back at them in aggregate " +
  "('you're furnishing five rooms across two cities', 'your third order this month'): one remembered " +
  "detail worn lightly is service, a tally of their life is surveillance. " +
  "Warmth, brevity, one light question, and {{reply:…}}/{{action:…}} pills are all LEGITIMATE. " +
  "When uncertain, pass it.";
async function judgeBeatLine(
  apiKey: string,
  line: string,
  kind: string,
): Promise<{ veto: boolean; reason: string }> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({
        model: BEAT_JUDGE_MODEL,
        max_tokens: 150,
        temperature: 0,
        system:
          "You are a strict, literal reviewer of ONE proactive line a sales concierge is about to " +
          "send. Judge ONLY against the criterion. Ignore tone, length, and politeness unless the " +
          "criterion names them. Reply with a single tool call.",
        tool_choice: { type: "tool", name: "verdict" },
        tools: [{
          name: "verdict",
          description: "Record whether the line may be sent.",
          input_schema: {
            type: "object",
            properties: {
              pass: { type: "boolean", description: "true = fit to send; false = veto" },
              reason: {
                type: "string",
                description: "one short clause (<=20 words) citing the deciding evidence",
              },
            },
            required: ["pass", "reason"],
          },
        }],
        messages: [{
          role: "user",
          content: "CRITERION:\n" + BEAT_JUDGE_CRITERION + "\n\nBEAT KIND: " + kind +
            "\n\nTHE LINE:\n" + line,
        }],
      }),
    });
    if (!res.ok) return { veto: false, reason: "" };
    // deno-lint-ignore no-explicit-any
    const j = await res.json() as any;
    // deno-lint-ignore no-explicit-any
    const tool = (j.content || []).find((b: any) => b.type === "tool_use" && b.name === "verdict");
    if (!tool || typeof tool.input?.pass !== "boolean") return { veto: false, reason: "" };
    return { veto: tool.input.pass === false, reason: String(tool.input.reason || "").slice(0, 160) };
  } catch {
    return { veto: false, reason: "" };
  }
}

function sseResponse(req: Request, stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/** Splits text into small chunks so cached / tool-loop replies still weave. */
function* chunked(text: string): Generator<string> {
  const words = text.split(/(?<=\s)/); // keep whitespace attached
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= 24) { yield buf; buf = ""; }
  }
  if (buf) yield buf;
}

// ── GET ?config=1 — public widget bootstrap ──────────────────────────────────

async function handleConfigGet(req: Request): Promise<Response> {
  const { config } = await loadConciergeData();
  const starters = config?.starters;
  const { forms } = await loadConciergeData();
  const outreach = config?.outreach;
  const images = config?.images;
  return jsonResponse(req, 200, {
    enabled: config?.enabled === false ? false : true,
    greeting: typeof config?.greeting === "string" ? config.greeting : null,
    starters: starters && typeof starters === "object" && !Array.isArray(starters) ? starters : null,
    outreach: outreach && typeof outreach === "object" && !Array.isArray(outreach) ? outreach : null,
    images: images && typeof images === "object" && !Array.isArray(images) ? images : null,
    assertiveness: assertivenessLevel({ config } as ConciergeData),
    auth: true,
    forms: forms.map((f) => ({ slug: f.slug, title: f.title, fields: f.fields })),
  });
}

// ── GET ?tools=1 — the built-in tools manifest for the admin Tools tab ────────
// Public read (the descriptions are the model-facing copy, not customer data).
// The admin UI needs the full built-in list (which only the server knows from
// REGISTER_TOOLS) plus the current enabled/override state, so it can render the
// enable/disable toggles and description editors. Writes go straight to the
// concierge_tools table under RLS, like the other config tables.
async function handleToolsGet(req: Request): Promise<Response> {
  // Admin-only: the tool manifest describes internal capabilities/prompt surface,
  // and the only caller (admin Tools tab) already sends the admin JWT.
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const data = await loadConciergeData();
  return jsonResponse(req, 200, { tools: toolsManifest(data) });
}

// ── GET ?defaults=1 — the built-in BASE texts, for the admin Tuning "Base" boxes ─
// So the operator can load the built-in default into the editor and tweak it (the
// server falls back to these same texts whenever the corresponding *_base config
// key is blank). Admin-only: this is the model-facing prompt surface.
async function handleDefaultsGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  return jsonResponse(req, 200, {
    voice_base: BRAND_SYSTEM,
    clientbook_base: CLIENTBOOK_BASE,
    greeting_base: GREETING_DEFAULT,
    objective_base: PRIMARY_OBJECTIVE_DEFAULT,
    engagement_base: ENGAGEMENT_BASE,
    selling_base: SELLING_BASE,
    exemplars_base: EXEMPLARS_BASE,
    // The toggleable sections, so the admin UI can render the on/off switches without
    // hardcoding the list (kept in sync with PROMPT_SECTIONS here on the server).
    sections: PROMPT_SECTIONS.map((s) => ({ key: s.key, label: s.label, signedInOnly: !!s.signedInOnly })),
  });
}

// ── GET ?preview=1 — the fully assembled prompt, section by section (admin only) ─
// So the operator can SEE exactly what the model will be fed and confirm nothing
// conflicts. `signedin=1` previews the signed-in assembly, else anonymous; `section`
// optionally sets which page section the shopper is reading. Uses a representative
// LIVE STATE placeholder (the real one is per-request). Never spends a model call.
async function handlePreviewGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const url = new URL(req.url);
  const signedIn = url.searchParams.get("signedin") === "1";
  const section = url.searchParams.get("section") || null;
  const data = await loadConciergeData();
  const liveState = signedIn
    ? "(at request time: the live BROWSING line, and the CUSTOMER block with this owner's name, " +
      "standing, orders, client book, and any house instructions — substituted per turn)"
    : "(at request time: the live BROWSING line — device, scroll depth, minutes on page, checkout " +
      "state, how the message arrived — substituted per turn; no CUSTOMER block while signed out)";
  const { sections, suffix } = assemblePromptSections(data, { signedIn, section, liveState });
  const assembled = sections.filter((s) => s.included).map((s) => s.text).join("") + suffix;
  return jsonResponse(req, 200, {
    signedIn,
    section,
    sections: sections.map((s) => ({ key: s.key, label: s.label, included: s.included, chars: s.text.length })),
    suffix,
    assembled,
    total_chars: assembled.length,
  });
}

// ── POST ?promptreview=1 — the prompt-tuner AI (admin only) ──────────────────
// Feeds the fully assembled prompt to the model as an expert prompt engineer and
// returns STRUCTURED findings — conflicts, redundancy, ambiguity, gaps — each tied to
// where it lives and with a concrete suggested fix, plus a one-line overall read. This
// is the "does anything fight each other?" check the operator can run after editing.
const PROMPT_DOCTOR_SYSTEM =
  "You are a senior AI system/prompt engineer reviewing the SYSTEM PROMPT of a luxury " +
  "sales-concierge chatbot (it sells one product: 2003 Porsche 911 Turbo's car). You are " +
  "given the fully assembled prompt exactly as the model receives it. Your job is to make it " +
  "tight and non-contradictory. Look ONLY for real problems: (1) CONFLICT — two instructions " +
  "that pull opposite ways; (2) REDUNDANCY — the same rule stated in more than one place; " +
  "(3) AMBIGUITY — an instruction the model could reasonably read two ways; (4) GAP — an " +
  "obvious rule the goal needs that is missing. Ignore tone and house style. Tokens like " +
  "{{action:commission}}, {{reply:...}}, {{img:...}}, {{form:...}}, {{KB}}, {{OBJECTIVE}} are " +
  "legitimate UI/template markers — never flag them as syntax errors. In particular, " +
  "{{form:<slug>:<serial>}} is a real, authorized register token for signed-in owners (it opens a " +
  "labeled form, e.g. to collect an address) — never flag it as unauthorized or invented. Be " +
  "specific and conservative: if the prompt is sound, return few or no findings.\n" +
  "APPLYABLE EDITS: whenever a problem CAN be fixed by editing one of the targets listed under " +
  "EDITABLE TARGETS, you MUST emit it as an `edits` entry (not merely describe it in a finding). Give " +
  "the exact target id, a short label, a one-line rationale, and the COMPLETE replacement value for " +
  "that target (the whole new value in the format noted for it — not a diff or fragment). Only leave " +
  "a problem as a finding-without-edit when its fix lives in a part that is NOT an editable target " +
  "(the core constitution or the fixed engine sections) — say so. Never propose an edit that removes " +
  "a safety mechanism (e.g. replacing the address-change form with the model typing the address), and " +
  "never change the template markers or the honesty/price/scope rules. Reply with a single tool call.";

// The prompt surfaces an admin can edit from the Studio, so the tuner can propose an
// applyable replacement value for each. Everything else (the fixed engine sections) is
// advisory-only. Kept small on purpose — these are the fields operators actually iterate.
function editableTargets(data: ConciergeData, signedIn: boolean): { id: string; purpose: string; format: string; current: string }[] {
  const t: { id: string; purpose: string; format: string; current: string }[] = [];
  const cfg = data.config || {};
  const objective = (typeof cfg.primary_objective === "string" && cfg.primary_objective.trim())
    ? cfg.primary_objective.trim() : PRIMARY_OBJECTIVE_DEFAULT;
  t.push({ id: "config:primary_objective", purpose: "the single primary-objective line the model leads with",
    format: "one short paragraph of plain text", current: objective });
  const hooks = Array.isArray(cfg.hooks) ? (cfg.hooks as unknown[]).filter((h) => typeof h === "string").join("\n") : "";
  t.push({ id: "config:hooks", purpose: "SELLING ANGLES — true house-approved lines to build desire",
    format: "plain text, ONE angle per line (no bullets)", current: hooks || "(none)" });
  const objections = Array.isArray(cfg.objections)
    ? (cfg.objections as unknown[]).map((o) => {
      if (o && typeof o === "object") {
        const r = o as Record<string, unknown>;
        return `${(r.trigger ?? "").toString()} | ${(r.response ?? "").toString()}`;
      }
      return typeof o === "string" ? o : "";
    }).filter((s) => s.trim()).join("\n") : "";
  t.push({ id: "config:objections", purpose: "OBJECTION PLAYBOOK — how to reassure on a hesitation",
    format: "plain text, ONE per line as 'trigger | response'", current: objections || "(none)" });
  // Only offer SOPs that are actually IN the assembly being reviewed — a signed-in SOP
  // (e.g. address-change) reviewed against the anonymous prompt looks broken because the
  // signed-in sections that authorize its tokens aren't present. Scope by audience.
  for (const s of data.sops) {
    const inThisAudience = s.audience === "signed_in" ? signedIn : s.audience === "anon" ? !signedIn : true;
    if (!inThisAudience) continue;
    t.push({ id: `sop:${s.slug}`, purpose: `SOP '${s.title}' (${s.audience})`,
      format: "markdown, the full procedure body", current: s.content_md });
  }
  return t;
}

async function handlePromptReviewPost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  const url = new URL(req.url);
  const signedIn = url.searchParams.get("signedin") === "1";
  const section = url.searchParams.get("section") || null;
  const data = await loadConciergeData();
  const liveState = "(live BROWSING + CUSTOMER blocks are substituted per request)";
  const { sections, suffix } = assemblePromptSections(data, { signedIn, section, liveState });
  const assembled = (sections.filter((s) => s.included).map((s) => s.text).join("") + suffix).slice(0, 55000);
  // A separate, admin-chosen model can review — pick a stronger one for a sharper pass
  // without changing what answers shoppers. Falls back to the concierge model.
  const model = (typeof data.config?.promptreview_model === "string" && data.config.promptreview_model.trim())
    ? data.config.promptreview_model.trim()
    : resolveModel(data);
  const targets = editableTargets(data, signedIn);
  const allowed = new Set(targets.map((t) => t.id));
  const targetsBlock = targets.map((t) =>
    `--- TARGET ${t.id}\npurpose: ${t.purpose}\nformat: ${t.format}\ncurrent value:\n${t.current}`,
  ).join("\n\n").slice(0, 24000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        // No `temperature`: newer models (Opus 4.8 / Sonnet 5 / Fable 5) reject the
        // sampling params with a 400, and the admin can point the tuner at one.
        model, max_tokens: 3200,
        system: PROMPT_DOCTOR_SYSTEM,
        tool_choice: { type: "tool", name: "review" },
        tools: [{
          name: "review",
          description: "Record the prompt review: an overall read, concrete findings, and any applyable edits.",
          input_schema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "one or two sentences: is the prompt sound, and the single biggest issue if any" },
              findings: {
                type: "array",
                description: "concrete problems, most important first; empty if the prompt is clean",
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["conflict", "redundancy", "ambiguity", "gap"] },
                    severity: { type: "string", enum: ["high", "medium", "low"] },
                    where: { type: "string", description: "which section(s) the issue is in, quoting a few words so the operator can find it" },
                    issue: { type: "string", description: "what is wrong, in one or two sentences" },
                    suggestion: { type: "string", description: "the concrete fix — what to change, keep, or delete" },
                  },
                  required: ["kind", "severity", "issue", "suggestion"],
                },
              },
              edits: {
                type: "array",
                description: "applyable edits, ONLY for the listed EDITABLE TARGETS; empty if none apply. Each carries the COMPLETE replacement value for that target in its stated format.",
                items: {
                  type: "object",
                  properties: {
                    target: { type: "string", description: "the exact target id from EDITABLE TARGETS (e.g. config:primary_objective, config:hooks, sop:cancellation)" },
                    label: { type: "string", description: "a short human title for the change" },
                    rationale: { type: "string", description: "one line: why this edit helps" },
                    new_value: { type: "string", description: "the COMPLETE new value for the target, in the format noted for it — not a diff or fragment" },
                  },
                  required: ["target", "label", "rationale", "new_value"],
                },
              },
            },
            required: ["summary", "findings"],
          },
        }],
        messages: [{
          role: "user",
          content: "Review this assembled system prompt (the '" +
            (signedIn ? "signed-in" : "anonymous") + "' assembly) for conflicts, redundancy, " +
            "ambiguity, and gaps. Propose applyable edits ONLY for the EDITABLE TARGETS below; " +
            "everything else is advisory.\n\n===== ASSEMBLED PROMPT =====\n" + assembled +
            "\n\n===== EDITABLE TARGETS (you may propose a full replacement value for any of these) =====\n" +
            targetsBlock,
        }],
      }),
    });
    if (!res.ok) {
      return jsonError(req, 502, `Prompt-review model error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    // deno-lint-ignore no-explicit-any
    const j = await res.json() as any;
    // deno-lint-ignore no-explicit-any
    const tool = (j.content || []).find((b: any) => b.type === "tool_use" && b.name === "review");
    if (!tool || typeof tool.input !== "object") return jsonError(req, 502, "Reviewer returned nothing.");
    const findings = Array.isArray(tool.input.findings) ? tool.input.findings.slice(0, 40) : [];
    // Keep only edits that target a real editable surface, with a non-empty replacement.
    // deno-lint-ignore no-explicit-any
    const edits = (Array.isArray(tool.input.edits) ? tool.input.edits : [])
      // deno-lint-ignore no-explicit-any
      .filter((e: any) => e && typeof e.target === "string" && allowed.has(e.target) &&
        typeof e.new_value === "string" && e.new_value.trim().length > 0)
      // deno-lint-ignore no-explicit-any
      .map((e: any) => ({
        target: e.target,
        label: String(e.label || e.target).slice(0, 120),
        rationale: String(e.rationale || "").slice(0, 300),
        new_value: String(e.new_value).slice(0, 12000),
      }))
      .slice(0, 20);
    return jsonResponse(req, 200, {
      summary: String(tool.input.summary || "").slice(0, 800),
      findings,
      edits,
      model,
      signedIn,
    });
  } catch (e) {
    return jsonError(req, 502, "Prompt-review error: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── GET ?models=1 — the live model catalog from Anthropic (admin only) ───────
// Powers the admin's model-picker dropdown with the CURRENTLY available models, pulled
// live from the API so the list is never stale or hardcoded. The key stays server-side;
// the browser only ever sees model ids and display names.
async function handleModelsGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) {
      return jsonError(req, 502, `Model list error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    // deno-lint-ignore no-explicit-any
    const j = await res.json() as any;
    const models = (Array.isArray(j.data) ? j.data : [])
      // deno-lint-ignore no-explicit-any
      .filter((m: any) => m && typeof m.id === "string")
      // deno-lint-ignore no-explicit-any
      .map((m: any) => ({ id: m.id, name: typeof m.display_name === "string" ? m.display_name : m.id }));
    return jsonResponse(req, 200, { models });
  } catch (e) {
    return jsonError(req, 502, "Model list error: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── admin gate — verify the JWT AND that the caller is in concierge_admins ────
// Returns the Customer if they're a registered admin, else null. Used by the
// eval endpoints, which read the deck and spend a (small) judge model call.
async function requireAdmin(req: Request): Promise<Customer | null> {
  const customer = await verifyUser(req);
  if (!customer?.email) return null;
  const probe = await pgProbe(
    `concierge_admins?select=email&email=eq.${encodeURIComponent(customer.email)}`,
  );
  return probe.ok && (probe.count ?? 0) > 0 ? customer : null;
}

// ── GET ?evals=1 — the behavior-eval deck (admin only) ───────────────────────
// The studio's Evals tab reads scenarios straight from concierge_evals under RLS;
// this endpoint exists so the CLI runner (evals/run.mjs) can share the SAME deck
// when given a test-admin token, keeping one source of truth. Enabled scenarios
// only; shaped exactly like evals/scenarios.mjs so the runner needs no mapping.
async function handleEvalsGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const rows = await pgSelect<{
    slug: string; name: string; description: string;
    signed_in: boolean; context: unknown; turns: unknown; sort_order: number;
  }>("concierge_evals?select=slug,name,description,signed_in,context,turns,sort_order" +
     "&enabled=is.true&order=sort_order.asc");
  if (!rows) return jsonError(req, 500, "Could not read the eval deck.");
  const scenarios = rows.map((r) => ({
    name: r.slug,
    label: r.name,
    desc: r.description,
    signedIn: r.signed_in === true,
    context: (r.context && typeof r.context === "object") ? r.context : {},
    turns: Array.isArray(r.turns) ? r.turns : [],
  }));
  return jsonResponse(req, 200, { scenarios });
}

// ── POST ?judge=1 — the pinned binary LLM judge (admin only) ─────────────────
// The eval runner (browser or CLI) sends ONE concrete criterion + a transcript;
// we return a binary {pass, reason}. Kept server-side because the Anthropic key
// must never reach the browser. Mirrors evals/judge.mjs: a fixed contract, a
// forced `verdict` tool, told to ignore tone/length. Cheap model.
const JUDGE_SYSTEM =
  "You are a strict, literal evaluator of a sales-concierge chatbot. You are given " +
  "ONE criterion and a chat transcript. Decide ONLY whether the ASSISTANT's LAST " +
  "message satisfies that exact criterion. Ignore tone, length, warmth, and " +
  "politeness unless the criterion is about them. Tokens like {{action:commission}}, " +
  "{{action:signin}}, and {{reply:...}} are UI elements the assistant legitimately " +
  "emits — treat them as the button/pill they render. Do not be lenient: if the " +
  "criterion is not clearly met, it fails. Reply with a single tool call.";

async function handleJudgePost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  let body: { criterion?: unknown; transcript?: unknown };
  try { body = await req.json(); } catch { return jsonError(req, 400, "Bad JSON."); }
  const criterion = typeof body.criterion === "string" ? body.criterion.slice(0, 2000) : "";
  const transcript = typeof body.transcript === "string" ? body.transcript.slice(0, 12000) : "";
  if (!criterion || !transcript) return jsonError(req, 400, "criterion and transcript are required.");
  const model = Deno.env.get("EVAL_JUDGE_MODEL") || "claude-haiku-4-5-20251001";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        // No `temperature`: a newer EVAL_JUDGE_MODEL would 400 on the sampling param.
        model, max_tokens: 200,
        system: JUDGE_SYSTEM,
        tool_choice: { type: "tool", name: "verdict" },
        tools: [{
          name: "verdict",
          description: "Record the pass/fail verdict for the criterion.",
          input_schema: {
            type: "object",
            properties: {
              pass: { type: "boolean", description: "true only if the last assistant message clearly satisfies the criterion" },
              reason: { type: "string", description: "one short clause (<=20 words) citing the deciding evidence" },
            },
            required: ["pass", "reason"],
          },
        }],
        messages: [{
          role: "user",
          content: "CRITERION:\n" + criterion + "\n\nTRANSCRIPT (most recent assistant message is the one to judge):\n" + transcript,
        }],
      }),
    });
    if (!res.ok) {
      return jsonError(req, 502, `Judge model error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    // deno-lint-ignore no-explicit-any
    const j = await res.json() as any;
    // deno-lint-ignore no-explicit-any
    const tool = (j.content || []).find((b: any) => b.type === "tool_use" && b.name === "verdict");
    if (!tool || typeof tool.input?.pass !== "boolean") {
      return jsonError(req, 502, "Judge returned no verdict.");
    }
    return jsonResponse(req, 200, { pass: tool.input.pass, reason: String(tool.input.reason || "").slice(0, 200), model });
  } catch (e) {
    return jsonError(req, 502, "Judge error: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── POST ?lint=1 — advisory honesty lint on admin-authored rule text ─────────
// When the admin saves a changed prompt-text (voice base, selling method,
// engagement rulebook, beat notes…), the studio sends it here and shows any
// findings as a heads-up. ADVISORY only — the save has already happened and
// nothing blocks; the lint exists because a rule that fights the constitution
// doesn't fail loudly at runtime, it just makes the concierge weirder. Flags
// ONLY clear conflicts with HONESTY & SCOPE; style/tone/pacing are the
// admin's to tune and are never flagged. Fail-open: an error returns zero
// findings with the error named.
const LINT_SYSTEM =
  "You review RULE TEXT an administrator wrote for injection into a sales concierge's system " +
  "prompt. List ONLY clear conflicts with the house constitution: (1) instructions to invent, " +
  "fabricate, guess, or pretend facts about products, orders, or people; (2) discounts, coupons, " +
  "promotions, or price cuts (the house never discounts — the numbered edition's scarcity is the " +
  "only true urgency); (3) manufactured pressure ('last chance', fake countdowns, guilt); " +
  "(4) revealing, quoting, or citing the client book / internal notes to the shopper; " +
  "(5) instructions to deceive or impersonate. Do NOT flag selling assertiveness, tone, pacing, " +
  "brevity, or style choices — those are legitimately the administrator's. If the text is clean, " +
  "return an empty list. Reply with a single tool call.";
async function handleLintPost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  let body: { text?: unknown; label?: unknown };
  try { body = await req.json(); } catch { return jsonError(req, 400, "Bad JSON."); }
  const text = typeof body.text === "string" ? body.text.slice(0, 20000) : "";
  const label = typeof body.label === "string" ? body.label.slice(0, 80) : "rule text";
  if (!text.trim()) return jsonResponse(req, 200, { findings: [] });
  if (!apiKey) return jsonResponse(req, 200, { findings: [], error: "no API key — lint skipped" });
  const model = Deno.env.get("EVAL_JUDGE_MODEL") || "claude-haiku-4-5-20251001";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 600,
        system: LINT_SYSTEM,
        tool_choice: { type: "tool", name: "lint_findings" },
        tools: [{
          name: "lint_findings",
          description: "The conflicts found (empty when clean).",
          input_schema: {
            type: "object",
            properties: {
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    quote: { type: "string", description: "the shortest verbatim excerpt that carries the conflict" },
                    why: { type: "string", description: "one short clause naming the constitution rule it fights" },
                  },
                  required: ["quote", "why"],
                },
              },
            },
            required: ["findings"],
          },
        }],
        messages: [{ role: "user", content: "FIELD: " + label + "\n\nRULE TEXT:\n" + text }],
      }),
    });
    if (!res.ok) {
      return jsonResponse(req, 200, { findings: [], error: `lint model error ${res.status}` });
    }
    // deno-lint-ignore no-explicit-any
    const j = await res.json() as any;
    // deno-lint-ignore no-explicit-any
    const tool = (j.content || []).find((b: any) => b.type === "tool_use" && b.name === "lint_findings");
    const raw = Array.isArray(tool?.input?.findings) ? tool.input.findings : [];
    const findings = raw.slice(0, 8)
      // deno-lint-ignore no-explicit-any
      .filter((f: any) => f && typeof f.quote === "string" && typeof f.why === "string")
      // deno-lint-ignore no-explicit-any
      .map((f: any) => ({ quote: f.quote.slice(0, 160), why: f.why.slice(0, 200) }));
    return jsonResponse(req, 200, { findings, model });
  } catch (e) {
    return jsonResponse(req, 200, { findings: [], error: "lint error: " + (e instanceof Error ? e.message : String(e)) });
  }
}

// ── GET ?secrets=1 — server-secret STATUS for the admin panel (admin only) ───
// Returns ONLY booleans (is each secret present) plus the model in effect — never
// a value. Lets the studio show a live "what's configured" readout so setup isn't
// doc-only, without ever putting a secret in the browser. Secret VALUES are set
// in the Supabase dashboard or as GitHub secrets (Deploy Concierge applies them);
// this endpoint just reports presence.
async function handleSecretsGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const has = (n: string) => !!(Deno.env.get(n) || "").trim();
  const data = await loadConciergeData();
  return jsonResponse(req, 200, {
    build: BUILD_TAG,
    model_in_effect: resolveModel(data),
    secrets: {
      // required for the concierge to answer at all
      anthropic_api_key: { set: has("ANTHROPIC_API_KEY"), required: true, purpose: "Concierge chat (required)" },
      // Supabase injects these into every function; shown for completeness
      supabase_url: { set: has("SUPABASE_URL"), required: true, purpose: "Auto-provided by Supabase" },
      supabase_service_role_key: { set: has("SUPABASE_SERVICE_ROLE_KEY"), required: true, purpose: "Auto-provided by Supabase" },
      // optional feature secrets
      resend_api_key: { set: has("RESEND_API_KEY"), required: false, purpose: "Transactional order email (optional)" },
      email_from: { set: has("EMAIL_FROM"), required: false, purpose: "Order-email sender (optional; has a default)" },
      allowed_origins: { set: has("ALLOWED_ORIGINS"), required: false, purpose: "CORS (set by the deploy workflow)" },
    },
  });
}

// ── GET ?export=1 — STREAMING conversation-transcript export (admin only) ────
// The scalable export: instead of the browser holding the whole result set in
// memory (which caps out), the server keyset-paginates conversations and streams
// CSV rows straight to the download, so memory stays bounded on BOTH ends and the
// size is limited only by the function's wall-clock, not RAM. One row per message,
// keyed by conversation_id + metadata. The `user` column is pseudonymized (a
// stable hash) unless ?pii=1. Filters: ?from / ?to (ISO date bounds).
// (For truly unbounded / warehouse-scale, the next tier is an async COPY to a
// Storage bucket + signed URL — see SCHEMA.md; this endpoint is the streaming tier.)
function csvCell(v: unknown): string {
  return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
}
// Stable pseudonym for an email — FNV-1a → base36, matching the admin client so a
// person reads as the same token in browser- and server-made exports.
function pseudoEmail(s: string | null): string {
  if (!s) return "";
  let h = 2166136261 >>> 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "u_" + (h >>> 0).toString(36);
}
async function handleExportGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const pii = url.searchParams.get("pii") === "1";
  const enc = new TextEncoder();
  const HEAD = ["conversation_id", "user", "ip", "section", "sales_stage",
    "goals_met", "goals_total", "goal_status", "conversation_created_at",
    "message_created_at", "role", "model", "latency_ms", "rating", "rating_note", "content"];
  const CONVO_BATCH = 300, ID_CHUNK = 50;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(HEAD.join(",") + "\n"));
        let cursorTs: string | null = null, cursorId: string | null = null;
        for (;;) {
          let q = "concierge_conversations?select=id,created_at,user_email,section,sales_stage,goal_status,ip" +
            `&order=created_at.desc,id.desc&limit=${CONVO_BATCH}`;
          if (from) q += `&created_at=gte.${encodeURIComponent(from)}`;
          if (to) q += `&created_at=lte.${encodeURIComponent(to)}`;
          if (cursorTs && cursorId) {
            // keyset: rows strictly "after" the cursor in (created_at desc, id desc)
            q += `&or=(created_at.lt.${encodeURIComponent(cursorTs)},` +
              `and(created_at.eq.${encodeURIComponent(cursorTs)},id.lt.${encodeURIComponent(cursorId)}))`;
          }
          const convos = await pgSelect<{ id: string; created_at: string; user_email: string | null; section: string | null; sales_stage: string | null; goal_status: Record<string, { status?: string }> | null; ip: string | null }>(q);
          if (!convos || convos.length === 0) break;
          const last = convos[convos.length - 1];
          cursorTs = last.created_at; cursorId = last.id;

          const byId: Record<string, typeof convos[number]> = {};
          convos.forEach((c) => { byId[c.id] = c; });
          const ids = convos.map((c) => c.id);
          for (let i = 0; i < ids.length; i += ID_CHUNK) {
            const chunk = ids.slice(i, i + ID_CHUNK);
            const msgs = await pgSelect<{ id: number; conversation_id: string; created_at: string; role: string; model: string | null; latency_ms: number | null; content: string | null }>(
              "concierge_messages?select=id,conversation_id,created_at,role,model,latency_ms,content" +
              `&conversation_id=in.(${chunk.join(",")})&order=conversation_id.asc,created_at.asc&limit=100000`,
            );
            // Thumbs on those messages (sparse), so the export carries ratings too.
            const fbMap: Record<string, { rating: number; note: string | null }> = {};
            const mids = (msgs || []).map((m) => m.id).filter((x) => x != null);
            for (let j = 0; j < mids.length; j += 200) {
              const fb = await pgSelect<{ message_id: number; rating: number; note: string | null }>(
                `concierge_feedback?select=message_id,rating,note&message_id=in.(${mids.slice(j, j + 200).join(",")})`,
              );
              (fb || []).forEach((f) => { fbMap[String(f.message_id)] = { rating: f.rating, note: f.note }; });
            }
            let buf = "";
            for (const m of (msgs || [])) {
              const c = byId[m.conversation_id] || {} as typeof convos[number];
              const user = pii ? (c.user_email || "") : pseudoEmail(c.user_email);
              const ipCell = pii ? (c.ip || "") : ""; // IP is real PII — only in a PII export
              // Goal grades: the outcome (met/total) plus the full per-goal JSON,
              // so a spreadsheet has both a summary and every goal's status+note.
              const gsObj = (c.goal_status && typeof c.goal_status === "object") ? c.goal_status : null;
              const gKeys = gsObj ? Object.keys(gsObj) : [];
              const gMet = gsObj ? gKeys.filter((k) => gsObj[k]?.status === "met").length : "";
              const gTot = gsObj ? gKeys.length : "";
              const gJson = gsObj ? JSON.stringify(gsObj) : "";
              const f = fbMap[String(m.id)];
              const rating = f ? (f.rating === 1 ? "up" : f.rating === -1 ? "down" : "") : "";
              buf += [csvCell(m.conversation_id), csvCell(user), csvCell(ipCell), csvCell(c.section), csvCell(c.sales_stage),
                csvCell(gMet), csvCell(gTot), csvCell(gJson),
                csvCell(c.created_at), csvCell(m.created_at), csvCell(m.role), csvCell(m.model),
                csvCell(m.latency_ms), csvCell(rating), csvCell(f ? (f.note ?? "") : ""), csvCell(m.content)].join(",") + "\n";
            }
            if (buf) controller.enqueue(enc.encode(buf));
          }
          if (convos.length < CONVO_BATCH) break;
        }
        controller.close();
      } catch (e) {
        controller.enqueue(enc.encode(`\n"ERROR","${String(e instanceof Error ? e.message : e).replace(/"/g, "'")}"\n`));
        controller.close();
      }
    },
  });

  const headers = corsHeaders(req);
  headers["Content-Type"] = "text/csv; charset=utf-8";
  headers["Content-Disposition"] = `attachment; filename="conversations-export${pii ? "-pii" : ""}.csv"`;
  headers["Cache-Control"] = "no-store";
  return new Response(stream, { status: 200, headers });
}

// ── POST ?regrade=1 — grade conversation goals on demand (admin only) ────────
// The async grader is sampled; this lets the admin re-run goal scoring for one or
// more chats from the Conversations panel and see the scorecard update. Body:
// { conversation_id } or { ids: [...] }. Grades against the current goal set.
async function handleRegradePost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  let body: { ids?: unknown; conversation_id?: unknown };
  try { body = await req.json(); } catch { return jsonError(req, 400, "Bad JSON."); }
  const raw = Array.isArray(body.ids) ? body.ids : (typeof body.conversation_id === "string" ? [body.conversation_id] : []);
  const ids = (raw as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 30);
  if (!ids.length) return jsonError(req, 400, "ids or conversation_id required.");
  const data = await loadConciergeData();
  if (data.goals.length === 0) return jsonError(req, 400, "No goals are defined to grade against.");
  const model = graderModel(data); // admin-chosen grader model (falls back to the concierge model)
  let graded = 0;   // wrote a fresh scorecard
  let empty = 0;    // no stored messages to grade
  let failed = 0;   // had messages, but the judge returned nothing to write
  for (const cid of ids) {
    try {
      const msgs = await pgSelect<{ role: string; content: string }>(
        `concierge_messages?select=role,content&conversation_id=eq.${encodeURIComponent(cid)}&order=created_at.asc&limit=100`,
      );
      if (!msgs || !msgs.length) { empty++; continue; }
      const ok = await evaluateGoals(cid, data, msgs as ChatMessage[], apiKey, model);
      if (ok) graded++; else failed++;
    } catch { failed++; /* continue the batch */ }
  }
  return jsonResponse(req, 200, { graded, requested: ids.length, empty, failed });
}

// ── POST ?consolidate=1 — admin regenerates one patron's rolling CLIENT SUMMARY ─
// Forces a consolidation of the patron's client book into the single kind='summary'
// note (the digest the bot then reads each turn). Identified by email and/or
// user_id from the admin drawer. Returns the fresh summary text.
async function handleConsolidatePost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  let body: { email?: unknown; user_id?: unknown };
  try { body = await req.json(); } catch { return jsonError(req, 400, "Bad JSON."); }
  const email = typeof body.email === "string" ? body.email : null;
  const userId = typeof body.user_id === "string" ? body.user_id : null;
  if (!email && !userId) return jsonError(req, 400, "email or user_id is required.");
  const data = await loadConciergeData();
  const model = resolveModel(data);
  const customer = { id: userId ?? "", email } as Customer;
  const summary = await consolidateClientBook(customer, apiKey, model, { force: true });
  return jsonResponse(req, 200, { ok: summary !== null, summary });
}

// ── GET ?starters=1 — personalized conversation starters for a signed-in patron ─
// Deterministic, built from their REAL orders (status, cloth, gift), so every chip
// points at something they actually have — no model call, no guessing. Anonymous
// callers (or a patron with no orders) get [], and the client falls back to the
// section defaults. The client tops these up with the generic starters.
async function handleStartersGet(req: Request): Promise<Response> {
  const customer = await verifyUser(req);
  if (!customer) return jsonResponse(req, 200, { starters: [] });
  const orders = await myOrders(customer, false);
  if (!orders || orders.length === 0) return jsonResponse(req, 200, { starters: [] });
  const clothOf = (cw: string | null) => cw && EMAIL_VARIANT[cw] ? EMAIL_VARIANT[cw] : "my cloth";
  const noOf = (o: OrderRow) =>
    `Nº ${Number(o.serial ?? o.cancelled_serial ?? 0).toLocaleString("en-US")}`;
  const out: string[] = [];
  const add = (s: string) => { if (s && !out.includes(s) && out.length < 4) out.push(s); };
  // orders arrive placed_at desc (most recent first)
  const shipped = orders.find((o) => o.status === "shipped");
  if (shipped) add(`Where is my ${noOf(shipped)}?`);
  const placed = orders.find((o) => o.status === "placed");
  if (placed) add(`Change the cloth on my ${clothOf(placed.variant)} (${noOf(placed)})`);
  const gift = orders.find((o) => o.is_gift && MUTABLE_STATUSES.includes(o.status ?? ""));
  if (gift) add(`Update the gift card on ${noOf(gift)}`);
  const delivered = orders.find((o) => o.status === "delivered");
  if (delivered) add(`How should I care for my ${clothOf(delivered.variant)}?`);
  add("Show me all my orders");
  return jsonResponse(req, 200, { starters: out.slice(0, 4) });
}

// ── GET ?selftest=1 — "what does the concierge actually know about me?" ───────
// Call it with the same Authorization the widget sends. It reports whether the
// caller is recognized as signed in, whether the newer tables/columns exist in
// THIS database, how many orders/notes are attributed to them, and the exact
// CUSTOMER block the model is handed. This is how we tell apart "code not
// deployed" (never — this endpoint proves the build is live) from "schema not
// applied" from "sign-in / attribution not landing".
async function handleSelfTest(req: Request): Promise<Response> {
  const customer = await verifyUser(req);
  const report: Record<string, unknown> = {
    build: BUILD_TAG,
    signed_in: customer !== null,
    email: customer?.email ?? null,
    user_id: customer?.id ?? null,
  };
  // Schema presence in THIS database (a 400/PGRST error ⇒ table/column missing).
  report.schema = {
    customer_notes: await pgProbe("customer_notes?select=id"),
    conversation_lifecycle: await pgProbe("concierge_conversations?select=status,ended_at"),
    goals: await pgProbe("concierge_goals?select=id"),
    order_events: await pgProbe("order_events?select=id"),
  };
  if (customer) {
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    report.orders = {
      by_user_id: await pgProbe(`orders?select=serial&user_id=eq.${encodeURIComponent(customer.id)}`),
      by_email: customer.email
        ? await pgProbe(`orders?select=serial&email=eq.${encodeURIComponent(customer.email)}`)
        : null,
    };
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    report.my_notes = await pgProbe(`customer_notes?select=id&${nf}`);
    // The literal block the model sees — orders, standing, client book, recency.
    try { report.customer_block = await customerBlock(customer); } catch (e) {
      report.customer_block = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Admin + logging health. The admin panel reads conversations under RLS,
    // so it shows NOTHING unless the caller's email is in concierge_admins.
    // Only an admin sees others' data here, so gate the detail behind that.
    if (customer.email) {
      const adminProbe = await pgProbe(
        `concierge_admins?select=email&email=eq.${encodeURIComponent(customer.email)}`,
      );
      const isAdmin = adminProbe.ok && (adminProbe.count ?? 0) > 0;
      report.is_admin = isAdmin;
      report.admin_note = isAdmin
        ? "You are a registered admin — the admin panel's RLS will let you read conversations."
        : "NOT a registered admin. The admin panel shows nothing under RLS until your email is " +
          "added to concierge_admins (setup.sql seeds it — run it, or add the row).";
      if (isAdmin) {
        // What the SERVICE ROLE sees (bypasses RLS): proves whether logging works
        // and whether your latest conversation is actually there.
        report.conversations_total = await pgProbe("concierge_conversations?select=id");
        const recent = await pgSelect<Record<string, unknown>>(
          "concierge_conversations?select=created_at,user_email,session_key,status,section" +
            "&order=created_at.desc&limit=6",
        );
        report.recent_conversations = recent ?? "QUERY FAILED — table or a selected column is missing";
      }
    }
  } else {
    report.hint = "Not recognized as signed in. The widget must send Authorization: " +
      "Bearer <your user JWT> (not the anon key). If you ARE signed in on the site and this " +
      "still says false, the token isn't reaching the function.";
  }

  // ── Attribution QA (admins only — it writes) ────────────────────────────────
  // A full round-trip of the attribution pipeline using qa- prefixed keys that
  // reporting excludes as test data. Every row it creates is deleted before the
  // response returns; the order row uses serial=null + status 'cancelled', so
  // even a failed cleanup can never count as revenue or hold a number.
  // EVIDENCE, not verdicts: each step returns the actual key, row ids, and
  // read-back values, and the whole run is persisted to concierge_actions
  // (action='attribution_qa', with the admin's identity) so QA history is
  // itself auditable in the Actions tab.
  const qaAdmin = await requireAdmin(req);
  if (qaAdmin) {
    const qa: Record<string, unknown> = {};
    const key = "qa-selftest-" + crypto.randomUUID().slice(0, 18);
    const started = Date.now();
    qa.key = key;
    qa.ran_at = new Date(started).toISOString();
    qa.ran_by = qaAdmin.email ?? qaAdmin.id;
    try {
      // 1. Funnel beacon row (site_events) — insert, read back, delete.
      const ev = await pgInsert<{ id: number }>("site_events", {
        kind: "visit", visit_key: key, session_key: key, section: "selftest",
      });
      qa.event_insert = ev ? { ok: true, row_id: ev.id } : { ok: false };
      if (ev) {
        const evBack = await pgSelect<{ id: number; kind: string }>(
          `site_events?select=id,kind&visit_key=eq.${key}&limit=1`,
        );
        qa.event_readback = evBack && evBack.length
          ? { ok: evBack[0].id === ev.id, row_id: evBack[0].id, kind: evBack[0].kind }
          : { ok: false };
        const del = await fetch(`${SUPABASE_URL}/rest/v1/site_events?visit_key=eq.${key}`, {
          method: "DELETE", headers: { ...PG_HEADERS, "Prefer": "return=representation" },
        });
        qa.event_delete = { ok: del.ok, rows_deleted: del.ok ? ((await del.json()) as unknown[]).length : 0 };
      }
      // 2. Conversation + attributed order — insert both, verify the tier and
      //    the drill-in join (order.chat_session → conversation.session_key).
      const convo = await pgInsert<{ id: string }>("concierge_conversations", { session_key: key });
      qa.conversation_insert = convo ? { ok: true, conversation_id: convo.id } : { ok: false };
      const ord = await pgInsert<{ id: string }>("orders", {
        email: "qa-selftest@", status: "cancelled", serial: null,
        chat_session: key, chat_via: "identity", chat_meta: { lookback_days: 1 },
      });
      qa.order_insert = ord
        ? { ok: true, order_id: ord.id }
        : { ok: false, hint: "check chat_via/chat_meta columns + orders_chat_via_check constraint" };
      if (ord) {
        const back = await pgSelect<{ id: string; chat_via: string; chat_meta: { lookback_days?: number }; status: string; serial: number | null }>(
          `orders?select=id,chat_via,chat_meta,status,serial&chat_session=eq.${key}&limit=1`,
        );
        const b = back && back[0];
        qa.tier_readback = b
          ? {
            ok: b.chat_via === "identity" && b.chat_meta?.lookback_days === 1,
            chat_via: b.chat_via, lookback_days: b.chat_meta?.lookback_days ?? null,
            status: b.status, serial: b.serial,
          }
          : { ok: false };
        const join = await pgSelect<{ id: string }>(
          `concierge_conversations?select=id&session_key=eq.${key}&limit=1`,
        );
        qa.join_readback = join && join.length && convo
          ? { ok: join[0].id === convo.id, joined_conversation_id: join[0].id, expected: convo.id }
          : { ok: false };
        const delO = await fetch(`${SUPABASE_URL}/rest/v1/orders?chat_session=eq.${key}`, {
          method: "DELETE", headers: { ...PG_HEADERS, "Prefer": "return=representation" },
        });
        qa.order_delete = { ok: delO.ok, rows_deleted: delO.ok ? ((await delO.json()) as unknown[]).length : 0 };
      }
      if (convo) {
        const delC = await fetch(`${SUPABASE_URL}/rest/v1/concierge_conversations?session_key=eq.${key}`, {
          method: "DELETE", headers: { ...PG_HEADERS, "Prefer": "return=representation" },
        });
        qa.conversation_delete = { ok: delC.ok, rows_deleted: delC.ok ? ((await delC.json()) as unknown[]).length : 0 };
      }
      // 3. Confirm cleanup left nothing behind (reporting also excludes qa-%).
      // PostgREST's LIKE wildcard is `*` (a raw `%` breaks URL decoding → 400).
      const leftovers = await pgSelect<{ id: unknown }>(`orders?select=id&chat_session=like.qa-selftest-*&limit=5`);
      qa.cleanup = leftovers === null
        ? { ok: false, query_ok: false, hint: "leftovers query failed — cleanup itself already reported rows_deleted above" }
        : { ok: leftovers.length === 0, query_ok: true, leftover_orders: leftovers.length };
      const stepOk = (v: unknown) => !!v && (v as { ok?: boolean }).ok === true;
      qa.verdict = ["event_insert", "event_readback", "event_delete", "conversation_insert", "order_insert",
        "tier_readback", "join_readback", "order_delete", "conversation_delete", "cleanup"]
        .every((k) => stepOk(qa[k])) ? "PASS" : "FAIL";
    } catch (e) {
      qa.verdict = "FAIL";
      qa.error = e instanceof Error ? e.message : String(e);
    }
    qa.duration_ms = Date.now() - started;
    // Durable audit record of the run itself — who, when, verdict, and the full
    // step evidence. Visible in the admin's Actions tab (action = attribution_qa).
    try {
      await pgInsert("concierge_actions", {
        conversation_id: null, user_id: qaAdmin.id, email: qaAdmin.email,
        action: "attribution_qa", serial: null, payload: qa,
        result: `${qa.verdict} — key ${key}, ${qa.duration_ms}ms`,
      });
      qa.audit_logged = true;
    } catch { qa.audit_logged = false; }
    report.attribution_qa = qa;
  }
  return jsonResponse(req, 200, report);
}

// ── POST — streaming chat ────────────────────────────────────────────────────

async function handleChatPost(req: Request): Promise<Response> {
  // Rate limit. Anonymous traffic: strict per-IP wall. A signed-in,
  // email-verified patron gets a roomier window keyed by user id — proactive
  // beats are chat calls too, so an engaged patron at a driving pace could
  // exhaust the shared IP wall mid-conversation (seen live). Both ceilings
  // are admin config (chat_rate_signed / chat_rate_anon, per 10 minutes);
  // the limiter is what keeps the model bill bounded, so the defaults stay
  // conservative.
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const rlCfg = (await loadConciergeData()).config;
  const signedLimit = typeof rlCfg?.chat_rate_signed === "number" && rlCfg.chat_rate_signed > 0
    ? rlCfg.chat_rate_signed : 60;
  const anonLimit = typeof rlCfg?.chat_rate_anon === "number" && rlCfg.chat_rate_anon > 0
    ? rlCfg.chat_rate_anon : RATE_LIMIT;
  const rlUser = await verifyUser(req);
  if (rlUser) {
    if (await rateLimited("u:" + rlUser.id, signedLimit)) {
      return jsonError(req, 429,
        "Too many requests. The concierge takes a short pause — try again in a few minutes.");
    }
  } else if (await rateLimited(ip, anonLimit)) {
    return jsonError(req, 429,
      "Too many requests. The concierge takes a short pause — try again in a few minutes.");
  }

  // Body validation (v1 rules + optional session_key).
  let parsed: unknown;
  try { parsed = await req.json(); } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const validated = validateBody(parsed);
  if (typeof validated === "string") return jsonError(req, 400, validated);

  // Proactive follow-up: the client reports the shopper fell quiet with a
  // nudge context. Append a synthetic instruction (never shown, never logged
  // as the shopper's words) so the model picks the thread back up itself.
  const nudge = (validated.context && typeof validated.context === "object")
    ? (validated.context as Record<string, unknown>).nudge as
      { seconds?: number; count?: number } | undefined
    : undefined;
  const isNudge = !!nudge &&
    validated.messages.length > 0 &&
    validated.messages[validated.messages.length - 1].role === "assistant";
  // The beat decision's audit record (ledger snapshot + rule trace) — written
  // with the beat's outcome: beat_action when it speaks, folded into the
  // beat_hold payload when it holds. This is the "run the diagnostic and see
  // why" trail.
  let beatAudit: Record<string, unknown> | null = null;
  if (isNudge) {
    const secs = typeof nudge!.seconds === "number" ? Math.round(nudge!.seconds) : 40;
    const cnt = typeof nudge!.count === "number" ? nudge!.count : 1;
    const signedIn = (nudge as Record<string, unknown>)?.signedIn === true;
    // Hard signal, computed from the actual tail. The whole run of consecutive
    // assistant lines at the end IS the unprompted reach-out streak — if ANY of
    // them asked a question the shopper never answered, it is still pending.
    // Checking only the very last line let a statement beat "launder" the
    // guard: ask → statement → statement → re-ask the same question. Now a
    // pending question forbids question marks on every beat until they speak.
    let runStart = validated.messages.length;
    while (runStart > 0 && validated.messages[runStart - 1].role === "assistant") runStart--;
    const trailingRun = validated.messages.slice(runStart);
    const unansweredAskLocal = hasPendingAsk(
      trailingRun.map((m) => typeof m.content === "string" ? m.content : ""),
    );
    const recall = await crossSurfaceRecall(req);
    const unansweredAsk = unansweredAskLocal || recall.pendingAsk;
    const crossNote = recall.note;
    // The Sales Ledger decides this beat's action — numbers, not guessing.
    // Signed-out or any failure → null → the prompt's own judgment applies.
    let beatDecision: BeatDecision | null = null;
    try {
      if (recall.customer) {
        const dataForBeat = await loadConciergeData();
        const beatSection = (validated.context && typeof validated.context === "object" &&
          typeof (validated.context as Record<string, unknown>).section === "string")
          ? String((validated.context as Record<string, unknown>).section).toLowerCase() : "";
        const sk = validated.sessionKey ?? "";
        let gs: Record<string, { status?: string }> | null = null;
        if (sk) {
          const rows = await pgSelect<{ goal_status: Record<string, { status?: string }> | null }>(
            `concierge_conversations?select=goal_status&session_key=eq.${encodeURIComponent(sk)}&order=created_at.desc&limit=1`,
          );
          if (rows && rows[0]) gs = rows[0].goal_status;
        }
        const ledger = await buildSalesLedger(recall.customer, dataForBeat, beatSection, gs, unansweredAsk);
        beatDecision = chooseBeatAction(
          ledger,
          dataForBeat.config?.beat_actions as Record<string, { enabled?: boolean }> | undefined,
          { restHours: proposalRestHoursFrom(dataForBeat.config?.outreach) },
        );
        beatAudit = { action: beatDecision.action, beat: "nudge", ledger, trace: beatDecision.trace };
      }
    } catch { /* ledger is best-effort — the beat falls back to prompt judgment */ }
    // The HOT-EXCHANGE window: the first check-in moments after the patron
    // spoke is a live conversation, not idle re-engagement — going dead there
    // loses the customer. The ledger's HOLD is for idle beats; here it softens
    // to "keep the thread moving". EXCEPT when the reply on their screen is
    // long: a reader mid-paragraph is engaged, not idle — piling a fresh line
    // on top of 80+ unread words is interruption dressed as attentiveness.
    // (The widget also floors the first rung's timer to ~300ms/word, so this
    // guard is the server-side defense for clients that don't.)
    const lastMsg = validated.messages[validated.messages.length - 1];
    const lastReplyWords = (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content === "string")
      ? lastMsg.content.split(/\s+/).filter(Boolean).length : 0;
    const stillReading = cnt === 1 && lastReplyWords > 80;
    const hotExchange = cnt === 1 && secs <= 30 && !stillReading;
    if (stillReading && beatAudit) beatAudit.stillReading = lastReplyWords;
    let actionBrief = beatDecision
      ? (beatDecision.action === "HOLD"
        ? " THE HOUSE HAS DECIDED THIS BEAT: HOLD — " + beatDecision.detail + ". Set speak to false."
        : " THE HOUSE HAS DECIDED THIS BEAT'S ACTION — computed from the register, not guessed: " +
          beatDecision.action + ". " + beatDecision.detail + ". Perform EXACTLY this in one warm, " +
          "plain line — every guardrail above still binds (no question mark if one of yours is " +
          "pending), and do not substitute a different subject.")
      : "";
    if (hotExchange && (!beatDecision || beatDecision.action === "HOLD")) {
      actionBrief = " THEY SPOKE ONLY MOMENTS AGO — this is a LIVE exchange, not idle re-engagement, " +
        "and a live exchange never goes dead on the first beat: offer the single most natural next " +
        "step (a shade more depth on what they asked, a choice to put in front of them, or the " +
        "register when they're warm) in one short plain line. Hold (speak false) here only if they " +
        "clearly closed the conversation themselves.";
      if (beatAudit) beatAudit.hotExchangeOverride = true;
    }
    if (stillReading) {
      actionBrief += " THE REPLY ON THEIR SCREEN IS LONG (" + lastReplyWords + " words) — they are " +
        "most likely still reading it. Do not stack more prose on top: speak only if you have one " +
        "genuinely fresh, SHORT next step (a single sentence); otherwise hold (set speak to false).";
    }
    // NOTE: the guard must never offer holding as the easy out — a hold leaves
    // the unanswered question as the trailing line, so the guard would re-fire
    // on every later beat and the bot would fall silent entirely (a hold loop).
    // It demands a STATEMENT: the conversation keeps breathing, just without
    // another question mark.
    const askGuard = unansweredAsk
      ? " A QUESTION OF YOURS IS STILL UNANSWERED on their screen (look at your own recent lines). " +
        "On THIS beat do not ask ANYTHING — not that question, not a rephrase, not a different one. " +
        "If you have one true, NEW, concrete thing to offer (a register fact, a service note, a " +
        "piece of house expertise), speak it as one short statement with no question mark; otherwise " +
        "hold (set speak to false). Never fill the gap with atmosphere just to avoid silence. The " +
        "question stays open: once THEY speak, you may return to it through a different door."
      : "";
    // Anti-orbit: successive reach-outs must move, not circle. Whatever the
    // previous unprompted lines centred on, the next one opens a genuinely
    // different door — that's what keeps five beats about one subject from
    // happening. And when the doors are spent, the honest move is silence,
    // never invention.
    // A pointer, not a restatement — the vary-the-door rule lives once, in
    // ENGAGEMENT & PACING; the brief carries only this beat's facts.
    const doorNote = cnt >= 2
      ? ` This is unprompted reach-out #${cnt}: your ENGAGEMENT rules on varying the door apply ` +
        "with force — open a door you have not yet offered. Only when every door is truly spent, " +
        "hold (set speak to false)."
      : "";
    const groundNote = signedIn
      ? " They are a KNOWN patron — ground the line in their CUSTOMER block (first name, standing, " +
        "an order in their queue, a client-book note), never in generic prospect questions."
      : "";
    // Admin control: Tuning → Engagement pace → "Substance gate" (default ON).
    // Off restores the older always-say-something bias for merchants who prefer
    // constant presence over held beats. (60s-cached read — effectively free.)
    const beatCfg = (await loadConciergeData()).config;
    const beatOutreach = beatCfg?.outreach as Record<string, unknown> | undefined;
    const substanceGate = beatOutreach?.substanceGate !== false;
    const beatNotes = beatNotesClause(beatCfg);
    let decision: string;
    if (cnt <= 2) {
      // First couple: engage — but only with substance. The old "SPEAK now (do
      // not hold)" ordered content on a timer; with nothing new to say the
      // model complied by inventing atmosphere. Substance or silence.
      decision = substanceGate
        ? "The default on this beat is to SPEAK. Find one NEW, CONCRETE thing for THIS shopper — an " +
          "open goal's next step, a natural next sale (a companion cloth for another room, a gift " +
          "with the card in another name), the room or person they brought up, a register fact that " +
          "needs ACTION, or one unoffered piece of house expertise — and send ONE warm, plain line " +
          "built on it (one or two short sentences, a clerk's speech, no stacked imagery). Prefer " +
          "motion toward the register over a status report — a fact is a doorway, not the " +
          "destination. When in doubt between a modest true line and silence, speak the modest " +
          "line. Hold (set speak to false) ONLY when anything you could say would repeat what is " +
          "already on their screen — never restate in new wrapping, never invent detail, and don't " +
          "re-ask a question they haven't answered. Persistence is fine; repetition and filler are " +
          "what annoy."
        : "SPEAK now (do not hold). Send one warm, specific, PLAIN line drawn from THIS " +
          "conversation and what you know of them — one or two short sentences, a clerk's speech, " +
          "every fact verbatim from the register, never invented color. Don't re-ask or rephrase " +
          "a question they haven't answered — vary the door instead.";
    } else {
      // Later: a light, human "still here" presence. Presence first — silence
      // only when the doors are truly spent (merchant feedback: too much
      // silence reads as a dead shop, not respect).
      decision = substanceGate
        ? "This is a later check-in — keep a light, HUMAN presence, the way a clerk " +
          "lingers nearby: one brief, low-pressure sentence (\"Still here whenever you'd " +
          "like to pick this up\"), or one small unoffered piece of house expertise. Do not " +
          "re-pitch, repeat yourself, or dress the register up in new words. Hold (set speak to " +
          "false) only when nothing has changed AND every small offering is already spent — " +
          "presence first, silence when the doors are truly dry."
        : "This is a later check-in — keep a light, HUMAN presence: a brief, low-pressure line, " +
          "warm and unhurried, at most one sentence, plain speech. Do not re-pitch or repeat " +
          "yourself. If they truly seem done, you may hold (set speak to false) to give space.";
    }
    // For an anonymous visitor, occasionally invite them to leave their email so
    // the house can remember them — an account is how their orders and client
    // book persist. Not every time; roughly every other later check-in.
    const inviteEmail = !signedIn && cnt >= 2 && (cnt % 2 === 0);
    const emailNote = inviteEmail
      ? " Since they are NOT signed in, warmly invite them (once) to leave their email so the " +
        "house remembers them next time — put {{action:signin}} on its own line. Frame it as being " +
        "known and welcomed back, never as a form to fill."
      : "";
    // If the team left a one-time HOUSE INSTRUCTION for this patron, a proactive
    // beat is a natural moment to honour it (you have no tools here, so weave it
    // into your line; the house checks it off for you afterward).
    const houseNote =
      " If the CUSTOMER block carries a PROPER HOUSE INSTRUCTION (a note the team left for this patron), weave it " +
      "into this line in your OWN voice — you need no tool, and you do NOT resolve it here (the house checks it off " +
      "for you). " + HOUSE_NOTE_GUARD + " If you hold to give space, or the note is one you should not " +
      "act on, simply leave it unspoken — the desk reconciles it later.";
    validated.messages.push({
      role: "user",
      content:
        `[Context note, not the shopper's words: they have been quiet about ${secs} seconds ` +
        `(check-in #${cnt}). Follow your ENGAGEMENT & PACING procedure.${crossNote}${askGuard}${doorNote}${groundNote} ${decision}${actionBrief}${houseNote}${emailNote}${beatNotes} ` +
        `Do not greet them again as if they just arrived.]`,
    });
  }

  // Proactive opener: the visitor just opened (or reopened) the concierge. Speak
  // first, contextually, toward the goals — never wait for them to type. The
  // instruction is injected (never logged as their words); the model may call
  // recall_context to pull prior notes/conversation it doesn't already see.
  const opener = (validated.context as Record<string, unknown>)?.opener;
  const isOpener = opener === "reengage" || opener === "greet";
  if (isOpener && !isNudge) {
    const openerNotes = beatNotesClause((await loadConciergeData()).config);
    // The opener gets the cross-surface memory too — a re-engage opener
    // composed from identical inputs used to repeat itself verbatim on every
    // page refresh; seeing its own recent lines (plus the client-side opener
    // cooldown) breaks that loop.
    const openerRecall = await crossSurfaceRecall(req);
    const openerCross = openerRecall.note
      ? openerRecall.note + " If your last opener already said something like this, open a DIFFERENT " +
        "door or pick the thread up mid-sentence without any greeting at all."
      : "";
    validated.messages.push({
      role: "user",
      content: (opener === "greet"
        ? "[Context note, not the shopper's words: they just opened the concierge and have not " +
          "spoken yet. They already see a brief house greeting, so do NOT repeat a generic hello. " +
          "Add ONE warm, specific line that opens toward a conversation goal. If CUSTOMER is present, " +
          "make it personal — greet them by first name and nod to their standing or a real order/note " +
          "(a returning patron is never a stranger), drawing on the CUSTOMER block and CLIENT BOOK " +
          "already provided above. If that block carries a PROPER HOUSE INSTRUCTION left by the team, weave it into " +
          "this opening line in your OWN voice; you need no tool and do NOT resolve it here (the house checks it off " +
          "for you). " + HOUSE_NOTE_GUARD + " If there is NO CUSTOMER (an anonymous visitor), open from what " +
          "they're browsing (the BROWSING section and page) — e.g. the cloth they're reading about, " +
          "gift vs. their own home — and invite them in. End with a single light question. Do " +
          "not mention this note. One or two sentences. ALWAYS speak on this opening beat (speak " +
          "true, never hold) — opening the panel is their attention at its peak, and even with " +
          "nothing new in the register a clerk greets the person who just walked in; the hold is " +
          "for LATER check-ins.]"
        : "[Context note, not the shopper's words: they just reopened the chat to pick the thread " +
          "back up. Re-engage with ONE warm, specific line that advances a conversation goal, drawn " +
          "from the conversation so far and the CUSTOMER block / CLIENT BOOK already above — never a " +
          "generic greeting, never repeating yourself. If that block carries a PROPER HOUSE INSTRUCTION left " +
          "by the team, weave it into this line in your OWN voice; you need no tool and do NOT resolve it here " +
          "(the house checks it off for you). " + HOUSE_NOTE_GUARD + " Do not " +
          "mention this note. One or two sentences ending in a light question. ALWAYS speak on " +
          "this opening beat (speak true, never hold) — they just walked back in and their attention is at its peak; even with " +
          "nothing new to sell, a clerk acknowledges the return. The hold is for LATER check-ins.]") + openerCross + openerNotes,
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");

  // Config-driven behavior: kill switch, model, max_tokens.
  const data = await loadConciergeData();
  if (data.config?.enabled === false) {
    return jsonError(req, 503, "The concierge is resting. Write mberenji@gmail.com.");
  }
  const model = resolveModel(data);
  const maxTokens = typeof data.config?.max_tokens === "number" &&
      data.config.max_tokens > 0
    ? Math.floor(data.config.max_tokens)
    : 1024;

  // Signed-in awareness (anonymous on absent/invalid token; never errors).
  const customer = await verifyUser(req);
  // "Opening beat" = a proactive greet/reengage opener, or the very first turn with
  // no assistant reply yet. Only then do the RE-ENGAGEMENT banner and the "on your
  // very first line" directive framing belong in the prompt — mid-conversation they
  // make the model re-greet ("what brings you back today?") on every reply.
  const isOpening = isOpener ||
    !validated.messages.some((m) => m.role === "assistant");
  const customerLine = customer ? await customerBlock(customer, isOpening) : null;
  // Live goal status from the last evaluation, so the prompt shows which goals
  // are still open and the concierge actively drives them.
  let goalStatus: Record<string, { status?: string; note?: string }> | null = null;
  if (validated.sessionKey && data.goals.length > 0) {
    const gsRows = await pgSelect<{ goal_status: Record<string, { status?: string; note?: string }> | null }>(
      `concierge_conversations?select=goal_status&session_key=eq.${
        encodeURIComponent(validated.sessionKey)}&order=created_at.desc&limit=1`,
    );
    goalStatus = gsRows && gsRows[0] ? gsRows[0].goal_status : null;
  }
  const currentSection = typeof validated.context.section === "string" ? validated.context.section : null;
  const sysParts = buildSystemPrompt(
    data, renderLiveState(validated.context, customerLine), customer !== null, goalStatus, currentSection,
  );
  // Prompt caching: the large static prefix (brand + KB + tools + SOPs + tuning)
  // is sent as a cache_control:ephemeral block, so every later call that shares it
  // — the 2nd–4th agentic rounds, nudges, back-to-back turns within 5 min — pays
  // ~10% of that input instead of 100%. The dynamic tail (live state, goals) is a
  // second, uncached block so it never busts the cache.
  // deno-lint-ignore no-explicit-any
  const system: any[] = [
    { type: "text", text: sysParts.prefix, cache_control: { type: "ephemeral" } },
  ];
  if (sysParts.suffix && sysParts.suffix.trim().length > 0) {
    system.push({ type: "text", text: sysParts.suffix });
  }

  // Logging: resolve conversation + store the user turn, concurrently with
  // the model work; awaited again before the stream finishes.
  const conversationPromise = logUserTurn(validated, customer, isNudge || isOpener, ip);
  const startedAt = Date.now();

  // ── Semantic cache — anonymous, single-turn questions only ────────────────
  // Multi-turn answers depend on conversation context; signed-in answers on
  // the register. Neither may be cached or served from cache.
  let queryEmbedding: number[] | null = null;
  const lastUser = [...validated.messages].reverse().find((m) => m.role === "user");
  const userTurns = validated.messages.filter((m) => m.role === "user").length;
  const cacheEligible = !customer && !isNudge && !isOpener &&
    userTurns === 1 &&
    !!lastUser && lastUser.content.length <= 300 &&
    !CACHE_SKIP.test(lastUser.content);

  if (cacheEligible && lastUser) {
    queryEmbedding = await embed(lastUser.content);
    if (queryEmbedding) {
      let hit = await cacheLookup(queryEmbedding);
      // Polarity guard: a near-identical embedding can still ask the OPPOSITE
      // question. Mismatched negation signature → answer live, don't serve.
      if (hit && hasNegation(lastUser.content) !== hasNegation(hit.question)) {
        hit = null;
      }
      if (hit) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(sseFrame({ c: 1 }));
              for (const piece of chunked(hit.answer_md)) {
                controller.enqueue(sseFrame({ t: piece }));
              }
              const cid = await conversationPromise;
              const meta = await logAssistantTurn(
                cid, hit.answer_md, "cache", Date.now() - startedAt,
              );
              if (meta) controller.enqueue(encoder.encode(`data: ${meta}\n\n`));
            } catch { /* still close cleanly */ }
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch { /* consumer gone */ }
          },
        });
        return sseResponse(req, stream);
      }
    }
  }

  // ── Proactive path (nudge OR opener): the bot speaks on its own, with no
  //    register tools. The speak/hold decision is a FORCED structured tool
  //    ({speak, line}) — a typed field the model cannot decorate, which retired
  //    the whole [HOLD]-sentinel-leak class (decorated holds like **[HOLD]**
  //    used to slip regex scrubbing into the transcript). ──
  if (isNudge || isOpener) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(sseFrame(obj)); } catch { /* gone */ }
        };
        let text = "";
        let speak = false;
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "prompt-caching-2024-07-31",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model, max_tokens: Math.min(maxTokens, 400), system,
              messages: validated.messages,
              tools: [{
                name: "beat_line",
                description:
                  "Deliver this proactive beat: speak one warm, plain line, or hold (stay silent). " +
                  "Silence is for when there is truly NOTHING new and true left — when in doubt " +
                  "between a modest true line and silence, speak the modest line.",
                input_schema: {
                  type: "object",
                  properties: {
                    speak: {
                      type: "boolean",
                      description: "true = show the line to the shopper; false = hold, show nothing",
                    },
                    line: {
                      type: "string",
                      description: "the single line to show when speak is true (plain speech; may carry {{reply:…}}/{{action:…}} tokens where your rules allow them)",
                    },
                  },
                  required: ["speak"],
                },
              }],
              tool_choice: { type: "tool", name: "beat_line" },
            }),
          });
          if (res.ok) {
            // deno-lint-ignore no-explicit-any
            const msg = await res.json() as any;
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            // deno-lint-ignore no-explicit-any
            const tu = blocks.find((b: any) => b.type === "tool_use" && b.name === "beat_line");
            if (tu && tu.input && typeof tu.input === "object") {
              speak = (tu.input as Record<string, unknown>).speak === true;
              const l = (tu.input as Record<string, unknown>).line;
              text = typeof l === "string" ? l.trim() : "";
            }
          }
        } catch { /* fall through to hold */ }
        // The decision is typed, but the line is still free text — scrub any
        // plumbing, and keep ONE terminal defense: a merchant-era saved
        // engagement_base override in the wild may still instruct "[HOLD]".
        text = stripPlumbing(text).replace(/\s*\[hold\]\.?\s*$/i, "").trim();
        if (/^\W*hold\W*$/i.test(text)) { speak = false; text = ""; }
        const held = !speak || text.length === 0;
        // The reach-out judge: a spoken line is reviewed before it ships
        // (default ON; Engagement → House rules turns it off). Fail-open —
        // a judge error never silences a good line. A veto does NOT mark the
        // decided action spent, so the next beat may try again with a better
        // line through the same door.
        let vetoReason: string | null = null;
        if (!held) {
          try {
            const oj = (await loadConciergeData()).config?.outreach as Record<string, unknown> | undefined;
            if (oj?.beatJudge !== false) {
              const v = await judgeBeatLine(apiKey, text, isNudge ? "nudge" : "opener");
              if (v.veto) vetoReason = v.reason || "vetoed by the reach-out judge";
            }
          } catch { /* fail-open */ }
        }
        if (held || vetoReason !== null) {
          send({ hold: 1 });
          // A held beat is invisible in the transcript by design — record it so
          // hold rate is measurable (Actions tab, action='beat_hold'). Without
          // this row, silence and breakage look identical. (This write MUST live
          // here: this toolless fast path is where every nudge/opener runs.)
          // A VETOED beat is a different outcome — the model drafted a line and
          // the judge killed it — so it gets its own action ('beat_veto') with
          // the killed line and the judge's reason in the payload.
          try {
            const cid = await conversationPromise;
            pgInsert("concierge_actions", {
              conversation_id: cid, user_id: customer?.id ?? null, email: customer?.email ?? null,
              action: vetoReason !== null ? "beat_veto" : "beat_hold", serial: null,
              payload: vetoReason !== null
                ? { kind: isNudge ? "nudge" : "opener", line: text, reason: vetoReason, decision: beatAudit ?? undefined }
                : { kind: isNudge ? "nudge" : "opener", decision: beatAudit ?? undefined },
              result: vetoReason !== null ? "vetoed — " + vetoReason : "beat held — nothing new to say",
            }).catch(() => { /* audit failures never break the chat */ });
          } catch { /* skip audit */ }
        } else {
          for (const piece of chunked(text)) send({ t: piece });
          try {
            const cid = await conversationPromise;
            const meta = await logAssistantTurn(cid, text, model, Date.now() - startedAt);
            if (meta) { try { controller.enqueue(encoder.encode(`data: ${meta}\n\n`)); } catch { /* gone */ } }
            // A proactive beat has no tools, so if it honoured a one-time house
            // instruction it could not resolve it here — reconcile in the background.
            scheduleDirectiveReconcile(cid, customer, validated.messages, text, apiKey, model);
            // The beat SPOKE its decided action — this row is what marks the
            // action "spent" for the next 24h (chooseBeatAction reads it back),
            // and what the Actions tab shows. It was previously written only in
            // the signed-in tool loop, which nudges never reach — so actions
            // never went spent and "offer ONCE" re-fired every beat.
            if (beatAudit && isNudge) {
              pgInsert("concierge_actions", {
                conversation_id: cid, user_id: customer?.id ?? null, email: customer?.email ?? null,
                action: "beat_action", serial: null,
                payload: { ...beatAudit, outcome: "spoke" },
                result: String(beatAudit.action ?? ""),
              }).catch(() => { /* audit failures never break the chat */ });
            }
          } catch { /* skip meta */ }
        }
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* gone */ }
      },
    });
    return sseResponse(req, stream);
  }

  // ── Signed-in path: agentic tool loop (non-streaming turns, chunked out) ──
  if (customer) {
    const modelTools = buildToolsForModel(data);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(sseFrame(obj)); } catch { /* consumer gone */ }
        };
        let finalText = "";
        try {
          const cid = await conversationPromise;
          // deno-lint-ignore no-explicit-any
          const convo: any[] = validated.messages.map((m) => ({ role: m.role, content: m.content }));
          for (let round = 0; round < 4; round++) {
            if (round === 0) send({ s: "Consulting the register…" });
            const res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "prompt-caching-2024-07-31",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model, max_tokens: maxTokens, system,
                messages: convo, tools: modelTools,
              }),
            });
            if (!res.ok) {
              finalText = finalText ||
                "The register is briefly unreachable. Ask me again in a moment.";
              break;
            }
            // deno-lint-ignore no-explicit-any
            const msg = await res.json() as any;
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            const textOut = blocks
              .filter((b: { type: string }) => b.type === "text")
              // deno-lint-ignore no-explicit-any
              .map((b: any) => b.text).join("");

            if (msg.stop_reason !== "tool_use") { finalText = textOut; break; }

            // Execute every requested tool, then continue the loop.
            convo.push({ role: "assistant", content: blocks });
            // deno-lint-ignore no-explicit-any
            const results: any[] = [];
            for (const block of blocks) {
              if (block.type !== "tool_use") continue;
              const label = ({
                get_my_orders: "Reading the register…",
                recall_context: "Turning back the pages…",
                track_shipment: "Checking where it stands…",
                get_care_guide: "Finding the care notes…",
                resend_confirmation: "Sending it along again…",
                request_mending: "Logging it with the workshop…",
                update_gift_details: "Naming the card…",
                update_variant: "Amending the register…",
                update_shipping_address: "Amending the register…",
                join_waitlist: "Adding to the waitlist…",
                submit_inquiry: "Taking down your details…",
                remember_customer: "Noting the client book…",
                resolve_admin_note: "Attending to the house's note…",
                cancel_order: "Striking the entry…",
              } as Record<string, string>)[block.name] ?? "Consulting the register…";
              send({ s: label });
              // submit_inquiry is the inquiry-mode conversion event — stamp it with
              // the live session context (session key, page section, conversation
              // depth) so its attribution mirrors the commission click. The model's
              // own args never carry these; inject them from the request, without
              // overriding anything the model happened to pass.
              let toolInput: Record<string, unknown> = (block.input ?? {}) as Record<string, unknown>;
              if (block.name === "submit_inquiry") {
                toolInput = { ...toolInput };
                if (validated.sessionKey && toolInput.session_key === undefined) {
                  toolInput.session_key = validated.sessionKey;
                }
                if (currentSection && toolInput.section === undefined) {
                  toolInput.section = currentSection;
                }
                if (toolInput.turns === undefined) toolInput.turns = userTurns;
                if (toolInput.origin === undefined) toolInput.origin = "tool";
              }
              const out = await runRegisterTool(
                block.name, toolInput, customer, cid,
              );
              results.push({ type: "tool_result", tool_use_id: block.id, content: out });
            }
            convo.push({ role: "user", content: results });
            if (round === 3) {
              finalText = textOut ||
                "The register kept me longer than it should. Ask me once more.";
            }
          }

          finalText = stripPlumbing(finalText);
          // [HOLD] is the "stay silent" signal for a PROACTIVE beat — it must
          // never render as text. On a nudge/opener that chose silence, emit a
          // hold and say nothing. If the model emits it in reply to something the
          // visitor actually typed (where holding makes no sense), never show the
          // token — answer with a light presence instead.
          const holdish = finalText.trim().length === 0 ||
            /^\[?hold\]?\.?$/i.test(finalText.trim());
          if (holdish && (isNudge || isOpener)) {
            send({ hold: 1 });
            finalText = "";
            // A held beat is invisible in the transcript by design — record it
            // to the audit log so hold rate is measurable (Actions tab,
            // action='beat_hold'). The substance gate working looks like holds,
            // not text; without this row, silence and breakage look identical.
            pgInsert("concierge_actions", {
              conversation_id: cid, user_id: customer?.id ?? null, email: customer?.email ?? null,
              action: "beat_hold", serial: null,
              payload: { kind: isNudge ? "nudge" : "opener", decision: beatAudit ?? undefined },
              result: "beat held — nothing new to say",
            }).catch(() => { /* audit failures never break the chat */ });
          } else {
            if (holdish) { finalText = "I'm here — what can I help you with?"; }
            for (const piece of chunked(finalText)) send({ t: piece });
          }
          if (finalText) {
            const lastUserMsg = [...validated.messages].reverse().find((m) => m.role === "user");
            await maybeFlagGap(cid, lastUserMsg?.content, finalText);
            if (!isNudge) {
              scheduleGoalEval(cid, data, [...validated.messages, { role: "assistant", content: finalText }], apiKey, model);
            }
            // Check off any one-time house instruction the model carried out but
            // forgot to resolve — background pass, tool-scoped to resolve_admin_note.
            scheduleDirectiveReconcile(cid, customer, convo, finalText, apiKey, model);
            // Roll the client book up into its summary once enough raw notes have
            // piled up (background, threshold-gated — usually a no-op).
            scheduleConsolidate(customer, apiKey, model);
            const meta = await logAssistantTurn(cid, finalText, model, Date.now() - startedAt);
            if (meta) { try { controller.enqueue(encoder.encode(`data: ${meta}\n\n`)); } catch { /* gone */ } }
            // The beat SPOKE its decided action — the audit row is what makes
            // it "spent" for the next 24h (and diagnosable in the Actions tab).
            if (beatAudit && isNudge) {
              pgInsert("concierge_actions", {
                conversation_id: cid, user_id: customer?.id ?? null, email: customer?.email ?? null,
                action: "beat_action", serial: null,
                payload: { ...beatAudit, outcome: "spoke" },
                result: String(beatAudit.action ?? ""),
              }).catch(() => { /* audit failures never break the chat */ });
            }
          }
        } catch { /* fall through to [DONE] */ }
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* consumer gone */ }
      },
    });
    return sseResponse(req, stream);
  }

  // ── Anonymous path: plain streaming, then a cache write on the way out ────
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify(
      { model, max_tokens: maxTokens, system, messages: validated.messages, stream: true },
    ),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return jsonError(req, 502, detail || `Upstream error (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let assistantText = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of rawEvent.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const evt = JSON.parse(payload);
                if (evt.type === "content_block_delta" &&
                  evt.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
                  assistantText += evt.delta.text;
                  controller.enqueue(sseFrame({ t: evt.delta.text }));
                }
                // Other event types (message_start/stop, ping, ...) ignored.
              } catch { /* ignore unparseable event payloads */ }
            }
          }
        }
      } catch {
        // Mid-stream failure: fall through so the front end still gets a
        // clean [DONE] and the partial reply is logged.
      } finally {
        // Log the assistant turn BEFORE [DONE], then emit the meta event.
        // Logging failures never break the stream — [DONE] is always sent.
        let meta: string | null = null;
        try {
          const cid = await conversationPromise;
          meta = await logAssistantTurn(cid, assistantText, model, Date.now() - startedAt);
        } catch { /* skip the meta event; still finish the stream */ }
        try {
          await maybeFlagGap(await conversationPromise, lastUser?.content, assistantText);
        } catch { /* ignore */ }
        try {
          const cidE = await conversationPromise;
          scheduleGoalEval(cidE, data, [...validated.messages, { role: "assistant", content: assistantText }], apiKey, model);
        } catch { /* eval is best-effort */ }
        // Cache write: single-turn anonymous miss with a state-free answer.
        try {
          if (cacheEligible && queryEmbedding && lastUser && cacheableAnswer(assistantText)) {
            await pgInsert("concierge_cache", {
              question: lastUser.content,
              answer_md: assistantText,
              embedding: vecLiteral(queryEmbedding),
              model,
            });
          }
        } catch { /* cache is best-effort */ }
        try {
          if (meta) controller.enqueue(encoder.encode(`data: ${meta}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* consumer already disconnected */ }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return sseResponse(req, stream);
}

// ── POST ?wrapup=1 — record that a conversation closed or snoozed ─────────────
// The client posts this on two kinds of signal, so the lifecycle is a MIX:
//   • customer-explicit — they pressed "That's all for now" (close) or
//     "Don't message me until I write back" (snoozed / quiet mode);
//   • bot-automatic — the panel was dismissed after a real exchange, or the
//     bot itself wound the conversation down.
// Either way we stamp the conversation's status + ended_at ONCE (already-ended
// conversations are left alone, which dedupes repeat closes). From then on the
// next message opens a fresh conversation the bot treats as a re-engagement.
async function handleWrapup(req: Request): Promise<Response> {
  // Public lifecycle beacon (fires on pagehide, so it can't require auth), but
  // bound it: without a limit an anon caller could spam status flips. Beacons are
  // rare per visitor, so a per-IP window is invisible to real use.
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (await rateLimited(ip)) return jsonResponse(req, 200, { ok: true, noted: false });
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const sessionKey = typeof body.session_key === "string" ? body.session_key.slice(0, 64) : "";
  if (!sessionKey) return jsonResponse(req, 200, { ok: true, noted: false });
  const reason = body.reason === "quiet" ? "quiet"
    : body.reason === "close" ? "close"
    : "auto";
  // quiet mode → snoozed ("come back when they write"); close/auto → closed.
  const status = reason === "quiet" ? "snoozed" : "closed";
  try {
    const rows = await pgSelect<{ id: string; ended_at: string | null; user_id: string | null }>(
      `concierge_conversations?select=id,ended_at,user_id&session_key=eq.${
        encodeURIComponent(sessionKey)}&order=created_at.desc&limit=1`,
    );
    if (!rows || rows.length === 0 || rows[0].ended_at) {
      return jsonResponse(req, 200, { ok: true, noted: false });
    }
    const cid = rows[0].id;
    await pgPatch(`concierge_conversations?id=eq.${cid}`, {
      status, ended_at: new Date().toISOString(),
    });
    // For a signed-in patron, write ONE substantive client-book line that
    // actually summarizes what happened and what was learned — never lifecycle
    // bookkeeping. Done asynchronously (a model call), and only when the
    // conversation had enough substance to be worth remembering.
    const customer = await verifyUser(req);
    if (customer) {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      const data = await loadConciergeData();
      const model = resolveModel(data);
      if (apiKey) scheduleClientBookNote(cid, customer, apiKey, model);
    }
    return jsonResponse(req, 200, { ok: true, noted: !!customer, status });
  } catch {
    return jsonResponse(req, 200, { ok: true, noted: false });
  }
}

/** Fire-and-forget: summarize the wrapped conversation into one client-book
 *  line, if it had real substance. Skips thin/off-topic chats entirely. */
/** Normalize a note to a bag of meaningful words for cheap similarity checks. */
function noteTokens(s: string): Set<string> {
  const stop = new Set([
    "the", "and", "for", "with", "was", "her", "his", "their", "they", "she", "he",
    "a", "an", "to", "of", "in", "on", "is", "it", "that", "this", "patron", "about",
    "has", "have", "had", "but", "not", "one", "over", "into", "from", "who", "will",
  ]);
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

/** True if `note` substantially overlaps a note already in the book. Guards
 *  against near-verbatim repeats slipping past the model's own dedup. */
function isRedundantNote(note: string, prior: { note: string }[]): boolean {
  const a = noteTokens(note);
  if (a.size === 0) return false;
  for (const p of prior) {
    const b = noteTokens(p.note);
    if (b.size === 0) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    // Jaccard over the smaller set: ≥0.7 of the new note's content words are
    // already present in an existing line → treat it as a repeat.
    if (shared / a.size >= 0.7) return true;
  }
  return false;
}

function scheduleClientBookNote(
  cid: string, customer: Customer, apiKey: string, model: string,
): void {
  const p = writeClientBookNote(cid, customer, apiKey, model);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else p.catch(() => {});
  } catch { p.catch(() => {}); }
}

async function writeClientBookNote(
  cid: string, customer: Customer, apiKey: string, model: string,
): Promise<void> {
  try {
    const msgs = await pgSelect<{ role: string; content: string }>(
      `concierge_messages?select=role,content&conversation_id=eq.${cid}&order=created_at.asc&limit=40`,
    );
    if (!msgs || msgs.length < 2) return;                 // nothing worth noting
    const userTurns = msgs.filter((m) => m.role === "user").length;
    if (userTurns < 1) return;
    const convo = msgs
      .map((m) => `${m.role === "user" ? "Patron" : "Concierge"}: ${m.content}`)
      .join("\n").slice(0, 6000);
    // The book already knows some things about this patron. Feed the recent
    // lines in so the writer records only what is NEW — otherwise every return
    // visit re-notes the same durable facts and the book fills with repeats.
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const prior = await pgSelect<{ note: string }>(
      `customer_notes?select=note&${nf}&order=created_at.desc&limit=12`,
    );
    const known = (prior ?? []).map((n) => `- ${n.note}`).join("\n");
    // The house policy for what the client book records is admin-editable
    // (Tuning → Client book policy) so it can be fine-tuned without a deploy.
    const data = await loadConciergeData();
    const policy = typeof data.config?.clientbook_policy === "string" && data.config.clientbook_policy.trim()
      ? data.config.clientbook_policy.trim()
      : "";
    // Editable base ("what to record") + the admin's layered HOUSE POLICY override.
    const cbase = (typeof data.config?.clientbook_base === "string" && data.config.clientbook_base.trim())
      ? data.config.clientbook_base
      : CLIENTBOOK_BASE;
    const sys =
      cbase +
      (policy ? "HOUSE POLICY (follow this above all):\n" + policy + "\n" : "") +
      "ALREADY IN THE BOOK:\n" + (known || "(nothing yet)") + "\n\n" +
      "Also — like a thoughtful support agent — add a brief SELF-REFLECTION: one concrete way to " +
      "serve THIS patron better next time (a preference to lead with, a friction to avoid, a follow-up " +
      "to offer). Skip it only if nothing useful comes to mind.\n" +
      "Respond in EXACTLY this shape and nothing else:\n" +
      "FACT: <the durable fact or event to remember, or SKIP>\n" +
      "REFLECTION: <how to serve them better next time, or SKIP>";
    const reflectOn = data.config?.clientbook_reflect !== false; // admin opt-out
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 220, system: sys,
        messages: [{ role: "user", content: `CONVERSATION:\n${convo}\n\nReply with the FACT and REFLECTION lines.` }],
      }),
    });
    if (!res.ok) return;
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const pick = (label: string) => {
      const m = new RegExp(label + ":\\s*([\\s\\S]*?)(?:\\n[A-Z]+:|$)", "i").exec(text);
      const v = m ? m[1].trim() : "";
      return (!v || v.toUpperCase() === "SKIP" || v.length < 8) ? "" : v.slice(0, 220);
    };
    const fact = pick("FACT");
    const reflection = reflectOn ? pick("REFLECTION") : "";
    // Fact: skip if it just echoes the book. Reflection: keep (it's advisory, not
    // a repeated preference), but still drop a near-verbatim repeat.
    if (fact && !isRedundantNote(fact, prior ?? [])) {
      await pgInsert("customer_notes", { user_id: customer.id, email: customer.email, note: fact, kind: "fact" });
    }
    if (reflection && !isRedundantNote(reflection, prior ?? [])) {
      await pgInsert("customer_notes", { user_id: customer.id, email: customer.email, note: reflection, kind: "reflection" });
    }
  } catch { /* best-effort — a missing note never breaks a wrap-up */ }
}

// ── POST ?form=1 — structured submissions from in-chat forms ─────────────────
// Same trust boundary as the model's own tool calls: the tool's own validation
// and the concierge_actions audit log. Register-edit forms (address-change) still
// require a verified JWT and an order serial. Inquiry forms (make-an-offer,
// book-a-viewing → submit_inquiry) are lead capture: ANONYMOUS-capable and
// serial-free, so a serious buyer without an account can still reach the house.

async function handleFormPost(req: Request): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (await rateLimited("f:" + ip)) {
    return jsonError(req, 429, "A short pause, please — the register is writing.");
  }
  // May be null — inquiry forms are anonymous-capable; register-edit forms below
  // still require sign-in.
  const customer = await verifyUser(req);
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const slug = typeof body.form === "string" ? body.form : "";
  const values = (body.values && typeof body.values === "object" && !Array.isArray(body.values))
    ? body.values as Record<string, unknown>
    : null;
  if (!slug || !values) {
    return jsonError(req, 400, "form and values are required.");
  }
  const data = await loadConciergeData();
  const def = data.forms.find((f) => f.slug === slug);
  if (!def) return jsonError(req, 404, "No such form.");
  const fields = Array.isArray(def.fields) ? def.fields as Array<Record<string, unknown>> : [];

  // ── Inquiry forms — anonymous lead capture, no order serial ──────────────
  if (def.submit_tool === "submit_inquiry") {
    // Anonymous lead capture. The session context (session_key, page section,
    // conversation depth) rides the form POST the same way the commission click's
    // marker rides checkout — the tool stamps chat_via='concierge'/chat_meta from
    // it. origin='form' records that this lead arrived through an inquiry form.
    const input: Record<string, unknown> = {
      session_key: typeof body.session_key === "string" ? body.session_key : "",
      page_url: typeof body.page_url === "string" ? body.page_url : "",
      section: typeof body.section === "string" ? body.section : "",
      turns: typeof body.turns === "number" ? body.turns : undefined,
      origin: "form",
    };
    for (const f of fields) {
      const name = typeof f.name === "string" ? f.name : "";
      if (!name) continue;
      // A fixed-value field (e.g. the form's `kind`) is set by the definition,
      // not typed by the shopper.
      if (typeof f.value === "string") { input[name] = f.value; continue; }
      const raw = values[name];
      const v = typeof raw === "string" ? raw.trim().slice(0, 2000) : "";
      if (f.required === true && !v) {
        return jsonError(req, 400, `${name} is required.`);
      }
      input[name] = v;
    }
    // submit_inquiry ignores customer for the row (no user_id column); pass the
    // signed-in one when present so the notification can note who it was.
    const who = customer ?? { id: "", email: null };
    const result = await runRegisterTool("submit_inquiry", input, who, null);
    if (result.startsWith("ERROR:")) {
      return jsonError(req, 400, result.slice(6).trim());
    }
    return jsonResponse(req, 200, { ok: true, message: result });
  }

  // ── Register-edit forms — signed-in and serial-bound (e.g. address-change) ─
  if (!customer) {
    return jsonError(req, 401, "The register takes signed entries — sign in first.");
  }
  const serial = typeof body.serial === "number" ? Math.floor(body.serial) : NaN;
  if (!Number.isFinite(serial)) {
    return jsonError(req, 400, "form, serial, and values are required.");
  }

  // Build the tool input strictly from the form's own field definitions.
  const input: Record<string, unknown> = { serial };
  for (const f of fields) {
    const name = typeof f.name === "string" ? f.name : "";
    if (!name) continue;
    const raw = values[name];
    const v = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
    if (f.required === true && !v) {
      return jsonError(req, 400, `${name} is required.`);
    }
    input[name] = v;
  }

  const result = await runRegisterTool(def.submit_tool, input, customer, null);
  if (result.startsWith("ERROR:")) {
    return jsonError(req, 400, result.slice(6).trim());
  }
  return jsonResponse(req, 200, { ok: true, message: result });
}

// ── Entry point ──────────────────────────────────────────────────────────────

// ── GET ?site=1 — storefront CMS content for the page hydrator ────────────────
// Public read of site_content (service role bypasses RLS; the copy is public
// anyway). Returns { slots: { slug: {value, alt, kind} } }; the page overrides
// only the slots present here, falling back to its hardcoded defaults.
async function handleSiteGet(req: Request): Promise<Response> {
  try {
    const rows = await pgSelect<{ slug: string; kind: string | null; value: string | null; alt: string | null }>(
      "site_content?select=slug,kind,value,alt",
    );
    const slots: Record<string, { value: string | null; alt: string | null; kind: string }> = {};
    for (const r of rows ?? []) {
      if (r && typeof r.slug === "string" && r.slug) {
        slots[r.slug] = { value: r.value ?? null, alt: r.alt ?? null, kind: r.kind ?? "text" };
      }
    }
    return jsonResponse(req, 200, { slots });
  } catch {
    return jsonResponse(req, 200, { slots: {} });
  }
}

// ── POST ?reengage=1 — a goal + journey aware line for the closed-panel bubble ─
// The client shows this instead of a hardcoded line. Reads the freshest
// goal_status, picks the open goal that fits the section the visitor is reading,
// and composes one short outreach line. Returns { text: null } to fall back to
// the client's own line (all goals met, disabled, no key, or any failure).
async function handleReengage(req: Request): Promise<Response> {
  const fallback = () => jsonResponse(req, 200, { text: null });
  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    if (await rateLimited("re:" + ip)) return fallback();
    let body: Record<string, unknown>;
    try { body = await req.json() as Record<string, unknown>; } catch { return fallback(); }
    const sessionKey = typeof body.session_key === "string" ? body.session_key.slice(0, 64) : "";
    const section = typeof body.section === "string" ? body.section.slice(0, 32).toLowerCase() : "";
    const data = await loadConciergeData();
    if (data.config?.enabled === false || data.goals.length === 0) return fallback();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return fallback();
    const model = resolveModel(data);
    const customer = await verifyUser(req);

    let cid: string | null = null;
    let goalStatus: Record<string, { status?: string }> | null = null;
    if (sessionKey) {
      const rows = await pgSelect<{ id: string; goal_status: Record<string, { status?: string }> | null }>(
        `concierge_conversations?select=id,goal_status&session_key=eq.${
          encodeURIComponent(sessionKey)}&order=created_at.desc&limit=1`,
      );
      if (rows && rows[0]) { cid = rows[0].id; goalStatus = rows[0].goal_status; }
    }

    // Optional synchronous re-grade for the freshest possible status (admin
    // toggle, default off). One extra model call; then re-read goal_status.
    if (cid && data.config?.reengage_regrade === true) {
      const msgs = await pgSelect<{ role: string; content: string }>(
        `concierge_messages?select=role,content&conversation_id=eq.${cid}&order=created_at.asc&limit=20`,
      );
      if (msgs && msgs.filter((m) => m.role === "user").length >= 2) {
        await evaluateGoals(cid, data, msgs as ChatMessage[], apiKey, model);
        const rows2 = await pgSelect<{ goal_status: Record<string, { status?: string }> | null }>(
          `concierge_conversations?select=goal_status&id=eq.${cid}&limit=1`,
        );
        if (rows2 && rows2[0]) goalStatus = rows2[0].goal_status;
      }
    }

    const signed = customer !== null;
    const postSale = body.post_sale === true;

    // Anti-repetition for the bubble: this endpoint composes each line fresh,
    // so without seeing its own recent lines it rediscovers the same subject
    // every beat (seen live: four bubbles in a row about the same placeholder
    // addresses, two re-asking the same unanswered question). Bubbles are
    // logged to the conversation, so read them back and bind the same rules
    // the in-panel beats follow: spent subjects, no re-asks, hold when dry.
    let recentLines: string[] = [];
    let pendingAsk = false;
    {
      // Scope the guard to the PATRON, not just the current conversation: a
      // wrap-up or quiet-window expiry opens a fresh conversation row, and a
      // guard that only read the new (empty) one let the same subject return
      // 45 minutes later. For a signed-in patron, read across their recent
      // conversations; anonymous falls back to the current session's.
      let ids: string[] = [];
      if (customer) {
        const convs = await pgSelect<{ id: string }>(
          `concierge_conversations?select=id&user_id=eq.${customer.id}&order=created_at.desc&limit=3`,
        );
        if (convs) ids = convs.map((c) => c.id);
      }
      if (cid && !ids.includes(cid)) ids.unshift(cid);
      ids = ids.slice(0, 3);
      if (ids.length) {
        const prior = await pgSelect<{ role: string; content: string }>(
          `concierge_messages?select=role,content&conversation_id=in.(${ids.join(",")})&order=created_at.desc&limit=10`,
        );
        if (prior && prior.length) {
          recentLines = prior.filter((m) => m.role === "assistant")
            .map((m) => String(m.content)).slice(0, 6);
          // pending = a '?' ANYWHERE in the trailing assistant run (nothing
          // from the visitor since) — not only when a line ends in one
          const run: string[] = [];
          for (const m of prior) {
            if (m.role !== "assistant") break;
            run.push(String(m.content));
          }
          pendingAsk = hasPendingAsk(run);
        }
      }
    }
    const repeatSubjects = extractSubjects(recentLines);
    const repeatGuard = recentLines.length
      ? " YOUR OWN RECENT LINES to this shopper (newest first): " +
        recentLines.map((l, i) => `[${i + 1}] ${l.slice(0, 140)}`).join("  ") +
        ". HARD RULES: never repeat, rephrase, or re-ask anything above — a subject already raised " +
        "(an order, an address, a cloth) is SPENT until the shopper answers; open a genuinely " +
        "different door." +
        (repeatSubjects.length
          ? " SPENT SUBJECTS (raise NONE of these again, in any wording): " + repeatSubjects.join(", ") + "."
          : "") +
        (pendingAsk
          ? " A question of yours is still unanswered — this line must contain NO question mark."
          : "") +
        " Only if nothing NEW and TRUE is left — not even a small piece of house expertise keyed to " +
        "where they are reading — hold (set speak to false)."
      : "";
    const askOrStatement = pendingAsk
      ? "as one plain statement with NO question mark. "
      : "ending in one light question. ";

    // The Sales Ledger decides the bubble's action too — and a HOLD decision
    // short-circuits BEFORE the model call (no tokens spent saying nothing).
    // The decision (ledger + rule trace) is audited either way.
    let bubbleDecision: BeatDecision | null = null;
    let bubbleAudit: Record<string, unknown> | null = null;
    if (customer) {
      try {
        const ledger = await buildSalesLedger(customer, data, section, goalStatus, pendingAsk);
        bubbleDecision = chooseBeatAction(
          ledger,
          data.config?.beat_actions as Record<string, { enabled?: boolean }> | undefined,
          { restHours: proposalRestHoursFrom(data.config?.outreach) },
        );
        bubbleAudit = { action: bubbleDecision.action, beat: "bubble", ledger, trace: bubbleDecision.trace };
        if (bubbleDecision.action === "HOLD") {
          pgInsert("concierge_actions", {
            conversation_id: cid, user_id: customer.id, email: customer.email,
            action: "beat_hold", serial: null,
            payload: { kind: "bubble", decision: bubbleAudit },
            result: "beat held — the action table found nothing new",
          }).catch(() => { /* audit is best-effort */ });
          return jsonResponse(req, 200, { text: null, hold: true });
        }
      } catch { /* ledger is best-effort — fall back to the goal path */ }
    }
    const bubbleBrief = bubbleDecision
      ? " THE HOUSE HAS DECIDED THIS LINE'S ACTION — computed from the register, not guessed: " +
        bubbleDecision.action + " — " + bubbleDecision.detail + ". Perform exactly this; do not " +
        "substitute a different subject."
      : "";

    // FULL patron context for a signed-in shopper — this outreach line must be
    // able to welcome them back warmly by name, standing, orders, and client
    // book, and honour any open house instruction (customerBlock carries the
    // directives + honesty guard). Words only (no tools here); the house
    // reconciles any check-off later. opening=false: the bubble itself is the
    // re-engagement, so the "greet like someone returning" banner would be
    // redundant pressure.
    let houseClause = "";
    if (customer) {
      try {
        const block = await customerBlock(customer, false);
        houseClause = " " + block + " Ground the line in THIS patron — their first name, standing, an order " +
          "in their queue, or a client-book note — never a generic prospect line. If a proper HOUSE " +
          "INSTRUCTION is open above, weave it into this line in your OWN voice (no tool needed here).";
      } catch { /* context is best-effort — the line still goes out */ }
    }

    // The closed-panel bubble is composed by a bare prompt with no constitution
    // behind it — the ONE surface that didn't sound like the house. It now
    // carries the distilled VOICE paragraph (a 30-word line doesn't need the
    // full prompt registry) plus the admin's voice notes when set.
    const bubbleVoice =
      " HOUSE VOICE: calm, precise, a dry wit and quiet understatement — short sentences, plain " +
      "English, no emoji, no exclamation marks, never pushy. Warm like a good clerk, not a help " +
      "desk. Never invent prices, dates, discounts, or urgency: the price never moves, and the " +
      "numbered edition's real scarcity is the only true urgency." +
      (typeof data.config?.voice_notes === "string" && data.config.voice_notes.trim()
        ? " House voice notes: " + data.config.voice_notes.trim().slice(0, 400)
        : "");
    let sys: string;
    if (postSale) {
      // They JUST commissioned — never "still eyeing it". Congratulate lightly if
      // natural, then invite a SECOND entry (companion cloth for another room, or
      // one as a gift with the register card in another name).
      sys =
        "You are The Porsche Concierge for 2003 Porsche 911 Turbo. This shopper JUST commissioned a car and is " +
        "browsing again on the '" + (section || "page") + "' section. Write ONE short line (max 30 " +
        "words) that does NOT treat them as undecided — a light nod to their new entry is fine, then " +
        "warmly invite a SECOND car: a companion piece for another room, or one as a gift with the " +
        "register card in another name, " + askOrStatement +
        (signed ? "They are a signed-in patron." : "They are an anonymous visitor.") +
        " Plain text only: no markdown, no quotation marks, no {{tokens}}. Just the line." +
        bubbleVoice + houseClause + repeatGuard + bubbleBrief + beatNotesClause(data.config);
    } else {
      const open = goalStatus
        ? data.goals.filter((g) => (goalStatus![g.slug]?.status ?? "unmet") !== "met")
        : data.goals;
      // A ledger decision supersedes the goal check (e.g. a blocked order is
      // worth a line even when every goal is met); without one, all-met still
      // means don't push.
      if (!bubbleDecision && open.length === 0) return fallback();
      const goal = open.find((g) => !!section && goalSections(g).includes(section)) || open[0];
      const advanceLine = bubbleDecision
        ? bubbleDecision.detail
        : (goal!.label + " — " + goal!.description);
      sys =
        "You are The Porsche Concierge for 2003 Porsche 911 Turbo — cars made in numbered batches. Write ONE short " +
        "outreach line (max 30 words) to a shopper who is reading the '" + (section || "page") +
        "' section and has paused with the chat closed. Your task, tied to what's in front of " +
        "them: " + advanceLine + ". Warm, specific, " + askOrStatement +
        (signed ? "They are a signed-in patron; a small nod to that is welcome." :
        "They are an anonymous visitor.") + " Plain text only: no markdown, no quotation marks, no " +
        "{{tokens}}, no greeting boilerplate. Just the line." + bubbleVoice + houseClause +
        repeatGuard + bubbleBrief + beatNotesClause(data.config);
    }
    const started = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 160, system: sys,
        messages: [{ role: "user", content: "Write the line now." }],
        tools: [{
          name: "beat_line",
          description:
            "Deliver this outreach: speak the one line, or hold (show nothing). Silence is for when " +
            "there is truly NOTHING new and true left to offer.",
          input_schema: {
            type: "object",
            properties: {
              speak: { type: "boolean", description: "true = show the line; false = hold, show nothing" },
              line: { type: "string", description: "the single plain-text line (max 30 words) when speak is true" },
            },
            required: ["speak"],
          },
        }],
        tool_choice: { type: "tool", name: "beat_line" },
      }),
    });
    if (!res.ok) return fallback();
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    const tu = blocks.find((b: any) => b.type === "tool_use" && b.name === "beat_line");
    let speak = false;
    let text = "";
    if (tu && tu.input && typeof tu.input === "object") {
      speak = (tu.input as Record<string, unknown>).speak === true;
      const l = (tu.input as Record<string, unknown>).line;
      text = typeof l === "string" ? l : "";
    }
    text = stripPlumbing(text).replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 240);
    // A deliberate hold: nothing new to say. Distinct from the null fallback so
    // the client stays SILENT instead of showing its canned line. Audited like
    // every other held beat (action='beat_hold') so the hold-rate metric counts
    // bubbles too — the docs promise "every held beat is logged", and mean it.
    // (One terminal defense stays: an old saved override may still say "HOLD".)
    if (!speak || /^\W*hold\W*$/i.test(text)) {
      pgInsert("concierge_actions", {
        conversation_id: cid, user_id: customer?.id ?? null, email: customer?.email ?? null,
        action: "beat_hold", serial: null,
        payload: { kind: "bubble" },
        result: "beat held — nothing new to say",
      }).catch(() => { /* audit failures never break the outreach */ });
      return jsonResponse(req, 200, { text: null, hold: true });
    }
    if (text.length < 4) return fallback();

    // The reach-out judge — same gate as the panel beats (default ON, fail-
    // open). A vetoed bubble stays silent (hold, not the canned fallback) and
    // writes a beat_veto row with the killed line and the judge's reason.
    try {
      const oj = data.config?.outreach as Record<string, unknown> | undefined;
      if (oj?.beatJudge !== false) {
        const v = await judgeBeatLine(apiKey, text, postSale ? "bubble-postsale" : "bubble");
        if (v.veto) {
          pgInsert("concierge_actions", {
            conversation_id: cid, user_id: customer?.id ?? null, email: customer?.email ?? null,
            action: "beat_veto", serial: null,
            payload: { kind: "bubble", line: text, reason: v.reason || "vetoed by the reach-out judge", decision: bubbleAudit ?? undefined },
            result: "vetoed — " + (v.reason || "vetoed by the reach-out judge"),
          }).catch(() => { /* audit is best-effort */ });
          return jsonResponse(req, 200, { text: null, hold: true });
        }
      }
    } catch { /* fail-open — the line still goes out */ }

    // Persist the outreach line so the conversation log stays COMPLETE. The
    // shopper sees this in the closed-panel bubble, and — for a signed-in patron
    // — it can carry a HOUSE-NOTE delivery. Until now this line was returned but
    // never written to concierge_messages, so a note delivered here vanished from
    // the transcript. Attach it to the live conversation; if a house instruction
    // was woven in but no conversation exists yet, open one so the delivery is
    // never lost, then reconcile the note (this beat has no tools, same as an
    // opener). Best-effort: logging must never break the outreach line itself.
    try {
      const deliversHouseNote = !!houseClause && !!customer;
      if (!cid && deliversHouseNote && customer) {
        const row = await pgInsert<{ id: string }>("concierge_conversations", {
          session_key: sessionKey || null,
          user_id: customer.id,
          user_email: customer.email,
          section: section ? section.slice(0, 64) : null,
        });
        cid = row?.id ?? null;
      }
      if (cid) {
        await logAssistantTurn(cid, text, model, Date.now() - started);
        if (deliversHouseNote && customer) {
          scheduleDirectiveReconcile(
            cid, customer,
            [{ role: "user", content: "(re-engagement outreach — closed-panel bubble)" }],
            text, apiKey, model,
          );
        }
      }
      // The bubble SPOKE its decided action — the audit row makes it spent
      // for 24h and diagnosable (ledger + rule trace) in the Actions tab.
      if (bubbleAudit && customer) {
        pgInsert("concierge_actions", {
          conversation_id: cid, user_id: customer.id, email: customer.email,
          action: "beat_action", serial: null,
          payload: { ...bubbleAudit, outcome: "spoke" },
          result: String(bubbleAudit.action ?? ""),
        }).catch(() => { /* audit is best-effort */ });
      }
    } catch { /* logging is best-effort; the shopper still gets their line */ }

    return jsonResponse(req, 200, { text });
  } catch { return fallback(); }
}

// ── POST ?track=1 — funnel beacon (visit / chat_open / checkout_open) ────────
// The behavioral top of the conversion funnel (ATTRIBUTION.md): page loaded,
// concierge panel opened, register sheet opened (via = concierge|page).
// PII-free by design — a random visit token, no IP stored, no identity.
// Rate-limited per caller; ALWAYS answers 204 so a beacon can never break the
// page or reveal validation behavior.
const TRACK_KINDS = new Set(["visit", "chat_open", "checkout_open"]);
const TRACK_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
async function handleTrackPost(req: Request): Promise<Response> {
  const done = () => new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    if (await rateLimited("tk:" + ip, 120)) return done();
    const body = await req.json() as Record<string, unknown>;
    const kind = typeof body.kind === "string" && TRACK_KINDS.has(body.kind) ? body.kind : null;
    const vk = typeof body.visit_key === "string" && TRACK_KEY_RE.test(body.visit_key) ? body.visit_key : null;
    if (!kind || !vk) return done();
    const sk = typeof body.session_key === "string" && TRACK_KEY_RE.test(body.session_key) ? body.session_key : null;
    const section = typeof body.section === "string" && /^[a-z0-9_-]{1,32}$/i.test(body.section) ? body.section : null;
    const via = body.via === "concierge" || body.via === "page" ? body.via : null;
    await pgInsert("site_events", {
      kind, visit_key: vk, session_key: sk, section,
      via: kind === "checkout_open" ? via : null,
    });
  } catch { /* a beacon never errors */ }
  return done();
}

// ── POST ?prune=1 — run the retention prune (admin-only, deliberate) ─────────
// The ONLY path that deletes history: prune_high_write(p_days) removes
// conversations/actions/site_events/email logs older than the horizon; orders
// and their attribution stamps survive. Nothing is scheduled by default —
// this is the merchant's explicit act from Edition & access → Data retention.
async function handlePrunePost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const days = typeof body.days === "number" && Number.isFinite(body.days) ? Math.floor(body.days) : NaN;
  if (!(days >= 30)) return jsonError(req, 400, "Horizon must be at least 30 days.");
  const result = await pgRpc<Record<string, unknown>>("prune_high_write", { p_days: days });
  if (!result) return jsonError(req, 502, "The prune did not run — check the function logs.");
  return jsonResponse(req, 200, { result });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method === "POST" && new URL(req.url).searchParams.get("track")) {
    return await handleTrackPost(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("prune")) {
    return await handlePrunePost(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("config")) {
    return await handleConfigGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("site")) {
    return await handleSiteGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("tools")) {
    return await handleToolsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("defaults")) {
    return await handleDefaultsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("preview")) {
    return await handlePreviewGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("models")) {
    return await handleModelsGet(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("promptreview")) {
    return await handlePromptReviewPost(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("starters")) {
    return await handleStartersGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("evals")) {
    return await handleEvalsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("secrets")) {
    return await handleSecretsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("export")) {
    return await handleExportGet(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("regrade")) {
    return await handleRegradePost(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("consolidate")) {
    return await handleConsolidatePost(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("judge")) {
    return await handleJudgePost(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("lint")) {
    return await handleLintPost(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("selftest")) {
    return await handleSelfTest(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("cachecheck")) {
    // Admin-only: this diagnostic WRITES (insert+delete a probe row) and runs an
    // embedding, so leaving it unauthenticated is a write/compute-amplification
    // surface. It has no client caller — it's a manual health check.
    if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
    // Self-diagnosis: run the semantic cache's WHOLE round trip — embed a
    // probe, write it, semantically match it back, delete it — and report
    // which step fails, with the raw error. Exposes no data beyond counts.
    const report: Record<string, unknown> = {};
    const v = await embed("a quiet diagnostic sentence for the register");
    report.embed = v ? `ok (${v.length} dims)` : "FAILED — see concierge_flags for detail";
    if (v) {
      // write
      let probeId: string | null = null;
      try {
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/concierge_cache`, {
          method: "POST",
          headers: { ...PG_HEADERS, "Prefer": "return=representation" },
          body: JSON.stringify({
            question: "(diagnostic probe)", answer_md: "(probe)",
            embedding: vecLiteral(v), model: "probe",
          }),
        });
        if (ins.ok) {
          const rows = await ins.json() as Array<{ id: string }>;
          probeId = rows[0]?.id ?? null;
          report.write = probeId ? "ok" : "FAILED — insert returned no row";
        } else {
          report.write = `FAILED — ${ins.status}: ${(await ins.text()).slice(0, 200)}`;
        }
      } catch (e) {
        report.write = `FAILED — ${e instanceof Error ? e.message : String(e)}`;
      }
      // match
      if (probeId) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cached_answer`, {
            method: "POST",
            headers: PG_HEADERS,
            body: JSON.stringify({ query_embedding: vecLiteral(v), match_threshold: 0.9 }),
          });
          if (res.ok) {
            const hits = await res.json() as Array<{ id: string }>;
            report.match = hits.some((h) => h.id === probeId)
              ? "ok — probe matched itself"
              : `unexpected — ${hits.length} row(s), probe not among them`;
          } else {
            report.match = `FAILED — ${res.status}: ${(await res.text()).slice(0, 200)}`;
          }
        } catch (e) {
          report.match = `FAILED — ${e instanceof Error ? e.message : String(e)}`;
        }
        // clean up the probe
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/concierge_cache?id=eq.${probeId}`, {
            method: "DELETE", headers: PG_HEADERS,
          });
        } catch { /* a stray probe row is visible in the Studio and deletable */ }
      }
    }
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/concierge_cache?select=id`,
        { headers: { ...PG_HEADERS, "Prefer": "count=exact", "Range": "0-0" } },
      );
      const range = res.headers.get("content-range") ?? "";
      const total = parseInt(range.split("/")[1] ?? "", 10);
      report.cache_rows = Number.isFinite(total) ? total : "unknown";
    } catch { report.cache_rows = "unknown"; }
    report.note =
      "cache engages only for anonymous (signed-out) visitors' first question of a conversation";
    return jsonResponse(req, 200, report);
  }
  if (req.method !== "POST") return jsonError(req, 405, "Method not allowed. Use POST, or GET ?config=1.");
  if (new URL(req.url).searchParams.get("wrapup")) return await handleWrapup(req);
  if (new URL(req.url).searchParams.get("reengage")) return await handleReengage(req);
  if (new URL(req.url).searchParams.get("form")) return await handleFormPost(req);
  return await handleChatPost(req);
});
