import { useState } from 'react';
import axios from 'axios';
import LegalShell from '../components/LegalShell';
import { API } from '../config';

// Public — no auth, reachable by anyone (a prospective institution, a
// parent, a journalist) who hasn't signed up at all yet. Submits to
// POST /api/contact, which lands in the superadmin dashboard's own Contact
// Messages section (not a separate page — see AdminMessagesPanel's sibling
// panel in SuperadminDashboard.jsx) rather than only ever an email.
export default function Contact() {
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await axios.post(`${API}/api/contact`, { name, mobile, email, message });
      setSent(true);
      setName('');
      setMobile('');
      setEmail('');
      setMessage('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send your message — please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <LegalShell>
      <h1>Contact us</h1>
      <p className="legal-updated">We read every message — expect a reply by email.</p>

      {sent ? (
        <div className="alert alert-success" role="status">
          <span className="alert-icon">✓</span>
          <span>Thanks — your message has been sent. We'll get back to you soon.</span>
        </div>
      ) : (
        <form onSubmit={submit} className="auth-form" style={{ maxWidth: 480 }}>
          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="contact-name">Name</label>
            <input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div className="field">
            <label htmlFor="contact-mobile">Mobile number</label>
            <input id="contact-mobile" type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} required />
          </div>

          <div className="field">
            <label htmlFor="contact-email">Email</label>
            <input id="contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>

          <div className="field">
            <label htmlFor="contact-message">Message</label>
            <textarea id="contact-message" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} required />
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
            {submitting && <span className="spinner" />}
            {submitting ? 'Sending…' : 'Send message'}
          </button>
        </form>
      )}
    </LegalShell>
  );
}
