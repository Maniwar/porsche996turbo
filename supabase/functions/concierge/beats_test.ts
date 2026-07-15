// beats_test.ts — unit tests for the pure beat brain (beats.ts). Runs in the
// deploy workflow via `deno test` BEFORE the type-check gate: the Action
// Table's ordering, the escalating proposal cool-off, and the text detectors
// are provable, not vibes.
//
//   deno test supabase/functions/concierge/beats_test.ts

import {
  chooseBeatAction,
  DEFAULT_PROPOSAL_REST_HOURS,
  extractSubjects,
  hasPendingAsk,
  type LearningDigest,
  PLACEHOLDER_ADDR,
  renderLearningDigest,
  npsSegment,
  npsScore,
  npsResponseRate,
  npsAnalystCorpus,
  npsCaptureAction,
  npsTriggerGate,
  detractorThemes,
  renderCustomerNps,
  proposalGate,
  proposalRestHoursFrom,
  type SalesLedger,
} from "./beats.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`ASSERT FAILED: ${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const HOUR = 3600000;
const NOW = 1_800_000_000_000; // fixed clock — tests never read the real time

function ledger(over: Partial<SalesLedger> = {}): SalesLedger {
  return {
    totalOrders: 0,
    placed: 0,
    weaving: 0,
    delivered: 0,
    lastOrderDays: null,
    blockedSerials: [],
    postSaleWindow: false,
    goalUnmetSlug: null,
    goalUnmetLabel: null,
    pendingAsk: false,
    section: "wool",
    spentActions: [],
    spentLog: [],
    newestInfoAt: null,
    ...over,
  };
}

// ── Action Table ordering ────────────────────────────────────────────────────

Deno.test("blocked order outranks everything", () => {
  const d = chooseBeatAction(
    ledger({ blockedSerials: [14220], totalOrders: 2, postSaleWindow: true, goalUnmetSlug: "discover", goalUnmetLabel: "x" }),
    undefined,
    { nowMs: NOW },
  );
  assertEq(d.action, "FIX_BLOCKED_ORDER", "blocked order should win");
  assert(d.detail.includes("14220"), "detail names the serial");
});

Deno.test("companion requires the post-sale window; gift does not", () => {
  const d = chooseBeatAction(ledger({ totalOrders: 1, postSaleWindow: false }), undefined, { nowMs: NOW });
  assertEq(d.action, "PROPOSE_GIFT", "outside the window the gift is next");
  const d2 = chooseBeatAction(ledger({ totalOrders: 1, postSaleWindow: true }), undefined, { nowMs: NOW });
  assertEq(d2.action, "PROPOSE_COMPANION", "inside the window the companion comes first");
});

Deno.test("admin can disable any rule", () => {
  const d = chooseBeatAction(
    ledger({ totalOrders: 1, postSaleWindow: true }),
    { PROPOSE_COMPANION: { enabled: false }, PROPOSE_GIFT: { enabled: false }, KEEP_WARM: { enabled: false } },
    { nowMs: NOW },
  );
  assertEq(d.action, "HOLD", "with proposals and keep-warm disabled and no goal, HOLD");
  assert(d.trace.some((t) => t.includes("disabled by admin")), "trace names the disable");
});

Deno.test("ADVANCE_GOAL fires for a browsing visitor with an unmet goal", () => {
  const d = chooseBeatAction(
    ledger({ goalUnmetSlug: "discover", goalUnmetLabel: "Discover — learn the room" }),
    undefined,
    { nowMs: NOW },
  );
  assertEq(d.action, "ADVANCE_GOAL:discover", "goal rule fires");
});

Deno.test("KEEP_WARM (give-first) sits above HOLD when all sales doors are spent", () => {
  const l = ledger({
    totalOrders: 1,
    postSaleWindow: true,
    spentActions: [],
    spentLog: [
      { action: "PROPOSE_COMPANION", at: NOW - 2 * HOUR },
      { action: "PROPOSE_GIFT", at: NOW - 2 * HOUR },
    ],
  });
  const d = chooseBeatAction(l, undefined, { nowMs: NOW });
  assertEq(d.action, "KEEP_WARM:wool", "give-first presence instead of silence");
  assert(d.detail.includes("GIVE FIRST"), "detail carries the give-first brief");
});

