import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API } from '../config';
import { useAuth } from '../context/AuthContext';

const RAZORPAY_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const existing = document.querySelector(`script[src="${RAZORPAY_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Razorpay checkout script')));
      return;
    }
    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout script'));
    document.body.appendChild(script);
  });
}

function formatRupees(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// Plan display order — Free first, then ascending by price. Doesn't need
// to match PLAN_CATALOG's own key order since that's driven by the
// backend, not display concerns. 'custom' isn't a real PLAN_CATALOG entry
// (see the card rendering below) — it's a static card linking to the
// custom-quote request page instead of a Razorpay checkout.
const PLAN_ORDER = ['free', 'starter', 'growth', 'institution', 'scale', 'custom'];

export default function BillingPanel() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [plans, setPlans] = useState(null);
  const [status, setStatus] = useState(null);
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [error, setError] = useState('');
  const [checkingOut, setCheckingOut] = useState(null); // plan key currently mid-checkout
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pollTimeoutRef = useRef(null);

  const fetchAll = useCallback(async () => {
    try {
      const [plansRes, statusRes] = await Promise.all([
        axios.get(`${API}/api/billing/plans`),
        axios.get(`${API}/api/admin/billing/status`, { withCredentials: true }),
      ]);
      setPlans(plansRes.data.plans);
      setStatus(statusRes.data);
    } catch {
      setError('Failed to load billing information.');
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Stop any in-flight poll if the component unmounts mid-checkout.
  useEffect(() => () => { if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current); }, []);

  // Plain function, not useCallback — it recurses by calling itself via its
  // own hoisted name, which a memoized `const` binding can't do cleanly
  // (the recursive call would reference the binding before useCallback has
  // returned it). It's never passed as a prop or used as an effect
  // dependency, so it doesn't need a stable identity across renders.
  function pollUntilActive(attemptsLeft = 20) {
    pollTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await axios.get(`${API}/api/admin/billing/status`, { withCredentials: true });
        setStatus(res.data);
        if (res.data.status === 'active') {
          setConfirming(false);
          return;
        }
      } catch {
        // transient — keep polling until attempts run out
      }
      if (attemptsLeft > 1) {
        pollUntilActive(attemptsLeft - 1);
      } else {
        setConfirming(false);
        setError('Still confirming your payment — refresh this tab in a minute to check again.');
      }
    }, 3000);
  }

  const upgrade = async (planKey) => {
    setError('');
    setCheckingOut(planKey);
    try {
      await loadRazorpayScript();
      const { data } = await axios.post(`${API}/api/admin/billing/checkout`, { planKey, billingCycle }, { withCredentials: true });
      const rzp = new window.Razorpay({
        key: data.razorpayKeyId,
        subscription_id: data.subscriptionId,
        name: 'HonorRoll',
        description: `${data.planLabel} — ${data.billingCycle}`,
        prefill: data.prefill || {
          name: user?.name || '',
          email: user?.email || '',
        },
        theme: { color: '#4f46e5' },
        handler: async (response) => {
          setConfirming(true);
          try {
            const verifyRes = await axios.post(`${API}/api/admin/billing/verify`, {
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySubscriptionId: response.razorpay_subscription_id || data.subscriptionId,
              razorpaySignature: response.razorpay_signature,
            }, { withCredentials: true });

            if (verifyRes.data?.success) {
              setStatus(verifyRes.data.status);
              setConfirming(false);
              fetchAll();
              return;
            }
          } catch (err) {
            console.error('Immediate payment verification error:', err);
          }
          // Fallback to polling if immediate verify did not complete
          pollUntilActive();
        },
        modal: {
          ondismiss: () => {
            setCheckingOut(null);
            fetchAll();
          },
        },
      });
      rzp.on('payment.failed', () => setError('Payment failed — you have not been charged. You can try again.'));
      rzp.open();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start checkout.');
    } finally {
      setCheckingOut(null);
    }
  };

  const cancelSubscription = async () => {
    setError('');
    setCancelling(true);
    try {
      const res = await axios.post(`${API}/api/admin/billing/cancel`, {}, { withCredentials: true });
      setError('');
      fetchAll();
      window.alert(res.data.message);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to cancel subscription.');
    } finally {
      setCancelling(false);
    }
  };

  if (!plans || !status) {
    return (
      <div className="panel" style={{ padding: 24, textAlign: 'center' }}>
        {error ? (
          <div className="alert" style={{ marginBottom: 16 }}>
            <span className="alert-icon">!</span>
            <span>{error}</span>
          </div>
        ) : (
          <p className="sb-loading" style={{ margin: 0 }}>Loading billing details…</p>
        )}
      </div>
    );
  }

  const effectiveKey = status?.effectivePlanKey || 'free';
  const currentPlan = plans?.[effectiveKey] || { label: effectiveKey, studentCap: 30 };
  const studentCap = status?.studentCap || currentPlan.studentCap || 30;
  const currentStudentCount = status?.currentStudentCount || 0;
  const usagePct = studentCap > 0 ? Math.min(100, Math.round((currentStudentCount / studentCap) * 100)) : 0;
  const isPaidActive = status?.status === 'active' && effectiveKey !== 'free';

  return (
    <div>
      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      {!status.razorpayConfigured && (
        <div className="alert" style={{ marginBottom: 16 }}>
          <span className="alert-icon">!</span>
          <span>Billing isn't fully set up yet — Razorpay API keys haven't been configured. You're on the Free plan until then.</span>
        </div>
      )}

      <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 4px' }}>Current plan: {currentPlan.label}</h3>
        {status.status === 'pending' && (
          <p className="auth-sub" style={{ margin: '4px 0 0', color: 'var(--danger)' }}>
            Your last payment failed — Razorpay is retrying. Update your payment method to avoid losing access.
          </p>
        )}
        {status.status !== effectiveKey && status.status !== 'active' && status.status !== 'free' && status.status !== 'pending' && (
          <p className="auth-sub" style={{ margin: '4px 0 0' }}>Subscription status: {status.status}</p>
        )}
        <p className="auth-sub" style={{ margin: '10px 0 6px' }}>
          {currentStudentCount} / {studentCap} students
        </p>
        <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${usagePct}%`, background: usagePct >= 100 ? 'var(--danger)' : 'var(--accent)', transition: 'width 0.2s ease' }} />
        </div>
        {isPaidActive && status.currentPeriodEnd && (
          <p className="auth-sub" style={{ margin: '10px 0 0' }}>
            Renews {new Date(status.currentPeriodEnd).toLocaleDateString(undefined, { dateStyle: 'medium' })}
          </p>
        )}
        {isPaidActive && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} disabled={cancelling} onClick={cancelSubscription}>
            {cancelling ? 'Cancelling…' : 'Cancel subscription'}
          </button>
        )}
      </div>

      <div className="panel" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <h3 style={{ margin: 0 }}>Plans</h3>
          <div className="segmented">
            <button type="button" className={billingCycle === 'monthly' ? 'active' : ''} onClick={() => setBillingCycle('monthly')}>Monthly</button>
            <button type="button" className={billingCycle === 'annual' ? 'active' : ''} onClick={() => setBillingCycle('annual')}>Annual</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          {PLAN_ORDER.map((planKey) => {
            // 'custom' isn't backed by PLAN_CATALOG at all — a static card
            // for anything past 'scale' (10,000 students), pointing at the
            // lead-capture request page instead of a Razorpay checkout.
            if (planKey === 'custom') {
              return (
                <div key="custom" className="panel" style={{ padding: 16 }}>
                  <div className="admin-cell-strong" style={{ fontSize: 15, marginBottom: 4 }}>Custom</div>
                  <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>10,000+ students</div>
                  <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Contact us</div>
                  <button type="button" className="btn btn-secondary-choice btn-sm" onClick={() => navigate('/admin/billing/custom-quote')}>
                    Request Invoice
                  </button>
                </div>
              );
            }

            const plan = plans?.[planKey];
            if (!plan) return null;
            const price = billingCycle === 'monthly' ? plan.monthlyPaise : plan.annualPaise;
            const isCurrent = effectiveKey === planKey;
            return (
              <div key={planKey} className="panel" style={{ padding: 16, borderColor: isCurrent ? 'var(--accent)' : undefined }}>
                <div className="admin-cell-strong" style={{ fontSize: 15, marginBottom: 4 }}>{plan.label}</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>up to {plan.studentCap?.toLocaleString('en-IN')} students</div>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
                  {price === 0 ? 'Free' : (
                    <>{formatRupees(price)}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-dim)' }}>/{billingCycle === 'monthly' ? 'mo' : 'yr'}</span></>
                  )}
                </div>
                {isCurrent ? (
                  <span className="chip chip-easy"><span className="dot" />Current plan</span>
                ) : planKey === 'free' ? (
                  <span className="auth-sub" style={{ fontSize: 12.5 }}>Downgrade by cancelling your current plan</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!status.razorpayConfigured || checkingOut === planKey || confirming}
                    onClick={() => upgrade(planKey)}
                  >
                    {checkingOut === planKey ? 'Starting…' : confirming ? 'Confirming…' : 'Choose Plan'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="auth-sub" style={{ margin: '16px 4px 0', fontSize: 12.5 }}>
        All payments are final and non-refundable. Cancelling a subscription stops future billing but does not
        refund charges already made for the current period — your plan stays active until the period ends.
      </p>
    </div>
  );
}
