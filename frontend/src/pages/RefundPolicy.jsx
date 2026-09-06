import LegalShell from '../components/LegalShell';

export default function RefundPolicy() {
  return (
    <LegalShell>
      <h1>Refund Policy</h1>
      <p className="legal-updated">Last updated: 6th September, 2026</p>

      <p>
        This policy describes how billing, cancellation, and refunds work for HonorRoll's paid
        plans. It should be read alongside the <a href="#/terms">Terms of Service</a>.
      </p>

      <p>
        <strong>This is a template.</strong> The mechanics below describe what the billing system
        actually does today — have the commercial terms (e.g. whether you want to offer a
        money-back window) reviewed against your actual business decision and, if you sell to
        customers in a jurisdiction with mandatory refund/cooling-off rules (e.g. EU/UK distance
        selling law), against those requirements before relying on it.
      </p>

      <h2>1. How billing works</h2>
      <p>
        Paid plans are subscriptions, billed on a recurring cycle and processed by our payment
        processor, Razorpay. Your plan's price and billing period are shown at checkout before you
        confirm payment.
      </p>

      <h2>2. Cancelling a subscription</h2>
      <p>
        An organization's admin can cancel a subscription at any time from the billing section of
        the admin dashboard. Cancelling stops the subscription from renewing — you keep access for
        the rest of the period you've already paid for, and are not charged again after it ends.
        Cancelling does not end your current access early.
      </p>

      <h2>3. Refunds</h2>
      <p>
        Payments are non-refundable by default: cancelling stops future renewal (see above) but
        does not refund the current billing period. We don't currently issue automatic or
        self-serve refunds through the product.
      </p>
      <p>
        If you believe you were charged in error (e.g. a duplicate charge or a billing system
        fault), contact <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a>{' '}
        with your organization name and the transaction details — these are reviewed and resolved
        case by case.
      </p>

      <h2>4. Custom / enterprise plans</h2>
      <p>
        Organizations above the largest self-serve plan are billed by invoice, arranged directly
        with our team rather than through the automated checkout. Payment and refund terms for
        those are whatever's agreed in that invoice/quote, not this policy.
      </p>

      <h2>5. Changes to this policy</h2>
      <p>
        We may update this policy from time to time. Material changes will be reflected by an
        updated "Last updated" date above.
      </p>

      <h2>6. Contact</h2>
      <p>
        Billing questions can be sent to{' '}
        <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a>.
      </p>
    </LegalShell>
  );
}
