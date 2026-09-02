import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import { API } from '../config';
import { getPrivateKey } from '../lib/e2eeKeyStore';
import { deriveSharedKey, encryptMessage, decryptMessage } from '../lib/e2ee';
import { on } from '../lib/realtime';
import '../admin.css';

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Shared chat UI — contact list + a decrypted thread + compose box. Used
// by both the student-facing top-level page below and
// pages/admin/ChatPanel.jsx's teacher tab; only the page chrome around it
// (header/nav) differs between the two. Every encrypt/decrypt call here
// runs against a shared AES-GCM key re-derived on the fly (deriveSharedKey,
// lib/e2ee.js) from this device's own private key + the contact's public
// key — nothing about the conversation itself is ever computed or stored
// server-side.
export function ChatWidget() {
  const [contacts, setContacts] = useState(null);
  const [error, setError] = useState('');
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [keyError, setKeyError] = useState(false);
  const sharedKeyRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    axios.get(`${API}/api/chat/contacts`, { withCredentials: true })
      .then((res) => setContacts(res.data.contacts))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load contacts.'));
  }, []);

  const loadThread = useCallback(async (contact) => {
    setMessages(null);
    setError('');
    setKeyError(false);
    try {
      const myPrivateKey = await getPrivateKey();
      if (!myPrivateKey) { setKeyError(true); return; }
      if (!contact.publicKeyJwk) { setError(`${contact.name} hasn't set up secure chat yet.`); return; }
      const sharedKey = await deriveSharedKey(myPrivateKey, contact.publicKeyJwk);
      sharedKeyRef.current = sharedKey;
      const res = await axios.get(`${API}/api/chat/${contact.id}/messages`, { withCredentials: true });
      const decrypted = await Promise.all(res.data.messages.map(async (m) => ({
        id: m.id,
        fromMe: m.fromMe,
        createdAt: m.createdAt,
        text: await decryptMessage(sharedKey, m.ciphertext, m.iv).catch(() => '[Could not decrypt this message]'),
      })));
      setMessages(decrypted);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load this conversation.');
    }
  }, []);

  const selectContact = (contact) => {
    setSelectedContact(contact);
    loadThread(contact);
  };

  useEffect(() => {
    if (!selectedContact) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, selectedContact]);

  // A push arrives as just {fromUserId} (see lib/realtime.js's own
  // comment on why the payload is deliberately bare) — if it's from
  // whoever's thread we're already looking at, just reload it rather than
  // trying to splice one more decrypted message into local state inline.
  useEffect(() => on('chat-message', ({ fromUserId }) => {
    if (selectedContact && fromUserId === selectedContact.id) loadThread(selectedContact);
  }), [selectedContact, loadThread]);

  const send = async (e) => {
    e.preventDefault();
    if (!draft.trim() || !sharedKeyRef.current || !selectedContact) return;
    setSending(true);
    setError('');
    try {
      const { ciphertext, iv } = await encryptMessage(sharedKeyRef.current, draft.trim());
      await axios.post(`${API}/api/chat/${selectedContact.id}/messages`, { ciphertext, iv }, { withCredentials: true });
      setDraft('');
      await loadThread(selectedContact);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  if (error && !selectedContact) {
    return <div className="alert" role="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  }

  return (
    <div style={{ display: 'flex', gap: 16, minHeight: 420 }}>
      <div className="panel" style={{ width: 220, flexShrink: 0, padding: 8, overflowY: 'auto' }}>
        {!contacts && <p className="sb-loading" style={{ margin: 8 }}>Loading…</p>}
        {contacts && contacts.length === 0 && <p className="sb-loading" style={{ margin: 8 }}>No one to chat with yet.</p>}
        {contacts && contacts.map((c) => (
          <button
            key={c.id}
            type="button"
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 2,
              borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
              background: selectedContact?.id === c.id ? 'var(--surface-3)' : 'transparent',
              color: selectedContact?.id === c.id ? 'var(--accent)' : 'var(--text)',
            }}
            onClick={() => selectContact(c)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="panel" style={{ flex: 1, padding: 16, display: 'flex', flexDirection: 'column' }}>
        {!selectedContact ? (
          <p className="sb-loading">Select someone from the list to start chatting.</p>
        ) : (
          <>
            <h3 style={{ margin: '0 0 12px' }}>{selectedContact.name}</h3>
            {error && <div className="alert" role="alert" style={{ marginBottom: 12 }}><span className="alert-icon">!</span><span>{error}</span></div>}
            {keyError && (
              <div className="alert" role="alert" style={{ marginBottom: 12 }}>
                <span className="alert-icon">!</span>
                <span>Couldn't set up secure chat on this device — try logging out and back in.</span>
              </div>
            )}
            {!messages && !error && !keyError && <p className="sb-loading">Loading…</p>}

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {messages && messages.map((m) => (
                <div key={m.id} style={{ alignSelf: m.fromMe ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                  <div className="panel" style={{ padding: '8px 12px', background: m.fromMe ? 'var(--accent-dim)' : 'var(--surface-2)' }}>
                    {m.text}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, textAlign: m.fromMe ? 'right' : 'left' }}>
                    {formatTime(m.createdAt)}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {!keyError && (
              <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type a message…"
                  disabled={sending || !selectedContact.publicKeyJwk}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)' }}
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !draft.trim() || !selectedContact.publicKeyJwk}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Student-facing top-level Chat page — a private channel to each teacher
// of a subject the student is enrolled in.
export default function Chat() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="chat" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">Chat</h1>
        </div>
        <ChatWidget />
      </section>
    </div>
  );
}
