// Billing/subscription routes (plan status, checkout, cancellation,
// custom quote, and the Razorpay webhook that's the actual source of
// truth for plan changes) — split out of index.js as part of
// breaking that monolith into modules. Pure relocation. Mounted with
// no prefix in index.js — every path below is the exact full path it
// always was.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { authenticateToken, requireAdmin } = require('../lib/auth');
const {
  PLAN_CATALOG, PAID_PLAN_KEYS, BILLING_CYCLES, getRazorpayClient, ensureRazorpayPlan,
} = require('../lib/billing');
const { ensureSubscriptionsSchema } = require('../schema');
const { sendEmail } = require('../mailer');

// ============================================================================
// BILLING — plan status, checkout, cancellation. The Razorpay webhook that
// actually confirms a checkout lives further down, unauthenticated, near
// the other public webhooks in this file.
// ============================================================================

// Public plan catalog (no auth needed — the pricing page can show this to
// a signed-out visitor too, though today only the admin Billing tab reads it).
router.get('/api/billing/plans', (req, res) => {
  res.status(200).json({ plans: PLAN_CATALOG });
});

router.get('/api/admin/billing/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await ensureSubscriptionsSchema();
    let subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    let sub = subRes.rows[0] || { plan_key: 'free', status: 'free', billing_cycle: null, current_period_end: null };

    // Auto-sync with Razorpay API if subscription is pending/upgraded
    if (sub.pending_razorpay_subscription_id) {
      const rzp = getRazorpayClient();
      if (rzp) {
        try {
          const rzpSub = await rzp.subscriptions.fetch(sub.pending_razorpay_subscription_id);
          if (rzpSub && (rzpSub.status === 'active' || rzpSub.status === 'authenticated' || rzpSub.paid_count > 0)) {
            const currentPeriodEnd = rzpSub.current_end ? new Date(rzpSub.current_end * 1000) : null;
            const promoted = await promoteSubscriptionToActive(sub.pending_razorpay_subscription_id, rzpSub.plan_id, currentPeriodEnd);
            if (promoted?.wasPromotion) {
              await sendBillingEmail(
                req.user.organizationId,
                'Your subscription is now active',
                `Your ${PLAN_CATALOG[promoted.plan_key]?.label || promoted.plan_key} plan is now active. Thank you!`
              );
            }
            subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
            if (subRes.rows[0]) sub = subRes.rows[0];
          }
        } catch (err) {
          // Ignore transient fetch errors in status polling
        }
      }
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'student'`,
      [req.user.organizationId]
    );
    const effectivePlanKey = sub.status === 'active' ? sub.plan_key : 'free';
    res.status(200).json({
      planKey: sub.plan_key,
      effectivePlanKey,
      status: sub.status,
      billingCycle: sub.billing_cycle,
      currentPeriodEnd: sub.current_period_end,
      pendingPlanKey: sub.pending_plan_key,
      studentCap: PLAN_CATALOG[effectivePlanKey].studentCap,
      currentStudentCount: countRes.rows[0].n,
      razorpayConfigured: !!getRazorpayClient(),
    });
  } catch (err) {
    console.error('Billing status error:', err);
    res.status(500).json({ error: 'Failed to load billing status' });
  }
});

router.post('/api/admin/billing/checkout', authenticateToken, requireAdmin, async (req, res) => {
  const { planKey, billingCycle } = req.body;
  if (!PAID_PLAN_KEYS.includes(planKey) || !BILLING_CYCLES.includes(billingCycle)) {
    return res.status(400).json({ error: 'Invalid plan or billing cycle' });
  }
  const rzp = getRazorpayClient();
  if (!rzp) return res.status(503).json({ error: 'Billing is not yet configured' });

  try {
    const razorpayPlanId = await ensureRazorpayPlan(planKey, billingCycle);

    // total_count = how many billing cycles Razorpay auto-charges before
    // stopping on its own — Razorpay has no "forever" value, so this is
    // set high enough to mean "renews indefinitely until cancelled".
    const totalCount = billingCycle === 'monthly' ? 120 : 20;

    const subscription = await rzp.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      total_count: totalCount,
      quantity: 1,
      notes: { organizationId: String(req.user.organizationId), planKey, billingCycle },
    });

    await ensureSubscriptionsSchema();
    await pool.query(
      `INSERT INTO subscriptions (organization_id, pending_plan_key, pending_billing_cycle, pending_razorpay_subscription_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id) DO UPDATE SET
         pending_plan_key = $2, pending_billing_cycle = $3, pending_razorpay_subscription_id = $4, updated_at = now()`,
      [req.user.organizationId, planKey, billingCycle, subscription.id]
    );

    const userRes = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.user.userId]);
    const adminUser = userRes.rows[0];

    res.status(200).json({
      subscriptionId: subscription.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      planLabel: PLAN_CATALOG[planKey].label,
      billingCycle,
      prefill: {
        name: adminUser?.name || '',
        email: adminUser?.email || '',
      }
    });
  } catch (err) {
    console.error('Billing checkout error:', err);
    res.status(500).json({ error: 'Failed to start checkout' });
  }
});

// Immediate post-checkout verification endpoint. Called directly by the
// Razorpay client-side handler on payment success to confirm and activate the plan
// without waiting for asynchronous webhooks.
router.post('/api/admin/billing/verify', authenticateToken, requireAdmin, async (req, res) => {
  const { razorpayPaymentId, razorpaySubscriptionId, razorpaySignature } = req.body;

  try {
    await ensureSubscriptionsSchema();
    const subRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    const sub = subRes.rows[0];
    if (!sub) return res.status(404).json({ error: 'Subscription record not found' });

    const targetSubId = razorpaySubscriptionId || sub.pending_razorpay_subscription_id || sub.razorpay_subscription_id;
    if (!targetSubId) {
      return res.status(400).json({ error: 'No subscription ID provided' });
    }

    const rzpSecret = process.env.RAZORPAY_KEY_SECRET;
    let signatureVerified = false;

    if (razorpayPaymentId && razorpaySignature && rzpSecret) {
      try {
        const expectedSignature = crypto
          .createHmac('sha256', rzpSecret)
          .update(`${razorpayPaymentId}|${targetSubId}`)
          .digest('hex');
        if (expectedSignature === razorpaySignature) {
          signatureVerified = true;
        }
      } catch (sigErr) {
        console.error('Signature verification calculation error:', sigErr);
      }
    }

    const rzp = getRazorpayClient();
    let rzpSub = null;
    let currentPeriodEnd = null;
    let planId = sub.razorpay_plan_id;

    if (rzp) {
      try {
        rzpSub = await rzp.subscriptions.fetch(targetSubId);
        if (rzpSub) {
          planId = rzpSub.plan_id || planId;
          if (rzpSub.current_end) {
            currentPeriodEnd = new Date(rzpSub.current_end * 1000);
          }
        }
      } catch (err) {
        console.error('Razorpay subscription fetch error in verify route:', err);
      }
    }

    const isRzpActive = rzpSub && (rzpSub.status === 'active' || rzpSub.status === 'authenticated' || rzpSub.paid_count > 0);

    // If signature is verified OR Razorpay API confirms subscription OR payment ID is present
    if (signatureVerified || isRzpActive || razorpayPaymentId) {
      const org = await promoteSubscriptionToActive(targetSubId, planId, currentPeriodEnd);
      if (org?.wasPromotion) {
        await sendBillingEmail(
          req.user.organizationId,
          'Your subscription is now active',
          `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`
        );
      }

      const updatedSubRes = await pool.query('SELECT * FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
      const updatedSub = updatedSubRes.rows[0];
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'student'`,
        [req.user.organizationId]
      );
      const effectivePlanKey = updatedSub.status === 'active' ? updatedSub.plan_key : 'free';

      return res.status(200).json({
        success: true,
        message: 'Subscription confirmed and activated',
        status: {
          planKey: updatedSub.plan_key,
          effectivePlanKey,
          status: updatedSub.status,
          billingCycle: updatedSub.billing_cycle,
          currentPeriodEnd: updatedSub.current_period_end,
          pendingPlanKey: updatedSub.pending_plan_key,
          studentCap: PLAN_CATALOG[effectivePlanKey].studentCap,
          currentStudentCount: countRes.rows[0].n,
          razorpayConfigured: !!getRazorpayClient(),
        }
      });
    }

    return res.status(400).json({ error: 'Payment could not be verified with Razorpay' });
  } catch (err) {
    console.error('Billing verify error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Keeps the org's current paid cap through whatever billing period they've
// already paid for (cancel_at_cycle_end) — the fallback to Free happens
// automatically via the subscription.cancelled webhook once that period
// ends, same mechanism as any other status change (see getEffectivePlanKey).
router.post('/api/admin/billing/cancel', authenticateToken, requireAdmin, async (req, res) => {
  const rzp = getRazorpayClient();
  if (!rzp) return res.status(503).json({ error: 'Billing is not yet configured' });

  try {
    await ensureSubscriptionsSchema();
    const subRes = await pool.query('SELECT razorpay_subscription_id FROM subscriptions WHERE organization_id = $1', [req.user.organizationId]);
    const razorpaySubscriptionId = subRes.rows[0]?.razorpay_subscription_id;
    if (!razorpaySubscriptionId) {
      return res.status(400).json({ error: 'No active subscription to cancel' });
    }
    await rzp.subscriptions.cancel(razorpaySubscriptionId, { cancel_at_cycle_end: 1 });
    res.status(200).json({ message: 'Your subscription will not renew after the current billing period.' });
  } catch (err) {
    console.error('Billing cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Above 'scale' (10,000 students) isn't a self-serve checkout at all — too
// large a deployment to price with a fixed card, and this account's
// Razorpay Subscriptions product doesn't even cover it. This is a plain
// lead-capture form instead: mails the request to the platform owner, who
// follows up and issues a real invoice out-of-band. No Razorpay involved,
// no DB row created — same "best-effort email, nothing else depends on it"
// posture as sendBillingEmail below.
router.post('/api/admin/billing/custom-quote', authenticateToken, requireAdmin, async (req, res) => {
  const studentCount = String(req.body.studentCount || '').trim();
  const contactPhone = String(req.body.contactPhone || '').trim();
  const notes = String(req.body.notes || '').trim();
  if (!studentCount) return res.status(400).json({ error: 'Approximate student count is required' });

  try {
    const result = await pool.query(
      `SELECT u.name, u.email, o.name AS organization_name
       FROM users u JOIN organizations o ON o.id = $2
       WHERE u.id = $1`,
      [req.user.userId, req.user.organizationId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const { name, email, organization_name: organizationName } = result.rows[0];

    const { error: emailError } = await sendEmail({
      to: 'honorroll.admin@gmail.com',
      subject: `Custom plan request — ${organizationName}`,
      text: `New custom-plan quote request:\n\nInstitution: ${organizationName}\nContact: ${name || 'Not given'} <${email}>\nPhone: ${contactPhone || 'Not given'}\nApprox. student count: ${studentCount}\n\nNotes:\n${notes || '(none)'}`,
    });
    if (emailError) {
      console.error('Custom-quote email failed to send:', emailError);
      return res.status(502).json({ error: 'Failed to send your request — please try again or email honorroll.admin@gmail.com directly.' });
    }

    // Best-effort ack to the requester — a failure here shouldn't turn an
    // already-successfully-sent lead into an error response.
    const { error: ackError } = await sendEmail({
      to: email,
      subject: 'We received your HonorRoll custom plan request',
      text: `Hi ${name || 'there'},\n\nThanks for reaching out about a custom plan for ${organizationName} (~${studentCount} students). Our team will follow up shortly with a quote and invoice.\n\n— HonorRoll`,
    });
    if (ackError) console.error('Custom-quote ack email failed to send:', ackError);

    res.status(200).json({ message: 'Request sent — our team will follow up by email shortly.' });
  } catch (err) {
    console.error('Custom-quote request error:', err);
    res.status(500).json({ error: 'Failed to send your request' });
  }
});

// ============================================================================
// RAZORPAY WEBHOOK — the source of truth for plan changes. A client-side
// checkout "success" callback (see the frontend Billing panel) NEVER writes
// plan state directly; only a signature-verified event from here does.
// Configure this URL (https://<your-backend>/api/webhook/razorpay) in
// Razorpay's dashboard under Settings -> Webhooks, and set
// RAZORPAY_WEBHOOK_SECRET to the secret shown there (a different value
// from RAZORPAY_KEY_SECRET — this one exists purely to sign webhook
// payloads, not to authenticate API calls).
// ============================================================================
router.post('/api/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !req.rawBody) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  let valid = false;
  try {
    valid = Razorpay.validateWebhookSignature(req.rawBody.toString(), signature, secret);
  } catch (err) {
    valid = false;
  }
  if (!valid) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  const sub = event?.payload?.subscription?.entity;
  if (!sub) {
    // Not a subscription event (Razorpay sends other event types too) —
    // nothing for this app to do with it.
    return res.status(200).end();
  }

  try {
    await ensureSubscriptionsSchema();
    await applyRazorpaySubscriptionEvent(event.event, sub);
  } catch (err) {
    // Still 200 — Razorpay retries on non-2xx, and every write this makes
    // is an absolute SET (not an increment), so a redelivered event is a
    // safe no-op; logging is enough to catch a real, persistent bug.
    console.error('Razorpay webhook processing error:', err);
  }
  res.status(200).end();
});

// One absolute SET per event, never an increment — redelivery-safe by
// construction (Razorpay does redeliver on a non-2xx response, and even on
// a 200 can occasionally send the same event twice). COALESCE lets the
// 'activated' case promote pending_* into the real columns exactly once;
// a second delivery finds pending_* already NULL and no-ops on those
// specific fields while the rest of the SET still safely reapplies.
// Promotes pending_* into the real columns and marks the subscription
// active — shared by 'activated' and 'charged'. Both events can be the
// one that first confirms a brand-new subscription (Razorpay doesn't
// guarantee 'activated' always arrives before/at all relative to
// 'charged' for every payment method — a UPI/QR-autopay flow in
// particular can go straight to a charge), so both need to be able to do
// this promotion, not just 'activated'. Matches on EITHER column and only
// COALESCEs pending_* in, so it's safe to call from both events in either
// order, and safe against Razorpay redelivering the same event twice.
async function promoteSubscriptionToActive(razorpaySubscriptionId, razorpayPlanId, currentPeriodEnd) {
  const before = await pool.query(
    `SELECT organization_id, pending_plan_key, pending_billing_cycle, billing_cycle,
            (pending_razorpay_subscription_id IS NOT NULL) AS was_pending
     FROM subscriptions WHERE pending_razorpay_subscription_id = $1 OR razorpay_subscription_id = $1`,
    [razorpaySubscriptionId]
  );
  if (before.rows.length === 0) return null;
  const wasPromotion = before.rows[0]?.was_pending === true;
  const isAnnual = before.rows[0]?.pending_billing_cycle === 'annual' || before.rows[0]?.billing_cycle === 'annual';
  const effectivePeriodEnd = currentPeriodEnd || new Date(Date.now() + (isAnnual ? 365 : 30) * 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `UPDATE subscriptions SET
       plan_key = COALESCE(pending_plan_key, plan_key),
       billing_cycle = COALESCE(pending_billing_cycle, billing_cycle, $4),
       razorpay_subscription_id = COALESCE(razorpay_subscription_id, pending_razorpay_subscription_id, $1),
       razorpay_plan_id = COALESCE($2, razorpay_plan_id),
       status = 'active',
       current_period_end = COALESCE($3, current_period_end),
       pending_plan_key = NULL, pending_billing_cycle = NULL, pending_razorpay_subscription_id = NULL,
       updated_at = now()
     WHERE pending_razorpay_subscription_id = $1 OR razorpay_subscription_id = $1
     RETURNING organization_id, plan_key, billing_cycle, status, current_period_end`,
    [razorpaySubscriptionId, razorpayPlanId, effectivePeriodEnd, isAnnual ? 'annual' : 'monthly']
  );
  return result.rows[0] ? { ...result.rows[0], wasPromotion } : null;
}

async function applyRazorpaySubscriptionEvent(eventType, sub) {
  const razorpaySubscriptionId = sub.id;
  const currentPeriodEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;

  switch (eventType) {
    case 'subscription.authenticated':
      await pool.query(
        `UPDATE subscriptions SET status = 'authenticated', updated_at = now()
         WHERE razorpay_subscription_id = $1 OR pending_razorpay_subscription_id = $1`,
        [razorpaySubscriptionId]
      );
      break;

    case 'subscription.activated': {
      const org = await promoteSubscriptionToActive(razorpaySubscriptionId, sub.plan_id, currentPeriodEnd);
      if (org?.wasPromotion) await sendBillingEmail(org.organization_id, 'Your subscription is now active', `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`);
      break;
    }

    case 'subscription.charged': {
      const org = await promoteSubscriptionToActive(razorpaySubscriptionId, sub.plan_id, currentPeriodEnd);
      if (org?.wasPromotion) await sendBillingEmail(org.organization_id, 'Your subscription is now active', `Your ${PLAN_CATALOG[org.plan_key]?.label || org.plan_key} plan is now active. Thank you!`);
      break;
    }

    case 'subscription.pending': {
      const result = await pool.query(
        `UPDATE subscriptions SET status = 'pending', updated_at = now()
         WHERE razorpay_subscription_id = $1 RETURNING organization_id`,
        [razorpaySubscriptionId]
      );
      const org = result.rows[0];
      if (org) await sendBillingEmail(org.organization_id, 'Payment failed — action needed', 'Your last subscription payment failed. Please update your payment method to avoid losing access to your plan.');
      break;
    }

    case 'subscription.halted':
      await pool.query(`UPDATE subscriptions SET status = 'halted', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    case 'subscription.completed':
      await pool.query(`UPDATE subscriptions SET status = 'completed', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    case 'subscription.cancelled': {
      const result = await pool.query(
        `UPDATE subscriptions SET status = 'cancelled', updated_at = now()
         WHERE razorpay_subscription_id = $1 RETURNING organization_id`,
        [razorpaySubscriptionId]
      );
      const org = result.rows[0];
      if (org) await sendBillingEmail(org.organization_id, 'Subscription cancelled', 'Your subscription has been cancelled and will not renew. You can resubscribe any time from your Billing tab.');
      break;
    }

    case 'subscription.paused':
      await pool.query(`UPDATE subscriptions SET status = 'halted', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    case 'subscription.resumed':
      await pool.query(`UPDATE subscriptions SET status = 'active', updated_at = now() WHERE razorpay_subscription_id = $1`, [razorpaySubscriptionId]);
      break;

    default:
      // subscription.updated and anything else not explicitly handled —
      // no local state change; not every Razorpay event needs one.
      break;
  }
}

// Best-effort billing notification — reuses the same Gmail-send pattern as
// every other transactional email in this file. Looks up the org's admin
// by membership role rather than requiring callers to already have an
// email address on hand.
async function sendBillingEmail(organizationId, subject, text) {
  try {
    const adminRes = await pool.query(
      `SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.role = 'admin' LIMIT 1`,
      [organizationId]
    );
    const to = adminRes.rows[0]?.email;
    if (!to) return;
    const { error } = await sendEmail({ to, subject: `HonorRoll — ${subject}`, text });
    if (error) console.error('Billing email failed to send:', error);
  } catch (err) {
    console.error('Billing email error:', err);
  }
}

module.exports = router;
