import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import { useAuth } from '../context/AuthContext';
import { API } from '../config';
import { getPrivateKey } from '../lib/e2eeKeyStore';
import { deriveSharedKey, encryptMessage, decryptMessage, encryptBytes, decryptBytes } from '../lib/e2ee';
import { on } from '../lib/realtime';
import '../admin.css';

function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The server never learns a chat attachment's real MIME type — it's just
// encrypted bytes to it (see routes/chat.js's own comment) — so the
// client falls back to one representative type per messageType when
// reconstructing a playable/viewable Blob after decryption. Imprecise for
// an unusual subtype (a .webp sent as "photo" gets labeled image/jpeg),
// but browsers render from the actual decoded bytes regardless of this
// label in practice, and the alternative (separately encrypting/storing
// the real MIME type) is complexity this app doesn't need for a for-now
// "does it play" bar.
const DEFAULT_MIME = { photo: 'image/jpeg', video: 'video/mp4', voice: 'audio/webm', document: 'application/pdf' };

function attachmentTypeFor(file) {
  if (file.type.startsWith('image/')) return 'photo';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type === 'application/pdf') return 'document';
  return null;
}

// Shared chat UI — contact list + a decrypted thread + compose box. Used
// by both the student-facing top-level page below and
// pages/admin/ChatPanel.jsx's teacher tab; only the page chrome around it
// (header/nav) differs between the two. Every encrypt/decrypt call here
// runs against a shared AES-GCM key re-derived on the fly (deriveSharedKey,
// lib/e2ee.js) from this device's own private key + the contact's public
// key — nothing about the conversation itself is ever computed or stored
// server-side.
// One message bubble's content, branched on messageType — mediaUrl is
// already a decrypted, local blob: URL by the time this renders (see
// ChatWidget's loadThread), never the raw attachmentUrl the server gave
// back (which is still ciphertext until decrypted).
function MessageBubbleContent({ message: m }) {
  if (m.messageType === 'photo' && m.mediaUrl) {
    return <img src={m.mediaUrl} alt="" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 'var(--radius-sm)', display: 'block' }} />;
  }
  if (m.messageType === 'video' && m.mediaUrl) {
    return <video src={m.mediaUrl} controls style={{ maxWidth: 260, borderRadius: 'var(--radius-sm)', display: 'block' }} />;
  }
  if (m.messageType === 'voice' && m.mediaUrl) {
    return <audio src={m.mediaUrl} controls style={{ display: 'block' }} />;
  }
  if (m.messageType === 'document' && m.mediaUrl) {
    return <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">View document</a>;
  }
  return m.text;
}

