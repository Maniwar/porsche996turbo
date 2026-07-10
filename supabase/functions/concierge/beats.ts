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
    fail("KEEP_WARM", `already gave the '${l.section || "page"}' expertise line in the last 24h`);
  } else {
    return pick(
      warmKey,
      `every sales door is spent or resting — GIVE FIRST instead of going quiet: one small, unasked piece of true house expertise keyed to the '${
        l.section || "page"
      }' section (a care fact, the provenance, the box, the mending promise), warm and brief, no ask, no selling`,
    );
  }

  trace.push("HOLD: no rule qualified — nothing new and true to say");
  return { action: "HOLD", detail: "every qualified subject is spent or absent", trace };
}