Deno.test("KEEP_WARM is once per section per day, then HOLD", () => {
  const l = ledger({ spentActions: ["KEEP_WARM:wool"] });
  const d = chooseBeatAction(l, undefined, { nowMs: NOW });
  assertEq(d.action, "HOLD", "warm line already given for this section today");
});

Deno.test("proactiveStyle 'offer' makes the presence beat offer-first, not recite", () => {
  const l = ledger({ spentActions: [] });
  const expertise = chooseBeatAction(l, undefined, { nowMs: NOW, proactiveStyle: "expertise" });
  assertEq(expertise.action, "KEEP_WARM:wool", "same action either way");
  assert(expertise.detail.includes("GIVE FIRST"), "expertise brief hands over knowledge");
  const offer = chooseBeatAction(l, undefined, { nowMs: NOW, proactiveStyle: "offer" });
  assertEq(offer.action, "KEEP_WARM:wool", "offer mode keeps the presence beat");
  assert(offer.detail.includes("OFFER-FIRST"), "offer brief invites, not recites");
  assert(/NEVER recite/.test(offer.detail), "offer brief forbids reciting facts at the shopper");
  assert(!offer.detail.includes("GIVE FIRST"), "offer brief is not the expertise brief");
});

// ── Escalating proposal cool-off ─────────────────────────────────────────────

Deno.test("first proposal is free; second rests 24h", () => {
  const free = proposalGate("PROPOSE_GIFT", ledger(), DEFAULT_PROPOSAL_REST_HOURS, NOW);
  assert(free.ok, "no prior proposal → eligible");
  const l = ledger({ spentLog: [{ action: "PROPOSE_GIFT", at: NOW - 2 * HOUR }] });
  const gate = proposalGate("PROPOSE_GIFT", l, DEFAULT_PROPOSAL_REST_HOURS, NOW);
  assert(!gate.ok, "2h after the 1st proposal it still rests (24h rung)");
  assert(gate.why.includes("cool-off"), "why names the cool-off");
  const later = proposalGate("PROPOSE_GIFT", l, DEFAULT_PROPOSAL_REST_HOURS, NOW + 23 * HOUR);
  assert(later.ok, "after 24h it re-qualifies");
});

Deno.test("the ladder escalates: 2 priors → 3d, 3+ priors → 7d (default ladder)", () => {
  const two = ledger({
    spentLog: [
      { action: "PROPOSE_GIFT", at: NOW - 30 * HOUR },
      { action: "PROPOSE_GIFT", at: NOW - 26 * HOUR },
    ],
  });
  assert(!proposalGate("PROPOSE_GIFT", two, DEFAULT_PROPOSAL_REST_HOURS, NOW).ok, "26h after 2nd → still resting (72h rung)");
  assert(proposalGate("PROPOSE_GIFT", two, DEFAULT_PROPOSAL_REST_HOURS, NOW + 47 * HOUR).ok, "73h after 2nd → eligible");
  const three = ledger({
    spentLog: [
      { action: "PROPOSE_GIFT", at: NOW - 200 * HOUR },
      { action: "PROPOSE_GIFT", at: NOW - 120 * HOUR },
      { action: "PROPOSE_GIFT", at: NOW - 100 * HOUR },
    ],
  });
  assert(!proposalGate("PROPOSE_GIFT", three, DEFAULT_PROPOSAL_REST_HOURS, NOW).ok, "100h after 3rd → resting (168h rung)");
});

Deno.test("new information re-opens a resting proposal early", () => {
  const l = ledger({
    spentLog: [{ action: "PROPOSE_GIFT", at: NOW - 2 * HOUR }],
    newestInfoAt: NOW - 1 * HOUR, // an order or book note NEWER than the proposal
  });
  const gate = proposalGate("PROPOSE_GIFT", l, DEFAULT_PROPOSAL_REST_HOURS, NOW);
  assert(gate.ok, "new info re-opens the proposal");
  assert(gate.why.includes("new information"), "why says so");
});

