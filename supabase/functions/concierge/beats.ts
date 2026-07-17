// beats.ts — the PURE half of the proactive-beat brain: the Sales Ledger types,
// the Action Table (chooseBeatAction), and the small text detectors the beat
// paths share. No I/O, no Deno APIs — this module is imported by index.ts and
// unit-tested directly by beats_test.ts (the deploy workflow runs `deno test`
// before anything ships, so the table's ordering, cool-offs, and detectors are
// PROVABLE, not vibes).

export interface SalesLedger {
  totalOrders: number;
  placed: number;
  weaving: number;
  delivered: number;
  lastOrderDays: number | null;
  blockedSerials: number[]; // placeholder/test addresses — real service anomaly
  postSaleWindow: boolean; // recently bought → companion/gift territory
  goalUnmetSlug: string | null;
  goalUnmetLabel: string | null;
  pendingAsk: boolean;
  section: string;
  /** Action names spoken in the last 24h (kept readable in the audit payload). */
  spentActions: string[];
  /** Full spoken-action log over the cool-off lookback (~30d), newest first. */
  spentLog: { action: string; at: number }[];
  /** Newest order or client-book note (ms) — new information re-opens a resting
   * proposal early: persistence with a NEW reason is service, the same ask on a
   * timer is pestering. */
  newestInfoAt: number | null;
  /** Kept orders per colorway — lets a companion proposal name a cloth they do
   * NOT yet have instead of guessing. Optional: absent reads as unknown. */
  byCloth?: Record<string, number>;
  /** The newest 1–2 client-book snippets — colour for WHICH cloth or WHOM a
   * gift suits. The book itself stays INVISIBLE to the shopper: the brief that
   * carries these must also carry the never-reveal reminder. */
  bookFacts?: string[];
  /** Consecutive held beats on THIS conversation, newest backwards (the
   * engine counts trailing beat_hold rows). 3+ means the well is dry — the
   * graceful close's trigger. Absent (bubble path) reads as 0. */
  heldStreak?: number;
  /** Beats (spoken OR held) since the visitor's last message. Spoken lines
   * they ignored are as dry a signal as silent holds: 4+ also triggers the
   * graceful close. Absent reads as 0. */
  unansweredBeats?: number;
}

export interface BeatDecision {
  action: string;
  detail: string;
  trace: string[];
}

export const PLACEHOLDER_ADDR = /\b(fake|test|placeholder|sample|asdf|xxx)\b/i;

/** Escalating rest for a REPEATED proposal: after the 1st unanswered proposal
 * the subject rests 24h, after the 2nd 3 days, after the 3rd+ a week. The
 * merchant tunes the ladder (outreach.proposalRestHours); a new order or book
 * note always re-opens it early. */
export const DEFAULT_PROPOSAL_REST_HOURS = [24, 72, 168];

export function proposalRestHoursFrom(outreach: unknown): number[] {
  const o = outreach as Record<string, unknown> | undefined;
  const raw = o?.proposalRestHours;
  if (Array.isArray(raw)) {
    const hours = raw.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (hours.length) return hours;
  }
  return DEFAULT_PROPOSAL_REST_HOURS;
}

