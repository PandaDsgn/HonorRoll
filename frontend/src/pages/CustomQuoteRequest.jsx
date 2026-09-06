import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import Breadcrumbs from '../components/Breadcrumbs';
import { API } from '../config';

// Reached from the "Custom" plan card in BillingPanel — anything past the
// 10,000-student 'scale' tier isn't a self-serve Razorpay checkout, just a
// lead form that emails the request to the platform owner (see POST
// /api/admin/billing/custom-quote). Institution/contact identity comes
// from the authenticated admin's own account server-side, not this form —
// only the extra sales-relevant details are actually collected here.
export default function CustomQuoteRequest() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();

  const [studentCount, setStudentCount] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await axios.post(`${API}/api/admin/billing/custom-quote`, { studentCount, contactPhone, notes }, { withCredentials: true });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send your request.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <Breadcrumbs items={[
          { label: 'Admin', to: '/admin' },
          { label: 'Custom quote' },
        ]} />
        <div className="admin-toolbar" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin')}>&larr; Back to admin dashboard</button>
        </div>

        <div className="panel" style={{ padding: 20, maxWidth: 480 }}>
          <h2 style={{ margin: '0 0 4px' }}>Request a custom plan</h2>
          <p className="auth-sub" style={{ margin: '0 0 20px' }}>
            For {user?.organization_name || 'your institution'} — beyond 10,000 students. We'll follow up by email with a quote and invoice.
          </p>

          {done ? (
            <div className="alert alert-success" role="status">
              <span className="alert-icon">✓</span>
              <span>Request sent — check your email shortly.</span>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="auth-form">
              <div className="field">
                <label htmlFor="student-count">Approximate student count</label>
                <input
                  id="student-count"
                  type="number"
                  min="1"
                  placeholder="e.g. 15000"
                  value={studentCount}
                  onChange={(e) => setStudentCount(e.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="contact-phone">Contact phone (optional)</label>
                <input
                  id="contact-phone"
                  type="tel"
                  placeholder="+91…"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  autoComplete="tel"
                />
              </div>

              <div className="field">
                <label htmlFor="notes">Anything else we should know? (optional)</label>
                <textarea
                  id="notes"
                  rows={4}
                  placeholder="Multiple campuses, specific rollout timeline, procurement requirements, etc."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
                {submitting && <span className="spinner" />}
                {submitting ? 'Sending…' : 'Send request'}
              </button>
            </form>
          )}

          {error && (
            <div className="alert" role="alert" style={{ marginTop: 16 }}>
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