Deno.test("cool-off is per action — a resting gift does not rest the companion", () => {
  const l = ledger({
    totalOrders: 1,
    postSaleWindow: true,
    spentLog: [{ action: "PROPOSE_GIFT", at: NOW - 2 * HOUR }],
  });
  const d = chooseBeatAction(l, undefined, { nowMs: NOW });
  assertEq(d.action, "PROPOSE_COMPANION", "companion unaffected by the gift's rest");
});

Deno.test("proposalRestHoursFrom reads the admin ladder and rejects junk", () => {
  assertEq(proposalRestHoursFrom(undefined).join(","), "24,72,168", "default ladder");
  assertEq(proposalRestHoursFrom({ proposalRestHours: [1, 2, 3] }).join(","), "1,2,3", "custom ladder");
  assertEq(proposalRestHoursFrom({ proposalRestHours: ["x", -5] }).join(","), "24,72,168", "junk → default");
  assertEq(proposalRestHoursFrom({ proposalRestHours: [0.05] }).join(","), "0.05", "sub-hour testing ladder allowed");
});

// ── Text detectors ───────────────────────────────────────────────────────────

Deno.test("hasPendingAsk sees a mid-line question mark", () => {
  assert(hasPendingAsk(["Shall I open the register? The Loden suits it."]), "mid-line '?' counts");
  assert(!hasPendingAsk(["The Loden suits it."]), "no '?' → no pending ask");
  assert(hasPendingAsk(["A statement.", "Which room is it for?"]), "any line of the run counts");
});

Deno.test("extractSubjects pulls serials, cloths, and proposal themes", () => {
  const subjects = extractSubjects([
    "Nº 14,220 still carries a placeholder address — shall I take the real one?",
    "The Loden would suit a north room; as a gift the card can carry another name.",
  ]);
  assert(subjects.includes("Nº 14,220") || subjects.includes("Nº 14220"), "serial extracted: " + subjects.join("|"));
  assert(subjects.includes("Loden"), "cloth extracted");
  assert(subjects.some((s) => s.includes("gift")), "gift theme extracted");
  assert(subjects.some((s) => s.includes("address")), "address theme extracted");
});

Deno.test("PLACEHOLDER_ADDR catches test addresses, spares real ones", () => {
  assert(PLACEHOLDER_ADDR.test("Fake City"), "fake");
  assert(PLACEHOLDER_ADDR.test("123 test street"), "test");
  assert(!PLACEHOLDER_ADDR.test("8201 Peach Orchard Pass, McKinney"), "real address passes");
});

// ── Enriched proposal briefs (register colour) ──────────────────────────────

Deno.test("companion brief names the held cloths and carries the book facts + never-reveal reminder", () => {
  const d = chooseBeatAction(
    ledger({
      totalOrders: 2,
      postSaleWindow: true,
      byCloth: { Loden: 2 },
      bookFacts: ["prefers muted tones; the study faces north"],
    }),
    undefined,
    { nowMs: NOW },
  );
  assertEq(d.action, "PROPOSE_COMPANION", "companion selected");
  assert(d.detail.includes("2× Loden"), "brief tallies the held cloths: " + d.detail);
  assert(d.detail.includes("do NOT yet have"), "brief steers to a different colorway");
  assert(d.detail.includes("prefers muted tones"), "brief carries the book fact");
  assert(/never quote, cite, or reveal/i.test(d.detail), "the never-reveal reminder travels with the fact");
});