function fmtRest(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Cool-off gate for proposal-type rules. Returns ok=true when the rule may
 * fire; otherwise why explains the rest, for the audit trace. */
export function proposalGate(
  action: string,
  l: SalesLedger,
  restHours: number[],
  nowMs: number,
): { ok: boolean; why: string } {
  const rows = l.spentLog.filter((r) => r.action === action);
  if (!rows.length) return { ok: true, why: "" };
  const lastAt = rows.reduce((m, r) => Math.max(m, r.at), 0);
  if (l.newestInfoAt !== null && l.newestInfoAt > lastAt) {
    return {
      ok: true,
      why: "re-opened early — new information (an order or book note) since the last proposal",
    };
  }
  const idx = Math.min(rows.length - 1, restHours.length - 1);
  const restMs = Math.max(0, restHours[idx]) * 3600000;
  if (nowMs - lastAt >= restMs) return { ok: true, why: "" };
  const until = new Date(lastAt + restMs).toISOString().slice(0, 16).replace("T", " ");
  return {
    ok: false,
    why: `in cool-off — proposed ${rows.length}× before, rests ${
      fmtRest(restHours[idx])
    } (until ${until} UTC); a new order or book note re-opens it early`,
  };
}

/** A question is pending if ANY line of the trailing assistant run carries a
 * question mark — not only when a line ENDS in one. "Shall I open the
 * register? The Loden suits it." is still an open question. */
export function hasPendingAsk(trailingRunLines: string[]): boolean {
  return trailingRunLines.some((l) => typeof l === "string" && l.includes("?"));
}

/** Extract the concrete SUBJECTS from recent assistant lines — serial numbers,
 * colorways, and the recurring proposal themes — so the spent-subject contract
 * keys on structure instead of a lossy 140-char prefix. */
export function extractSubjects(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  };
  for (const line of lines) {
    if (typeof line !== "string") continue;
    for (const m of line.matchAll(/N[ºo°]\s?([\d][\d,.]*)/gi)) {
      push("Nº " + m[1].replace(/[.,]$/, ""));
    }
    for (const m of line.matchAll(/\b(Loden|Graphit|Ungef[aä]rbt)\b/gi)) {
      push(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
    }
    if (/\bgift\b/i.test(line)) push("the gift proposal");
    if (/\bcompanion\b/i.test(line)) push("the companion-cloth proposal");
    if (/\baddress\b/i.test(line)) push("the address subject");
    if (/\{\{action:signin\}\}|\bsign(?:ing)?[ -]?in\b/i.test(line)) {
      push("the sign-in invitation");
    }
  }
  return out;
}

export interface ChooseOpts {
  restHours?: number[];
  nowMs?: number;
  /** How the give-first/presence beat engages when no sale action qualifies:
   *  'expertise' (default) hands over a piece of house knowledge — right for a
   *  repeat-purchase clientele; 'offer' invites the shopper to SEE or ARRANGE
   *  one concrete thing the page offers (a photo, a video, the documents, a
   *  viewing, an offer) — right for a single-item INQUIRY page, where reciting
   *  facts reads as "inventorying the shopper" and gets vetoed. Set per site via
   *  config.outreach.proactive_style. */
  proactiveStyle?: "expertise" | "offer";
}

/** The Action Table: ordered rules over the ledger. Admin can disable rules
 * via config.beat_actions = { RULE: { enabled: false } } (versioned like every
 * config key). Returns the ONE action this beat performs — or HOLD.
 *
 * KEEP_WARM sits above HOLD by design: when every sales action is spent or
 * resting, the honest move is still PRESENCE — one small, unasked piece of true
 * house expertise (give-first) — not silence. The merchant's live feedback:
 * "too much silence, not enough attempts to engage." Silence is reserved for
 * when even the give-first door was already opened this day on this section. */
export function chooseBeatAction(
  l: SalesLedger,
  overrides: Record<string, { enabled?: boolean }> | undefined,
  opts?: ChooseOpts,
): BeatDecision {
  const now = opts?.nowMs ?? Date.now();
  const restHours = opts?.restHours ?? DEFAULT_PROPOSAL_REST_HOURS;
  const offerFirst = opts?.proactiveStyle === "offer";
  const trace: string[] = [];
  const enabled = (k: string) => !(overrides && overrides[k] && overrides[k].enabled === false);
  const spent = (k: string) => l.spentActions.includes(k);
  const pick = (action: string, detail: string): BeatDecision => {
    trace.push(`${action}: SELECTED`);
    return { action, detail, trace };
  };
  const fail = (k: string, why: string) => trace.push(`${k}: ${why}`);

  // Register colour for the proposal briefs: what they already hold (so a
  // companion names a cloth they do NOT have) and the freshest book facts (so
  // the suggestion fits their life) — with the never-reveal reminder attached,
  // because the client book must never read back as surveillance.
  const clothNote = (() => {
    const parts = Object.entries(l.byCloth ?? {})
      .filter(([, n]) => typeof n === "number" && n > 0)
      .map(([c, n]) => `${n}× ${c}`);
    return parts.length
      ? ` They hold ${parts.join(", ")} — name a colorway they do NOT yet have, for a different room.`
      : "";
  })();
  const bookNote = (l.bookFacts && l.bookFacts.length)
    ? ` The client book notes: ${
      l.bookFacts.map((f) => `"${f}"`).join("; ")
    } — let this shape which cloth or whom it suits, but NEVER quote, cite, or reveal the book itself: knowledge worn lightly, as a good clerk would.`
    : "";

  if (!enabled("FIX_BLOCKED_ORDER")) fail("FIX_BLOCKED_ORDER", "disabled by admin");
  else if (!l.blockedSerials.length) {
    fail("FIX_BLOCKED_ORDER", "no placed order carries a placeholder address");
  } else if (spent("FIX_BLOCKED_ORDER")) {
    fail("FIX_BLOCKED_ORDER", "already raised in the last 24h");
  } else {
    return pick(
      "FIX_BLOCKED_ORDER",
      `Nº ${
        l.blockedSerials.join(", Nº ")
      } still carry placeholder addresses — offer ONCE to take the real ones before the loom starts`,
    );
  }

  if (!enabled("PROPOSE_COMPANION")) fail("PROPOSE_COMPANION", "disabled by admin");
  else if (!l.totalOrders) fail("PROPOSE_COMPANION", "no kept orders");
  else if (!l.postSaleWindow) fail("PROPOSE_COMPANION", "outside the post-sale window");
  else {
    const gate = proposalGate("PROPOSE_COMPANION", l, restHours, now);
    if (!gate.ok) fail("PROPOSE_COMPANION", gate.why);
    else {
      if (gate.why) trace.push(`PROPOSE_COMPANION: ${gate.why}`);
      return pick(
        "PROPOSE_COMPANION",
        "they bought recently — invite a companion cloth for ANOTHER room (never re-sell the one they have)." +
          clothNote + bookNote,
      );
    }
  }

  if (!enabled("PROPOSE_GIFT")) fail("PROPOSE_GIFT", "disabled by admin");
  else if (!l.totalOrders) fail("PROPOSE_GIFT", "no kept orders");
  else {
    const gate = proposalGate("PROPOSE_GIFT", l, restHours, now);
    if (!gate.ok) fail("PROPOSE_GIFT", gate.why);
    else {
      if (gate.why) trace.push(`PROPOSE_GIFT: ${gate.why}`);
      return pick(
        "PROPOSE_GIFT",
        "invite a blanket sent as a GIFT — the register card can carry another name." + bookNote,
      );
    }
  }

  if (!l.goalUnmetSlug) fail("ADVANCE_GOAL", "no unmet goal");
  else if (!enabled("ADVANCE_GOAL")) fail("ADVANCE_GOAL", "disabled by admin");
  else if (spent("ADVANCE_GOAL:" + l.goalUnmetSlug)) {
    fail("ADVANCE_GOAL", `goal '${l.goalUnmetSlug}' already advanced in the last 24h`);
  } else {
    return pick(
      "ADVANCE_GOAL:" + l.goalUnmetSlug,
      `advance this open goal, tied to the '${l.section || "page"}' section: ${l.goalUnmetLabel}`,
    );
  }

  // Give-first presence: every sales action is spent or resting, but silence
  // is not the only honest option — one small, unasked piece of TRUE house
  // expertise (care, provenance, the box, the mending promise) keyed to where
  // they are reading. Once per section per day; never an ask.
  const warmKey = "KEEP_WARM:" + (l.section || "page");
  if (!enabled("KEEP_WARM")) fail("KEEP_WARM", "disabled by admin");
  else if (spent(warmKey)) {
    fail("KEEP_WARM", `already gave the '${l.section || "page"}' ${offerFirst ? "offer-to-show line" : "expertise line"} in the last 24h`);
  } else {
    // Two presence styles. 'offer' (inquiry pages) invites the shopper to SEE or
    // ARRANGE something concrete — never recites facts AT them, which is exactly
    // the "inventorying the shopper" pattern the reach-out judge vetoes.
    const warmDetail = offerFirst
      ? `keep this shopper engaged OFFER-FIRST, not by reciting anything: invite them to SEE or ARRANGE one concrete thing — a specific photo or detail to look at, a video ONLY if one is registered, an in-person viewing, or making an offer — keyed to the '${
        l.section || "page"
      }' section. Name ONE and offer to show or arrange it. ONLY offer what the house has actually made shareable here: NEVER promise a document, image, record, or file (a CARFAX, service invoices, a PDF) is "ready to share" unless it is genuinely available to send in this chat — offering something that isn't set up is a false promise. NEVER recite specs, history, or the shopper's own data back at them, and never tally what is on file; offer to reveal it instead. Warm, brief, one light invitation, no pressure.`
      : `every sales door is spent or resting — GIVE FIRST instead of going quiet: one small, unasked piece of true house expertise keyed to the '${
        l.section || "page"
      }' section (a care fact, the provenance, the box, the mending promise), warm and brief, no ask, no selling. ONLY a fact the house's own knowledge sections actually state — NEVER write care, washing, temperature, or durability instructions from general wool knowledge; if the house's knowledge is silent here, speak to provenance or the box instead, or hold`;
    return pick(warmKey, warmDetail);
  }

  // The graceful close: several beats in a row have held with nothing new —
  // an endless silent vigil reads as absence, not restraint. One warm goodbye
  // that leaves the door open, once per day, then true silence. (The engine
  // may pair this moment with the closing survey — the NPS gate treats a dry
  // conversation as concluded, with all its other guards intact.)
  const dryWell = (l.heldStreak ?? 0) >= 3 || (l.unansweredBeats ?? 0) >= 4;
  if (!enabled("GRACEFUL_CLOSE")) fail("GRACEFUL_CLOSE", "disabled by admin");
  else if (!dryWell) {
    fail("GRACEFUL_CLOSE", `${l.heldStreak ?? 0} consecutive hold(s), ${l.unansweredBeats ?? 0} beat(s) since their last word — the well is not dry yet`);
  } else if (spent("GRACEFUL_CLOSE")) {
    fail("GRACEFUL_CLOSE", "already said goodbye in the last 24h — now silence really is the answer");
  } else {
    return pick(
      "GRACEFUL_CLOSE",
      "the conversation has run dry — close warmly and briefly: thank them for their time, " +
        "say the door stays open and you're here whenever they come back. No ask, no selling, " +
        "no recap of what was discussed. One or two short sentences.",
    );
  }

  trace.push("HOLD: no rule qualified — nothing new and true to say");
  return { action: "HOLD", detail: "every qualified subject is spent or absent", trace };
}

// ── Coach feedback loop — presentation of the "what's landing" digest ────────
// The pure half of the loop (COACH.md §5): turn the raw beat_learning_digest
// jsonb into the private "WHAT'S LANDING LATELY" block the coach weighs — or ""
// when the sample is too thin to be honest signal (a fresh house gets no
// fabricated pattern). Kept here, pure, so it is unit-tested; the DB read lives
// in index.ts (beatLearningBlock).
export interface LearningBucket {
  beat?: string;
  move?: string;
  n?: number;
  reply_rate?: number;
}
export interface LearningDigest {
  window_days?: number;
  total_spoke?: number;
  buckets?: LearningBucket[];
}

export function renderLearningDigest(
  digest: LearningDigest | null | undefined,
  minSpoke = 8,
): string {
  if (!digest || typeof digest !== "object") return "";
  const buckets = Array.isArray(digest.buckets) ? digest.buckets : [];
  const totalSpoke = typeof digest.total_spoke === "number" ? digest.total_spoke : 0;
  // Honest about thin data: below the floor, or with no surviving buckets, the
  // coach gets nothing and falls back to method-only.
  if (totalSpoke < minSpoke || buckets.length === 0) return "";
  const lines = buckets.slice(0, 6).map((b) => {
    const pct = Math.round((Number(b.reply_rate) || 0) * 100);
    return "- " + String(b.move ?? "?") + " on a " + String(b.beat ?? "?") +
      ": " + pct + "% replied (n=" + (Number(b.n) || 0) + ")";
  });
  return "[WHAT'S LANDING LATELY — this house's OWN outcomes over the last " +
    (digest.window_days ?? 14) + " days: the share of shoppers who answered within " +
    "half an hour of each kind of proactive line. This is real reaction, not theory.]\n" +
    lines.join("\n") +
    "\nWeigh it: lean toward the moves that are landing and away from the ones that " +
    "aren't; treat a small n as a weak signal, never a rule. Silence after a move is " +
    "itself a signal — if a move keeps getting ignored, a lighter touch (or holding) may beat repeating it.";
}

// ── NPS — survey trigger, score math, and the customer brief ─────────────────
// Pure so the survey TRIGGER and the SCORE CALCULATION are unit-tested
// (beats_test.ts) — the DB reads/writes, the LLM categorisation, and the beat
// wiring live in index.ts. See NPS.md. The design point: the survey is a beat
// (fire once, at a natural close, gated), and the closed loop reuses the same
// coach/judge/digest machinery as the sales coach.

/** Does an active conversation starter feed this unanswerable question?
 * Order-free token overlap on meaningful words: the gap must share >=60% of
 * its meaningful tokens with the starter, and at least two words (or all of
 * a one/two-word gap). Pure, so Tier-0 starter retirement is provable —
 * a starter is never retired on vibes. */
const STARTER_SMALLS = new Set([
  "the", "and", "are", "for", "you", "your", "what", "how", "that",
  "this", "with", "about", "can", "does", "will", "there", "its",
]);
export function starterFeedsGap(starter: string, gapQ: string): boolean {
  const toks = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STARTER_SMALLS.has(w)));
  const g = toks(gapQ);
  const st = toks(starter);
  if (g.size === 0 || st.size === 0) return false;
  let hit = 0;
  for (const w of g) if (st.has(w)) hit++;
  if (hit / g.size < 0.6) return false;
  return hit >= 2 || (g.size <= 2 && hit === g.size);
}

