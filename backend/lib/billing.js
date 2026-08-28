// Billing/subscription helpers — Razorpay plan catalog, checkout
// plumbing, and the student-cap enforcement every provisioning route
// (create-student, CSV import, the Google Form webhook) relies on.
// Split out of index.js as part of breaking that monolith into
// modules. Pure relocation: nothing about pricing, Razorpay calls, or
// cap logic changed, only where it lives.
const Razorpay = require('razorpay');
const { pool } = require('./db');
const { ensureRazorpayPlansSchema, ensureSubscriptionsSchema } = require('../schema');

// ============================================================================
// BILLING — subscription plans by student headcount, via Razorpay.
// ============================================================================

// Fixed product config, not admin-editable data — unlike grade_bands/
// tag_visibility_settings (genuinely per-org admin settings), nobody edits
// these tiers through a UI. A pricing change should go through code review
// + deploy, not a live UPDATE against the production DB, so this stays a
// constant rather than a table. Amounts in paise (Razorpay's own unit),
// not rupees, to avoid a float-rupee conversion bug at the one place it'd
// matter most.
// Real INR pricing — annualPaise is a flat 10x monthlyPaise (two months
// free) across every tier, same discount shape for all of them. Per-student
// cost declines with tier size (₹6.66 → ₹6.00 → ₹4.00 → ₹3.00 per student/
// month), the usual SaaS volume curve. Anything past 'scale' isn't a
// self-serve checkout at all — see the custom-quote route further down,
// which is what the frontend's "Custom" card actually links to.
const PLAN_CATALOG = {
  free:        { label: 'Free',        studentCap: 30,    monthlyPaise: 0,       annualPaise: 0        },
  starter:     { label: 'Starter',     studentCap: 150,   monthlyPaise: 99900,   annualPaise: 999000   },
  growth:      { label: 'Growth',      studentCap: 500,   monthlyPaise: 299900,  annualPaise: 2999000  },
  institution: { label: 'Institution', studentCap: 2000,  monthlyPaise: 799900,  annualPaise: 7999000  },
  scale:       { label: 'Scale',       studentCap: 10000, monthlyPaise: 2999900, annualPaise: 29999000 },
};
const PAID_PLAN_KEYS = ['starter', 'growth', 'institution', 'scale'];
const BILLING_CYCLES = ['monthly', 'annual'];

// Lazily constructed — RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET don't exist yet
// in this deploy (test-mode keys are still being set up), so this can't be
// built at module load like most other external clients in this file
// (compare to getGmailClient()/getB2Client(), each lazily built the same
// way for the same reason). Returns null — never
// throws — when unconfigured, so every caller can cleanly 503 instead of
// crashing the process.
let razorpayClient = null;
function getRazorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

// Idempotent, on-demand Razorpay Plan creation — the first admin who
// checks out into a never-before-used (tier, cycle) combination creates it;
// every call after that is a single indexed SELECT. Never runs at boot, so
// there's no manual script to run against production once real keys land —
// the very first real checkout attempt bootstraps whichever plan it needs.
async function ensureRazorpayPlan(planKey, billingCycle) {
  await ensureRazorpayPlansSchema();
  const cached = await pool.query(
    'SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2',
    [planKey, billingCycle]
  );
  if (cached.rows.length > 0) return cached.rows[0].razorpay_plan_id;

  const rzp = getRazorpayClient();
  if (!rzp) throw new Error('Razorpay is not configured (missing API keys)');

  const plan = PLAN_CATALOG[planKey];
  const amount = billingCycle === 'monthly' ? plan.monthlyPaise : plan.annualPaise;
  const created = await rzp.plans.create({
    period: billingCycle === 'monthly' ? 'monthly' : 'yearly',
    interval: 1,
    item: { name: `HonorRoll ${plan.label} (${billingCycle})`, amount, currency: 'INR' },
  });

  // ON CONFLICT covers two admins simultaneously triggering checkout for the
  // same never-before-used (planKey, cycle) pair — both would create a
  // Razorpay Plan object (harmless, Razorpay allows duplicates), but only
  // one row survives locally; the re-SELECT below picks up whichever won.
  const inserted = await pool.query(
    `INSERT INTO razorpay_plans (plan_key, billing_cycle, razorpay_plan_id) VALUES ($1, $2, $3)
     ON CONFLICT (plan_key, billing_cycle) DO NOTHING RETURNING razorpay_plan_id`,
    [planKey, billingCycle, created.id]
  );
  if (inserted.rows.length > 0) return inserted.rows[0].razorpay_plan_id;
  const winner = await pool.query(
    'SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_key = $1 AND billing_cycle = $2',
    [planKey, billingCycle]
  );
  return winner.rows[0].razorpay_plan_id;
}

// A missing subscriptions row (an org that predates this feature) and a
// row whose status isn't currently 'active' (lapsed, cancelled, halted,
// still mid-checkout, etc.) both fall back to 'free' — this single rule is
// also what implements the downgrade/cancellation policy: the moment a
// webhook flips status away from 'active', every cap check everywhere
// immediately reflects it, with no separate "downgrade" code path needed.
async function getEffectivePlanKey(organizationId) {
  await ensureSubscriptionsSchema();
  const { rows } = await pool.query('SELECT plan_key, status FROM subscriptions WHERE organization_id = $1', [organizationId]);
  if (rows.length === 0) return 'free';
  return rows[0].status === 'active' ? rows[0].plan_key : 'free';
}

// Shared by every student-provisioning route (create-student, CSV import,
// the Google Form webhook) — hard-blocks once an org's student count would
// reach its plan's cap. `additional` lets a caller ask "is there room for N
// more" without adding them yet (used by CSV import to pre-flight-check
// remaining headroom once before its per-row loop, rather than re-querying
// the plan/count on every single row).
async function checkStudentCap(organizationId, additional = 1) {
  const planKey = await getEffectivePlanKey(organizationId);
  const cap = PLAN_CATALOG[planKey].studentCap;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'student'`,
    [organizationId]
  );
  const current = rows[0].n;
  return {
    ok: current + additional <= cap,
    current,
    cap,
    planKey,
    planLabel: PLAN_CATALOG[planKey].label,
    remaining: Math.max(0, cap - current),
  };
}

module.exports = {
  PLAN_CATALOG, PAID_PLAN_KEYS, BILLING_CYCLES,
  getRazorpayClient, ensureRazorpayPlan, getEffectivePlanKey, checkStudentCap,
};
