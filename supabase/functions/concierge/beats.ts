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
  /** True when the graceful close (or the survey that rode it) has SPOKEN
   * since the visitor's last word. The latch: every proactive rule holds —
   * the goodbye stands until they return and a fresh case reopens the
   * floor. Absent reads as false. */
  silenceLatched?: boolean;
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

/** Whether the visitor's last line is a WRAP-UP — either an explicit "I'm done"
 * (a clear signal even inside a longer sentence) or a BARE farewell/thanks that
 * stands alone. The closing survey rides a genuine goodbye, so a closing that
 * ALSO carries a fresh question ("thanks, but do you ship to Canada?") is NOT a
 * wrap-up: the trailing question re-opens the visit. A lone acknowledgement
 * ("ok", "great") is not a goodbye either — at least one real CLOSER (a thanks,
 * a farewell, an "all set") must be present. Pure and unit-tested so "why did
 * the survey (not) ask?" is a lookup, never a guess. */
export function isWrapUp(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;
  // Explicit conclusion — fires even inside a longer message.
  if (/\b(?:that'?s (?:all|it)(?: for now)?|all done|i'?m (?:all )?done(?: for now)?|nothing else|no more questions)\b/i.test(t)) {
    return true;
  }
  // A bare farewell/thanks only: the WHOLE (short) message is closing words and
  // it asks nothing new. A "?" or any non-closing content disqualifies it.
  if (t.length > 60 || t.includes("?")) return false;
  const ACK = "ok(?:ay)?|alright|all ?right|great|perfect|awesome|cool|wonderful|lovely|brilliant|nice|fab|fantastic|excellent|good";
  const CLOSER =
    "(?:thanks|thank you|thank u|thankyou|thx|ty)(?: so much| very much| a lot| again| heaps)?" +
    "|much appreciated|appreciate(?: it| that)?|appreciated" +
    "|bye+|goodbye|good bye|bye bye|see (?:you|ya)(?: later| around)?|catch you later|later|take care|cheers" +
    "|have a (?:good|great|nice)(?: one| day| night| evening| weekend)?" +
    "|(?:i'?m|im|we'?re|were)(?: all)? (?:good|set|done)|all set|all good|that'?ll be all|good for now" +
    "|no (?:thanks|thank you)|nope|nah";
  const sep = "[\\s,.!…—–-]";
  const re = new RegExp(`^(?:(?:${ACK})${sep}+)*(?:${CLOSER})(?:${sep}+(?:${ACK}|${CLOSER}))*${sep}*$`, "i");
  return re.test(t);
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
  // The goodbye stands. Once the close (or its survey) has spoken and the
  // visitor has not answered, nothing else may speak — not KEEP_WARM's fresh
  // daily budget, not a proposal, nothing. True silence until they return.
  if (l.silenceLatched) {
    trace.push("SILENCE_LATCH: the goodbye already spoke since their last word — every door held");
    return { action: "HOLD", detail: "the goodbye stands — silence until the visitor returns", trace };
  }
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
  blocked_total?: number; // reach-out lines the review judge KILLED in the window
  blocked_families?: { family?: string; n?: number }[]; // the top reasons they were killed
}