export function ChatWidget() {
  const { user } = useAuth();
  const [contacts, setContacts] = useState(null);
  const [error, setError] = useState('');
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState(null); // { file, messageType } | null
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [keyError, setKeyError] = useState(false);
  const sharedKeyRef = useRef(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
  const docInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  // Blob URLs created for decrypted attachments — never persisted, just
  // handed to <img>/<video>/<audio> for this render; revoked whenever the
  // thread reloads or the widget unmounts so decrypted media doesn't sit
  // around in memory once it's off-screen.
  const objectUrlsRef = useRef([]);
  const revokeObjectUrls = () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
  };
  useEffect(() => () => revokeObjectUrls(), []);

  useEffect(() => {
    axios.get(`${API}/api/chat/contacts`, { withCredentials: true })
      .then((res) => setContacts(res.data.contacts))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load contacts.'));
  }, []);

  const loadThread = useCallback(async (contact) => {
    setMessages(null);
    setError('');
    setKeyError(false);
    revokeObjectUrls();
    try {
      const myPrivateKey = await getPrivateKey(user.id);
      if (!myPrivateKey) { setKeyError(true); return; }
      if (!contact.publicKeyJwk) { setError(`${contact.name} hasn't set up secure chat yet.`); return; }
      const sharedKey = await deriveSharedKey(myPrivateKey, contact.publicKeyJwk);
      sharedKeyRef.current = sharedKey;
      const res = await axios.get(`${API}/api/chat/${contact.id}/messages`, { withCredentials: true });
      const decrypted = await Promise.all(res.data.messages.map(async (m) => {
        const base = { id: m.id, fromMe: m.fromMe, createdAt: m.createdAt, messageType: m.messageType };
        if (m.messageType === 'text') {
          return { ...base, text: await decryptMessage(sharedKey, m.ciphertext, m.iv).catch(() => '[Could not decrypt this message]') };
        }
        try {
          // A plain fetch, not axios — this is a presigned B2 URL, a
          // different host entirely, and axios's shared instance carries
          // our own Authorization header on every request by default
          // (see AuthContext.jsx's setAuthHeader) — sending our session
          // token to a third-party storage host would be a real leak, on
          // top of possibly breaking the presigned request's own signature
          // validation. A bare fetch() never touches axios's defaults.
          const attRes = await fetch(m.attachmentUrl);
          const cipherBuf = await attRes.arrayBuffer();
          const plainBuf = await decryptBytes(sharedKey, cipherBuf, m.iv);
          const url = URL.createObjectURL(new Blob([plainBuf], { type: DEFAULT_MIME[m.messageType] || 'application/octet-stream' }));
          objectUrlsRef.current.push(url);
          return { ...base, mediaUrl: url };
        } catch {
          return { ...base, mediaUrl: null, text: '[Could not load this attachment]' };
        }
      }));
      setMessages(decrypted);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load this conversation.');
    }
  }, [user.id]);

  const selectContact = (contact) => {
    setSelectedContact(contact);
    setPendingAttachment(null);
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

  const pickFile = (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // so picking the exact same file again still fires onChange
    if (!file) return;
    const messageType = attachmentTypeFor(file);
    if (!messageType) { setError('Attachments must be a photo, video, or PDF.'); return; }
    setError('');
    setPendingAttachment({ file, messageType });
  };

  const startRecording = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setPendingAttachment({ file: new Blob(recordedChunksRef.current, { type: 'audio/webm' }), messageType: 'voice' });
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError("Couldn't access your microphone.");
    }
  };
  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const send = async (e) => {
    e.preventDefault();
    if (!sharedKeyRef.current || !selectedContact) return;
    if (!pendingAttachment && !draft.trim()) return;
    setSending(true);
    setError('');
    try {
      const formData = new FormData();
      if (pendingAttachment) {
        const bytes = await pendingAttachment.file.arrayBuffer();
        const { ciphertext, iv } = await encryptBytes(sharedKeyRef.current, bytes);
        formData.append('messageType', pendingAttachment.messageType);
        formData.append('iv', iv);
        formData.append('file', new Blob([ciphertext]));
      } else {
        const { ciphertext, iv } = await encryptMessage(sharedKeyRef.current, draft.trim());
        formData.append('messageType', 'text');
        formData.append('iv', iv);
        formData.append('ciphertext', ciphertext);
      }
      await axios.post(`${API}/api/chat/${selectedContact.id}/messages`, formData, { withCredentials: true });
      setDraft('');
      setPendingAttachment(null);
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
                    <MessageBubbleContent message={m} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, textAlign: m.fromMe ? 'right' : 'left' }}>
                    {formatTime(m.createdAt)}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {!keyError && (
              <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pendingAttachment ? (
                  <div className="panel" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13 }}>Ready to send: {pendingAttachment.messageType}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingAttachment(null)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
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
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    style={{ display: 'none' }}
                    onChange={pickFile}
                  />
                  <input
                    ref={docInputRef}
                    type="file"
                    accept="application/pdf"
                    style={{ display: 'none' }}
                    onChange={pickFile}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={sending || !selectedContact.publicKeyJwk || !!pendingAttachment}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Photo / Video
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={sending || !selectedContact.publicKeyJwk || !!pendingAttachment}
                    onClick={() => docInputRef.current?.click()}
                  >
                    Document
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={sending || !selectedContact.publicKeyJwk || !!pendingAttachment}
                    onClick={recording ? stopRecording : startRecording}
                  >
                    {recording ? 'Stop recording' : 'Record voice'}
                  </button>
                  {pendingAttachment && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={send}>
                      {sending ? 'Sending…' : 'Send attachment'}
                    </button>
                  )}
                </div>
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