Deno.test("gift brief carries book facts; both briefs stay plain when the ledger has none", () => {
  const withFacts = chooseBeatAction(
    ledger({ totalOrders: 1, bookFacts: ["sister in Hamburg admired it"] }),
    undefined,
    { nowMs: NOW },
  );
  assertEq(withFacts.action, "PROPOSE_GIFT", "gift selected");
  assert(withFacts.detail.includes("sister in Hamburg"), "gift brief carries the fact");
  assert(/never quote, cite, or reveal/i.test(withFacts.detail), "never-reveal reminder present");
  const plain = chooseBeatAction(ledger({ totalOrders: 1 }), undefined, { nowMs: NOW });
  assertEq(plain.action, "PROPOSE_GIFT", "gift selected without extras");
  assert(!/client book/i.test(plain.detail), "no book clause when there are no facts");
  assert(!plain.detail.includes("They hold"), "no cloth clause when the tally is absent");
});

Deno.test("extractSubjects marks the sign-in invitation as a spent subject", () => {
  const subjects = extractSubjects([
    "Sign in and the register opens itself.\n{{action:signin}}",
    "The Loden suits a north room.",
  ]);
  assert(subjects.some((s) => s.includes("sign-in")), "sign-in theme extracted: " + subjects.join("|"));
  const clean = extractSubjects(["The Loden suits a north room."]);
  assert(!clean.some((s) => s.includes("sign-in")), "no sign-in theme without the offer");
});


// ── Coach feedback loop presentation (renderLearningDigest) ──────────────────
function digest(over: Partial<LearningDigest> = {}): LearningDigest {
  return {
    window_days: 14,
    total_spoke: 20,
    buckets: [
      { beat: "nudge", move: "PROPOSE_COMPANION", n: 19, reply_rate: 0.42 },
      { beat: "bubble", move: "REASSURE", n: 8, reply_rate: 0.12 },
    ],
    ...over,
  };
}

Deno.test("digest with signal renders a weighted 'what's landing' block", () => {
  const out = renderLearningDigest(digest(), 8);
  assert(out.length > 0, "non-empty with signal");
  assert(out.includes("PROPOSE_COMPANION on a nudge: 42% replied (n=19)"), "formats a bucket: " + out);
  assert(out.includes("REASSURE on a bubble: 12% replied (n=8)"), "formats the second bucket");
  assert(/last 14 days/.test(out), "names the window");
  assert(/lighter touch|holding/.test(out), "carries the restraint cue (can push the coach down)");
});

Deno.test("honest on thin data: below the spoke floor ⇒ empty (no invented pattern)", () => {
  assertEq(renderLearningDigest(digest({ total_spoke: 5 }), 8), "", "5 spoken < floor 8 ⇒ empty");
  assertEq(renderLearningDigest(digest({ total_spoke: 0, buckets: [] }), 8), "", "no data ⇒ empty");
  assertEq(renderLearningDigest(null, 8), "", "null digest ⇒ empty");
  assertEq(renderLearningDigest(undefined, 8), "", "undefined digest ⇒ empty");
  assertEq(renderLearningDigest(digest({ buckets: [] }), 8), "", "spoke over floor but no surviving buckets ⇒ empty");
});

Deno.test("digest caps at six buckets and tolerates missing fields", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ beat: "nudge", move: "M" + i, n: 5, reply_rate: 0.5 }));
  const out = renderLearningDigest(digest({ buckets: many }), 8);
  const shown = out.split("\n").filter((l) => l.startsWith("- ")).length;
  assertEq(shown, 6, "at most six buckets are shown");
  const sparse = renderLearningDigest(digest({ buckets: [{ n: 10 } as never] }), 8);
  assert(sparse.includes("? on a ?: 0% replied (n=10)"), "missing move/beat/rate degrade to placeholders: " + sparse);
});


// ── NPS — segments, score math, the survey trigger, detractor reasons, brief ──
const DAY = 24 * HOUR;

Deno.test("npsSegment bands 0-6 / 7-8 / 9-10 correctly", () => {
  for (const s of [0, 3, 6]) assertEq(npsSegment(s), "detractor", `score ${s}`);
  for (const s of [7, 8]) assertEq(npsSegment(s), "passive", `score ${s}`);
  for (const s of [9, 10]) assertEq(npsSegment(s), "promoter", `score ${s}`);
});