/** The exact-match key for a baked starter answer: casefolded, whitespace
 * collapsed, trailing punctuation dropped — so the tap, a retyped copy, and
 * the pinned row all agree. Pure and mirrored nowhere: every writer and
 * reader calls THIS. */
export function normalizeQuestionKey(q: string): string {
  return String(q ?? "").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/[\s?.!…]+$/u, "");
}

export type NpsSegment = "promoter" | "passive" | "detractor";

/** Standard NPS banding: 9–10 promoter, 7–8 passive, 0–6 detractor. */
export function npsSegment(score: number): NpsSegment {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

/**
 * The Net Promoter Score: %promoters − %detractors on a −100..100 scale,
 * rounded. Passives count in the denominator but NEVER the numerator — that is
 * the whole point of the metric. Returns null for an empty set: no responses is
 * not a score of zero, and the difference must stay visible (honest about
 * absence, like renderLearningDigest). Out-of-range scores are ignored.
 */
export function npsScore(scores: number[]): number | null {
  const valid = scores.filter((s) => Number.isFinite(s) && s >= 0 && s <= 10);
  if (valid.length === 0) return null;
  let prom = 0, det = 0;
  for (const s of valid) {
    const seg = npsSegment(s);
    if (seg === "promoter") prom++;
    else if (seg === "detractor") det++;
  }
  return Math.round(((prom - det) / valid.length) * 100);
}

/**
 * Survey RESPONSE RATE — responses ÷ offers, as a whole percent. Null (never a
 * fake 0%) when nothing was offered. Deliberately uncapped: more responses
 * than offers is a data anomaly the dashboard should show, not hide.
 * nps_metrics() in setup.sql mirrors this formula.
 */
export function npsResponseRate(offered: number, responded: number): number | null {
  if (!Number.isFinite(offered) || offered <= 0) return null;
  const r = Number.isFinite(responded) ? Math.max(0, responded) : 0;
  return Math.round((r / offered) * 100);
}

export interface NpsTriggerState {
  enabled: boolean;
  concluded: boolean;              // a natural end reached (order placed / goal met / wrap-up / "that's all")
  alreadySurveyedSession: boolean; // an nps_responses row / offer already exists for this conversation
  sessionDurationMs: number;
  minDurationMs: number;
  lastSurveyedAtMs: number | null; // this customer's most recent submission (any session)
  cooldownMs: number;
  nowMs: number;
}

/**
 * Whether to offer the NPS survey now. A pure gate with the same discipline as
 * proposalGate: fire ONCE, only at a natural close, only for a session worth
 * rating, and never inside the per-customer cooldown. Returns a reason either
 * way so the decision is auditable.
 */
export function npsTriggerGate(s: NpsTriggerState): { ask: boolean; reason: string } {
  if (!s.enabled) return { ask: false, reason: "nps survey disabled" };
  if (s.alreadySurveyedSession) return { ask: false, reason: "already offered this session" };
  if (!s.concluded) return { ask: false, reason: "session not at a natural close" };
  if (s.sessionDurationMs < Math.max(s.minDurationMs, 0)) {
    return { ask: false, reason: "session too short to be worth rating" };
  }
  if (s.lastSurveyedAtMs != null && s.cooldownMs > 0 &&
      s.nowMs - s.lastSurveyedAtMs < s.cooldownMs) {
    return { ask: false, reason: "within the per-customer cooldown" };
  }
  return { ask: true, reason: "session concluded and eligible" };
}

/**
 * What a tapped score should DO (NPS.md — "changing a rating"): revise this
 * conversation's own row, revise the customer's recent row, insert a fresh
 * response — or IGNORE the tap. Revisions are only honored inside the
 * admin-configurable window (`outreach.nps.reviseDays`, 0 = ratings are
 * final); a tap inside the cooldown but past the window writes nothing — it
 * can be neither a correction (window over) nor a new response (the gate
 * never offers inside the cooldown), so a duplicate rating from one person
 * is structurally impossible.
 */
export function npsCaptureAction(s: {
  conversationRowAgeMs: number | null; // null = no row on this conversation
  lastCustomerRowAgeMs: number | null; // null = anonymous, or no prior row
  cooldownMs: number;
  reviseMs: number;                    // 0 = ratings are final once given
}): "revise-conversation" | "revise-recent" | "insert" | "ignore" {
  if (s.conversationRowAgeMs != null) {
    return (s.reviseMs > 0 && s.conversationRowAgeMs < s.reviseMs) ? "revise-conversation" : "ignore";
  }
  if (s.lastCustomerRowAgeMs != null && s.cooldownMs > 0 && s.lastCustomerRowAgeMs < s.cooldownMs) {
    return (s.reviseMs > 0 && s.lastCustomerRowAgeMs < s.reviseMs) ? "revise-recent" : "ignore";
  }
  return "insert";
}

export interface NpsCategoryHit { slug: string; confidence?: number; }

export interface NpsAnalystItem {
  score: number;
  segment?: string;              // derived from the score when absent
  reason?: string | null;        // the customer's own words
  categories?: NpsCategoryHit[];
  transcript?: string[];         // pre-formatted "visitor:/concierge:" lines
  when?: string;                 // ISO date (day precision is enough)
}

/**
 * The analyst's evidence pack — REAL rated sessions rendered for the report
 * writer (the ?npsreport=1 conversational-analytics endpoint). Detractors
 * lead (they carry the actionable signal), then passives, then promoters.
 * Hard caps on sessions and characters keep the model call bounded, and the
 * honesty floor returns '' below minResponses — a report on two data points
 * is an invention, not an analysis.
 */
export function npsAnalystCorpus(
  items: NpsAnalystItem[],
  opts?: { maxSessions?: number; maxChars?: number; minResponses?: number },
): string {
  const o = { maxSessions: 24, maxChars: 24000, minResponses: 3, ...(opts ?? {}) };
  const valid = (items ?? []).filter((i) => i && Number.isFinite(i.score) && i.score >= 0 && i.score <= 10);
  if (valid.length < o.minResponses) return "";
  const rank: Record<string, number> = { detractor: 0, passive: 1, promoter: 2 };
  const segOf = (i: NpsAnalystItem) =>
    (i.segment && rank[i.segment] !== undefined) ? i.segment : npsSegment(i.score);
  const sorted = [...valid].sort((a, b) => rank[segOf(a)] - rank[segOf(b)]);
  const parts: string[] = [];
  let used = 0, n = 0;
  for (const it of sorted) {
    if (n >= o.maxSessions) break;
    const cats = (it.categories ?? []).map((c) => c && c.slug).filter(Boolean).join(", ");
    const lines = [
      `SESSION ${n + 1} — ${it.score}/10 (${segOf(it)})${it.when ? " · " + it.when : ""}`,
      it.reason
        ? `their reason: "${String(it.reason).slice(0, 300)}"`
        : "their reason: (none given)",
      cats ? `categories: ${cats}` : "",
      ...(it.transcript ?? []).slice(0, 12).map((l) => "  " + String(l).slice(0, 240)),
    ].filter(Boolean);
    const block = lines.join("\n");
    if (used + block.length > o.maxChars) break;
    parts.push(block);
    used += block.length;
    n++;
  }
  if (n < o.minResponses) return "";
  return parts.join("\n\n");
}
export interface NpsHistoryItem {
  score: number;
  categories?: NpsCategoryHit[];
  submittedAtMs?: number;
}

/**
 * The actionable half — DETRACTOR REASONS: tally the themes behind
 * less-than-promoter scores (detractors AND passives), most frequent first.
 * This is the "why are they unhappy" signal the coach brief and the dashboards
 * lean on; promoter mentions are excluded so praise never dilutes the concerns.
 */
export function detractorThemes(history: NpsHistoryItem[]): Array<{ slug: string; n: number }> {
  const counts = new Map<string, number>();
  for (const h of history) {
    if (!h || !Array.isArray(h.categories)) continue;
    if (npsSegment(h.score) === "promoter") continue; // only the concerning ones
    for (const c of h.categories) {
      if (!c || typeof c.slug !== "string" || !c.slug) continue;
      counts.set(c.slug, (counts.get(c.slug) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([slug, n]) => ({ slug, n }))
    .sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug));
}

/**
 * The private, judge-guarded NPS brief the concierge/coach sees for ONE
 * customer (their own history). Leads with segment + trend, then the recurring
 * concerns to address, then a forward-looking play. Empty when the history is
 * too thin to be honest (mirrors renderLearningDigest). Carries the
 * never-quote discipline: the score itself must never be echoed back at the
 * customer — the reach-out judge vetoes scorekeeping, and this is the
 * source-side guard that pairs with it.
 */
export function renderCustomerNps(history: NpsHistoryItem[], minResponses = 1): string {
  const clean = (Array.isArray(history) ? history : [])
    .filter((h) => h && Number.isFinite(h.score) && h.score >= 0 && h.score <= 10);
  if (clean.length < Math.max(minResponses, 1)) return "";
  const ordered = [...clean].sort((a, b) => (a.submittedAtMs ?? 0) - (b.submittedAtMs ?? 0));
  const latest = ordered[ordered.length - 1];
  const prior = ordered.length >= 2 ? ordered[ordered.length - 2] : null;
  const seg = npsSegment(latest.score);
  const rolling = npsScore(ordered.map((h) => h.score));
  let trend = "steady";
  if (prior) {
    if (latest.score > prior.score) trend = "improving";
    else if (latest.score < prior.score) trend = "declining";
  }
  const themes = detractorThemes(ordered).slice(0, 3);
  const lines: string[] = [
    "[NPS — this customer's OWN feedback history. Private: shape your approach with it, " +
    "but NEVER quote a past score, rating, or survey back at them.]",
    `standing: ${seg.toUpperCase()} · latest ${latest.score}/10 (${trend})` +
      (rolling != null && ordered.length > 1 ? ` · rolling NPS ${rolling} over ${ordered.length}` : ""),
  ];
  if (themes.length) {
    lines.push("recurring concerns: " +
      themes.map((t) => `${t.slug}${t.n > 1 ? ` (${t.n}×)` : ""}`).join(", "));
  }
  if (seg === "detractor") {
    lines.push("play it forward: rebuild trust — address the concern proactively, don't defend the score.");
  } else if (seg === "passive") {
    lines.push("play it forward: one genuine improvement on the concern could move them to a promoter.");
  } else {
    lines.push("play it forward: a happy patron — a light, well-timed referral or companion invitation is welcome.");
  }
  return "\n\n" + lines.join("\n");
}
