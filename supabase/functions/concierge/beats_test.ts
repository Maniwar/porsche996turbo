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
  PLACEHOLDER_ADDR,
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