Deno.test("npsScore = %promoters − %detractors; passives ignored in the numerator", () => {
  assertEq(npsScore([10, 10, 9, 7, 0]), 40, "3 prom, 1 det, 1 pass over 5 ⇒ (3-1)/5*100");
  assertEq(npsScore([9, 9, 9, 9]), 100, "all promoters ⇒ 100");
  assertEq(npsScore([0, 1, 2]), -100, "all detractors ⇒ -100");
  assertEq(npsScore([7, 8, 7]), 0, "all passives ⇒ 0 (there ARE responses), not null");
  assertEq(npsScore([]), null, "no responses ⇒ null, never 0");
  assertEq(npsScore([10, 99, -1, 5]), 0, "out-of-range dropped: 1 prom, 1 det over 2 ⇒ 0");
});

Deno.test("npsResponseRate = responses ÷ offers; null when nothing offered, never a fake 0%", () => {
  assertEq(npsResponseRate(4, 1), 25, "1 of 4 offers answered ⇒ 25%");
  assertEq(npsResponseRate(3, 3), 100, "every offer answered ⇒ 100%");
  assertEq(npsResponseRate(0, 0), null, "no offers ⇒ null — the dashboard shows '—', not 0%");
  assertEq(npsResponseRate(0, 2), null, "responses without offers still null when offers=0");
  assertEq(npsResponseRate(2, 3), 150, "more responses than offers is shown, not hidden (window-edge anomaly)");
  assertEq(npsResponseRate(3, -1), 0, "negative response count clamps to 0");
});

Deno.test("npsAnalystCorpus: detractors lead, honesty floor, caps hold", () => {
  const items = [
    { score: 10, reason: "beautiful craft", when: "2026-07-01" },
    { score: 2, reason: "booking took three tries", categories: [{ slug: "scheduling" }], transcript: ["visitor: this keeps failing", "concierge: let me help"] },
    { score: 7, reason: "fine but slow replies" },
    { score: 9, reason: null },
  ];
  const out = npsAnalystCorpus(items);
  assert(out.startsWith("SESSION 1 — 2/10 (detractor)"), "detractor leads the corpus");
  assert(out.includes('"booking took three tries"'), "the customer's own words are the evidence");
  assert(out.includes("categories: scheduling"), "categories ride along");
  assert(out.includes("visitor: this keeps failing"), "transcript excerpts included");
  assert(out.includes("(none given)"), "a missing reason is stated, never invented");
  assertEq(npsAnalystCorpus(items.slice(0, 2)), "", "fewer than 3 responses ⇒ '' — no report on thin data");
  const capped = npsAnalystCorpus(items, { maxSessions: 3 });
  assert(!capped.includes("SESSION 4"), "session cap holds");
  assertEq(npsAnalystCorpus([{ score: 99 }, { score: -2 }, { score: NaN }] as never), "", "junk scores dropped, floor applies");
});

Deno.test("npsCaptureAction: corrections revise inside the window, never duplicate, else final", () => {
  const DAY = 86400000, DAY30 = 30 * DAY, DAY3 = 3 * DAY;
  assertEq(npsCaptureAction({ conversationRowAgeMs: 19 * 60000, lastCustomerRowAgeMs: null, cooldownMs: DAY30, reviseMs: DAY3 }),
    "revise-conversation", "this conversation's fresh row is the revision target");
  assertEq(npsCaptureAction({ conversationRowAgeMs: DAY3 + 1, lastCustomerRowAgeMs: null, cooldownMs: DAY30, reviseMs: DAY3 }),
    "ignore", "past the revision window the rating is FINAL — the tap writes nothing");
  assertEq(npsCaptureAction({ conversationRowAgeMs: null, lastCustomerRowAgeMs: 2 * DAY, cooldownMs: DAY30, reviseMs: DAY3 }),
    "revise-recent", "a new conversation inside the window corrects the recent row");
  assertEq(npsCaptureAction({ conversationRowAgeMs: null, lastCustomerRowAgeMs: 10 * DAY, cooldownMs: DAY30, reviseMs: DAY3 }),
    "ignore", "inside the cooldown but past the window: no correction, no duplicate — nothing");
  assertEq(npsCaptureAction({ conversationRowAgeMs: null, lastCustomerRowAgeMs: DAY30 + 1, cooldownMs: DAY30, reviseMs: DAY3 }),
    "insert", "past the cooldown a tap is a legitimately new response");
  assertEq(npsCaptureAction({ conversationRowAgeMs: null, lastCustomerRowAgeMs: null, cooldownMs: DAY30, reviseMs: DAY3 }),
    "insert", "anonymous with no conversation row ⇒ fresh response");
  assertEq(npsCaptureAction({ conversationRowAgeMs: 60000, lastCustomerRowAgeMs: null, cooldownMs: DAY30, reviseMs: 0 }),
    "ignore", "reviseDays 0 ⇒ ratings are final the moment they're given");
});