export function renderLearningDigest(
  digest: LearningDigest | null | undefined,
  minSpoke = 8,
): string {
  if (!digest || typeof digest !== "object") return "";
  const buckets = Array.isArray(digest.buckets) ? digest.buckets : [];
  const totalSpoke = typeof digest.total_spoke === "number" ? digest.total_spoke : 0;
  // The reply-rate block only when there's enough spoken data (below the floor it
  // would be noise). The BLOCKED block below is independent — it matters MOST when
  // little got spoken, because that can be review suppressing the voice.
  let replyBlock = "";
  if (totalSpoke >= minSpoke && buckets.length > 0) {
    const lines = buckets.slice(0, 6).map((b) => {
      const pct = Math.round((Number(b.reply_rate) || 0) * 100);
      return "- " + String(b.move ?? "?") + " on a " + String(b.beat ?? "?") +
        ": " + pct + "% replied (n=" + (Number(b.n) || 0) + ")";
    });
    replyBlock = "[WHAT'S LANDING LATELY — this house's OWN outcomes over the last " +
      (digest.window_days ?? 14) + " days: the share of shoppers who answered within " +
      "half an hour of each kind of proactive line. This is real reaction, not theory.]\n" +
      lines.join("\n") +
      "\nWeigh it: lean toward the moves that are landing and away from the ones that " +
      "aren't; treat a small n as a weak signal, never a rule. Silence after a move is " +
      "itself a signal — if a move keeps getting ignored, a lighter touch (or holding) may beat repeating it.";
  }
  // Veto-aware: a move the review judge keeps killing never SENDS, so it never earns
  // a reply rate — a weak signal above can be SUPPRESSION, not failure. Say so, or the
  // coach quietly abandons the house's own vivid selling for whatever survives review.
  const blocked = typeof digest.blocked_total === "number" ? digest.blocked_total : 0;
  const fams = Array.isArray(digest.blocked_families) ? digest.blocked_families : [];
  let blockedBlock = "";
  if (blocked > 0) {
    const famStr = fams.filter((f) => f && f.family).slice(0, 3)
      .map((f) => String(f.family) + " ×" + (Number(f.n) || 0)).join(", ");
    blockedBlock = "[REVIEW IS ALSO SUPPRESSING MOVES — in this window " + blocked +
      " proactive line" + (blocked === 1 ? "" : "s") + " were BLOCKED by the reviewer before any shopper saw them" +
      (famStr ? " (most often: " + famStr + ")" : "") +
      ". A blocked move is SUPPRESSED, not proof it fell flat: a weak reply rate on a vivid, grounded, TRUE " +
      "selling move can simply mean review kept killing it. Keep reaching for the real, vivid move — the " +
      "recommendation, the sensory picture, the ritual — don't retreat to safe questions because review has " +
      "been strict. If a whole family is over-blocked, that's a rulebook question for the owner, not a signal " +
      "that selling doesn't work here.]";
  }
  return [replyBlock, blockedBlock].filter(Boolean).join("\n\n");
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

/** The fill-in-the-blank knowledge draft for a gap the model could not
 * ground: only the visitors' own questions plus a blank for the house's
 * answer. Composed HERE, deterministically — never by the model — so an
 * ungrounded draft cannot contain an invented fact. */
/** The judge's defect families. 'invented'/'inventorying'/'plumbing' are
 * the ones a merchant might legitimately want to relax for their own house;
 * a floor never relaxes 'prefilter' (mechanical, always right) — it isn't
 * even offered. Mirror of the judge_findings RPC ladder. */
export type JudgeFamily =
  | "prefilter" | "inventorying" | "invented" | "plumbing"
  | "house_rules" | "etiquette" | "other";

/** Classify a judge veto reason into its defect family. Byte-for-byte the
 * same ladder (same order, same alternations) as the judge_findings RPC —
 * the floor must never disagree with the report about what a block WAS. */
export function classifyJudgeReason(reason: string): JudgeFamily {
  const r = String(reason ?? "");
  if (/^pre-filter:/i.test(r)) return "prefilter";
  // inventorying first: "INVENTORIES the shopper" also contains "invent"
  if (/inventor|recit|read(s|ing)? .{0,12}aloud|stored (data|contact|phone)|records aloud|tally|dossier|scorekeep/i.test(r)) return "inventorying";
  if (/invent|fabricat|unsupported|not authorized|guarantee|refund|discount|not (in|from) house/i.test(r)) return "invented";
  if (/plumbing|template|token|meta|narrat|sign.?in|process talk/i.test(r)) return "plumbing";
  if (/house rules/i.test(r)) return "house_rules";
  if (/question|unsolicited/i.test(r)) return "etiquette";
  return "other";
}

/** Does a proactive line CLAIM the house made an outbound contact — that it
 * already called, phoned, texted, or reached out to the shopper? This is the
 * exact fabrication that leaked live ("I called you Thursday"): an invented
 * outbound-contact claim. Such a claim is TRUE only when a completed ('done')
 * callback is on file; a deterministic pre-filter blocks it otherwise, so a
 * fail-open judge call can never let it through.
 *
 * Two things are deliberately NOT claims: an invitation for the SHOPPER to
 * reach the house ("give us a call", "you can reach us"), and a FUTURE promise
 * of the callback the shopper asked for ("someone will call you") — only the
 * past-tense assertion that a call already happened is caught. */
export function claimsOutboundContact(line: string): boolean {
  const s = " " + String(line ?? "").toLowerCase().replace(/\s+/g, " ") + " ";
  // Invitations for the shopper to contact the house — legitimate, never a claim.
  const invited = /\b(you can|you could|feel free to|give (us|the house|me) a (call|ring)|call us|reach out to us|get in touch with us|contact us|call the (house|shop|studio|mill))\b/;
  // House subject + a PAST/perfect outbound verb.
  const outbound = /\b(i|we|the house|the mill|the shop|the studio|our team|someone here)\b[^.?!]{0,24}\b(called|phoned|rang|texted|messaged|reached out|got in touch|left (you )?(a )?(voice-?mail|message)|tr(ied|ying) (to (call|reach)|calling|reaching) you|followed up (with|by (phone|call)))/;
  // "...called/phoned/... you" — past tense, any subject.
  const calledYou = /\b(called|phoned|rang|texted|messaged|contacted)\s+you\b/;
  const whenICalled = /\b(as|when|since|after)\s+(i|we)\s+(called|phoned|rang|texted|reached out|left|contacted)\b/;
  const claims = outbound.test(s) || calledYou.test(s) || whenICalled.test(s);
  // An invitation with no actual past-tense claim is fine.
  if (invited.test(s) && !claims) return false;
  return claims;
}

/** The floor a merchant may relax. 'prefilter' is mechanical and NEVER
 * relaxable (a malformed token can't be "allowed"); broken output has no
 * family a merchant would loosen either. */
export const FLOOR_FAMILIES: JudgeFamily[] =
  ["invented", "inventorying", "plumbing", "house_rules", "etiquette", "other"];

/** Does the merchant's floor ALLOW a line the judge blocked on this family?
 * Default (no config, or the family unset) = BLOCK — the floor only ever
 * loosens on an explicit merchant choice, never by omission. 'prefilter' is
 * never allowed regardless of config. */
export function judgeFloorAllows(
  family: JudgeFamily,
  floor: Record<string, unknown> | null | undefined,
): boolean {
  if (family === "prefilter") return false; // mechanical — never relaxable
  const v = floor && typeof floor === "object" ? floor[family] : undefined;
  return v === "allow";
}

/** The three named presets, resolved to a per-family policy map. 'standard'
 * blocks every family (today's behaviour). 'facts_only' keeps the honesty
 * families hard (invented, inventorying, house_rules) but lets style/etiquette
 * and plumbing-adjacent lines through. 'strict' is identical to standard here
 * (the judge already blocks all) but names the merchant's intent explicitly. */
export function judgeFloorPreset(name: string): Record<string, "block" | "allow"> {
  const all = (v: "block" | "allow") =>
    Object.fromEntries(FLOOR_FAMILIES.map((f) => [f, v])) as Record<string, "block" | "allow">;
  if (name === "facts_only") {
    return { ...all("block"), etiquette: "allow", plumbing: "allow", other: "allow" };
  }
  return all("block"); // 'strict' and 'standard' both block everything
}

export function composeGapSkeleton(questions: string[]): string {
  const qs = questions.map((q) => String(q ?? "").trim()).filter((q) => q)
    .slice(0, 8).map((q) => `- \u201C${q.slice(0, 200)}\u201D`).join("\n");
  return "Visitors asked, and the concierge had no answer:\n\n" + qs +
    "\n\n**The house's answer** \u2014 replace this line with the facts, then enable:\n\n- \u2026";
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

// ── book_appointment slug self-heal ─────────────────────────────────────────
// The reported bug: the model reconstructs a booking type_slug from a human
// TITLE ("mill-tour" from "A tour of the mill"), book_appointment refuses with
// unknown_type, and the model then tells the shopper the calendar/system is
// DOWN — when it is perfectly live. This shapes the recovery the tool hands back
// on an unknown_type/unknown_location refusal: the REAL slugs plus an explicit
// retry-with-a-valid-slug instruction and a hard ban on the false "system is
// down" line. Pure (the caller passes the rows it read from the DB) so the
// contract is unit-tested in beats_test.ts and can never silently regress.
// Returns null for any other reason, so the caller leaves the result untouched.
export type BookSlugRecovery = {
  valid_types: { type_slug: string; title: string }[];
  valid_locations: string[];
  note: string;
};

export function bookSlugRecovery(
  reason: unknown,
  validTypes: { slug: string; title: string }[],
  validLocations: { slug: string }[],
): BookSlugRecovery | null {
  if (reason !== "unknown_type" && reason !== "unknown_location") return null;
  return {
    valid_types: (validTypes || []).map((t) => ({ type_slug: t.slug, title: t.title })),
    valid_locations: (validLocations || []).map((l) => l.slug),
    note: "The type_slug or location_slug is not one the house offers — you likely invented it. " +
      "Call book_appointment AGAIN using EXACTLY a type_slug from valid_types (and a location_slug from " +
      "valid_locations) with the same starts_at. NEVER tell the shopper the calendar/system is down — it " +
      "is live; this was a bad slug.",
  };
}

// ── Canonical widget-token registry — the ONE source of truth ────────────────
// Every {{…}} token the visitor's app renders as real inline UI. The renderable
// pre-filter (RENDERABLE_TOKEN_RE), the reach-out judge's token awareness
// (widgetTokensJudgeNote / describeTokensForJudge), and the studio's token
// reference (served by GET ?tokens=1) ALL derive from this list, so they can
// never drift apart — that drift is what let the judge false-veto a real
// {{action:signin}}. Anything NOT matched here is treated as plumbing and vetoed.
// `pattern` is a regex fragment placed inside ^\{\{( … )\}\}$ ; keep it in lockstep
// with what assets/concierge.js actually renders (a beats test guards the union).
export interface WidgetToken {
  example: string; // canonical form shown in the studio, e.g. "{{action:signin}}"
  pattern: string; // regex fragment matching the token body, e.g. "action:signin"
  label: string; // short name of the control, e.g. "Sign-in button"
  renders: string; // what the widget draws for the visitor
  usage: string; // when the concierge should reach for it
}
export const WIDGET_TOKENS: WidgetToken[] = [
  {
    example: "{{action:signin}}",
    pattern: "action:signin",
    label: "Sign-in button",
    renders: "a “Sign in — the key arrives by mail” button",
    usage: "Close a warm welcome-back to a not-signed-in visitor. Put it on its OWN line.",
  },
  {
    example: "{{action:commission}}",
    pattern: "action:commission",
    label: "Commission button",
    renders: "a “✳ Begin the commission” button",
    usage: "On an unmistakable buying signal — opens checkout from the concierge. Its own line.",
  },
  {
    example: "{{action:snooze}}",
    pattern: "action:snooze",
    label: "Snooze control",
    renders: "an invisible wind-down control that lets a busy visitor defer",
    usage: "Alone on the last line of a goodbye, so the thread can resume later.",
  },
  {
    example: "{{form:<name>}}",
    pattern: "form:[a-z0-9-]{2,40}(:\\d{1,6})?",
    label: "Inline form",
    renders: "an inline form (e.g. the appointment booker)",
    usage: "Collect structured details in-chat — e.g. {{form:appointment}}.",
  },
  {
    example: "{{reply:…}}",
    pattern: "reply:[^{}]{1,200}",
    label: "Quick-reply chip",
    renders: "a tap-to-answer chip carrying the suggested reply",
    usage: "Offer 1–3 easy replies — e.g. {{reply:Tell me about the wool}}.",
  },
  {
    example: "{{nps}}",
    pattern: "nps",
    label: "Rating scale",
    renders: "the 0–10 rating scale",
    usage: "The single rating question at a natural close (handled automatically).",
  },
  {
    example: "{{img:<id>}}",
    pattern: "img:[A-Za-z0-9_-]+",
    label: "Image",
    renders: "an inline image by id",
    usage: "Show a saved image — e.g. {{img:selvedge_number}}.",
  },
  {
    example: "{{video:<id>}}",
    pattern: "video:[A-Za-z0-9_-]+",
    label: "Video",
    renders: "an inline video by id",
    usage: "Show a saved clip — e.g. {{video:mending}}.",
  },
];

// A whole line that IS one of these tokens (trimmed) is renderable UI, not plumbing.
export const RENDERABLE_TOKEN_RE = new RegExp(
  "^\\{\\{(" + WIDGET_TOKENS.map((t) => t.pattern).join("|") + ")\\}\\}$",
  "i",
);
const TOKEN_LABELERS = WIDGET_TOKENS.map((t) => ({
  re: new RegExp("^\\{\\{" + t.pattern + "\\}\\}$", "i"),
  label: t.label,
}));

// For the reach-out judge: swap each rendered token for a plain-English description of
// the control it draws, so the model judges the LANGUAGE and can't mistake the raw
// {{…}} syntax for a tool/meta "plumbing" leak (it was told these are legitimate and
// still misfired on one). Non-renderable tokens never reach here — the pre-filter
// vetoes them first — so anything left unmatched is passed through untouched.
export function describeTokensForJudge(line: string): string {
  return String(line || "").replace(/\{\{[^{}]*\}\}/g, (t) => {
    const m = TOKEN_LABELERS.find((x) => x.re.test(t));
    return m ? "[" + m.label + "]" : t;
  });
}

// The judge's WIDGET-CONTROLS note, generated from the registry (never hand-listed,
// so it can't fall out of sync with what actually renders — as the old inline list did,
// which omitted snooze/img/video).
export function widgetTokensJudgeNote(): string {
  return "WIDGET CONTROLS: the visitor's app draws real interactive controls inline. Where the line " +
    "shows a bracketed control — " + WIDGET_TOKENS.map((t) => "[" + t.label + "]").join(", ") +
    " — that is a genuine affordance the app renders for the visitor: customer-facing PRODUCT, never a " +
    "tool/meta/plumbing token. Never veto a line for offering one.";
}

// Majority-vote a set of reach-out judge verdicts (self-consistency). Precision-
// biased: a STRICT majority must vote veto, so a lone spurious veto among passes is
// outvoted and the line survives — matching the design rule that a false veto is the
// worse error. Empty input fails open (pass). When the majority vetoes, the first
// vetoing verdict's reason (and any floor tag) represents the group.
export function tallyJudgeVotes(
  verdicts: { veto: boolean; reason: string; floored?: string }[],
): { veto: boolean; reason: string; floored?: string } {
  const list = (verdicts || []).filter((v) => v && typeof v.veto === "boolean");
  if (!list.length) return { veto: false, reason: "" };
  const vetoes = list.filter((v) => v.veto);
  if (vetoes.length > list.length / 2) {
    const w = vetoes[0];
    return w.floored ? { veto: true, reason: w.reason, floored: w.floored } : { veto: true, reason: w.reason };
  }
  return { veto: false, reason: "" };
}

// Recognition on return is a REAL capability (signing in / leaving an email lets the
// house know the visitor next time), and it is NOT the same as unsolicited outreach.
// The judge kept conflating the two — vetoing legitimate sign-in offers as defect 1
// (meta/plumbing), defect 9 (invented capability), or defect 10 (invented outbound
// contact). This note draws the line so it stops silencing good CTAs while STILL
// catching a fabricated "we'll call/email you" or a completed-callback claim with no
// record behind it.
export const RECOGNITION_JUDGE_NOTE =
  "RECOGNITION IS A REAL CAPABILITY — NOT outreach, NOT meta. Signing in, or leaving an email, lets the house " +
  "RECOGNIZE this visitor when THEY come back and remember their preferences. Offering that is legitimate SERVICE " +
  "describing a real feature — e.g. \"sign in and the house will know you next time\", \"leave your email and I'll " +
  "remember you\", \"so I can serve you as yourself\". NEVER veto these as defect 1 (meta/plumbing narration), " +
  "defect 9 (invented capability), or defect 10 (invented outbound contact): recognition-on-return is exactly what " +
  "signing in does. Separately, the house MAY reference a callback the visitor REQUESTED when the grounding/CALLBACKS " +
  "record shows one — \"the house called you about the tour\" is grounded if a completed callback is on file. What " +
  "REMAINS a defect-10 fabrication: claiming the house will, or did, reach out UNPROMPTED (marketing calls or emails), " +
  "or asserting a specific call/appointment time with no basis in the grounding.";