Deno.test("npsTriggerGate fires once, only at a natural close, past the cooldown", () => {
  const base = {
    enabled: true, concluded: true, alreadySurveyedSession: false,
    sessionDurationMs: 5 * 60000, minDurationMs: 60000,
    lastSurveyedAtMs: null as number | null, cooldownMs: 7 * DAY, nowMs: NOW,
  };
  assert(npsTriggerGate(base).ask, "an eligible concluded session offers the survey");
  assert(!npsTriggerGate({ ...base, enabled: false }).ask, "disabled ⇒ no");
  assert(!npsTriggerGate({ ...base, alreadySurveyedSession: true }).ask, "already offered ⇒ no (fire once)");
  assert(!npsTriggerGate({ ...base, concluded: false }).ask, "mid-session ⇒ no");
  assert(!npsTriggerGate({ ...base, sessionDurationMs: 5000 }).ask, "too short ⇒ no");
  assert(!npsTriggerGate({ ...base, lastSurveyedAtMs: NOW - 1 * HOUR }).ask, "within cooldown ⇒ no");
  assert(npsTriggerGate({ ...base, lastSurveyedAtMs: NOW - 8 * DAY }).ask, "past cooldown ⇒ yes");
});

Deno.test("detractorThemes tallies only sub-promoter concerns, most frequent first", () => {
  const t = detractorThemes([
    { score: 3, categories: [{ slug: "scheduling" }, { slug: "communication" }] },
    { score: 6, categories: [{ slug: "scheduling" }] },
    { score: 8, categories: [{ slug: "value" }] },        // passive counts — it's a concern
    { score: 10, categories: [{ slug: "scheduling" }] },  // promoter mention EXCLUDED
  ]);
  assertEq(t[0].slug, "scheduling", "scheduling is the top concern");
  assertEq(t[0].n, 2, "counted from the detractor+passive, NOT the promoter mention");
  assert(t.some((x) => x.slug === "value"), "a passive's concern is included");
  assert(!t.some((x) => x.n === 1 && x.slug === "scheduling"), "the promoter mention did not inflate the count");
});

Deno.test("renderCustomerNps: detractor brief carries themes + never-quote guard; thin data ⇒ empty", () => {
  assertEq(renderCustomerNps([]), "", "no history ⇒ empty");
  assertEq(renderCustomerNps([{ score: 4 }], 2), "", "below the min-responses floor ⇒ empty");
  const det = renderCustomerNps([
    { score: 7, categories: [{ slug: "scheduling" }], submittedAtMs: NOW - 2 * DAY },
    { score: 3, categories: [{ slug: "scheduling" }], submittedAtMs: NOW },
  ]);
  assert(det.includes("DETRACTOR"), "leads with the current segment");
  assert(/declining/.test(det), "trend detected (7 → 3)");
  assert(/scheduling/.test(det), "surfaces the recurring concern");
  assert(/never quote/i.test(det), "carries the never-quote-the-score discipline (pairs with the judge)");
  assert(/rebuild trust/i.test(det), "forward-looking play for a detractor");
  const promo = renderCustomerNps([{ score: 10, submittedAtMs: NOW }]);
  assert(/PROMOTER/.test(promo) && /referral/i.test(promo), "a promoter brief invites a referral");
});
