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

// Mirrors backend/routes/chat.js's own EDIT_WINDOW_MS — this copy is only
// ever used to decide whether to SHOW the Edit link; the server re-checks
// the same 15-minute cutoff itself as the actual source of truth, so a
// stale clock here just means a click that gets rejected, not a real gap.
const EDIT_WINDOW_MS = 15 * 60 * 1000;
function isEditable(m) {
  return m.fromMe && m.messageType === 'text' && !m.pending && !m.error && Date.now() - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS;
}

// Waiting / Delivered / Seen / Error — shown only on the sender's own
// messages, same four states most chat apps surface. pending/error are
// purely local (set by ChatWidget's own send() around the network call);
// readAt comes from the server once the recipient has actually opened
// the thread (see GET /api/chat/:otherUserId/messages).
function statusLabel(m) {
  if (m.pending) return 'Sending…';
  if (m.error) return 'Failed to send';
  return m.readAt ? 'Seen' : 'Delivered';
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

// Same stroke-icon shape as NotificationBell.jsx's BellIcon — one attach
// (photo/video/document, whichever the OS file picker's own type filters
// let through) and one mic button beside the compose box, instead of a
// separate labeled button per attachment type.
function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

// Shared chat UI — contact list + a decrypted thread + compose box. Used
// by both the student-facing top-level page below and
// pages/admin/ChatPanel.jsx's teacher tab; only the page chrome around it
// (header/nav) differs between the two. Every encrypt/decrypt call here
// runs against a shared AES-GCM key re-derived on the fly (deriveSharedKey,
// lib/e2ee.js) from this device's own private key + the contact's public
// key — nothing about the conversation itself is ever computed or stored
// server-side.
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function PlayIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
}
function PauseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" />
      <rect x="14" y="5" width="4" height="14" />
    </svg>
  );
}

// A voice note bubble, WhatsApp-shaped — a native <audio controls> renders
// as the OS's own (always light/white-chrome) media widget, the same
// "jarring inconsistency" every other bare control in this app already
// got its own custom treatment for. The <audio> element itself stays in
// the DOM but visually hidden; everything the user sees/clicks is plain
// HTML driven off its play/pause/timeupdate events.
function VoiceMessagePlayer({ src }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => { setPlaying(false); setCurrentTime(0); };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause(); else audio.play();
    setPlaying(!playing);
  };

  const seek = (e) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 220 }}>
      <audio ref={audioRef} src={src} preload="metadata" style={{ display: 'none' }} />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', flexShrink: 0, background: 'var(--accent)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div
        onClick={seek}
        style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--surface-3)', cursor: 'pointer', position: 'relative' }}
      >
        <div style={{ position: 'absolute', inset: 0, width: `${duration ? (currentTime / duration) * 100 : 0}%`, background: 'var(--accent)', borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0, minWidth: 30, textAlign: 'right' }}>
        {formatDuration(playing || currentTime > 0 ? currentTime : duration)}
      </span>
    </div>
  );
}

// One message bubble's content, branched on messageType — mediaUrl is
// already a decrypted, local blob: URL by the time this renders (see
// ChatWidget's loadThread), never the raw ciphertext bytes the attachment
// proxy route hands back (still opaque until decrypted).
function MessageBubbleContent({ message: m }) {
  if (m.messageType === 'photo' && m.mediaUrl) {
    return <img src={m.mediaUrl} alt="" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 'var(--radius-sm)', display: 'block' }} />;
  }
  if (m.messageType === 'video' && m.mediaUrl) {
    return <video src={m.mediaUrl} controls style={{ maxWidth: 260, borderRadius: 'var(--radius-sm)', display: 'block' }} />;
  }
  if (m.messageType === 'voice' && m.mediaUrl) {
    return <VoiceMessagePlayer src={m.mediaUrl} />;
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
  // Which incoming message currently has its inline "Report" note field
  // open — at most one at a time, closed again on submit/cancel or on
  // switching contacts (see selectContact below).
  const [reportingId, setReportingId] = useState(null);
  const [reportNote, setReportNote] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  // Ids reported this session — flips that message's button to a
  // disabled "Reported" state without needing to reload the whole
  // thread just to reflect one flag.
  const [reportedIds, setReportedIds] = useState(() => new Set());
  // Same shape as the report fields above, for the sender's own "Edit"
  // affordance instead of the recipient's "Report" one.
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const sharedKeyRef = useRef(null);
  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);
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

  // `silent` is set for a background reload triggered by an incoming
  // realtime push (see the 'chat-message' listener below) — without it,
  // every single new message from the other party would blank the whole
  // thread back to a loading spinner and repaint it from scratch, which
  // reads as "the page keeps refreshing" even though it's just this one
  // panel. A silent reload keeps whatever's currently on screen until the
  // freshly-decrypted messages are ready, then swaps in one paint.
  const loadThread = useCallback(async (contact, { silent = false } = {}) => {
    if (!silent) {
      setMessages(null);
      setError('');
      setKeyError(false);
    }
    // Old blob URLs stay alive (and on screen) until the freshly-decrypted
    // ones are ready to replace them — revoking up front, before the new
    // ones exist, would blank every attachment mid-reload even on a
    // normal (non-silent) reload.
    const staleObjectUrls = objectUrlsRef.current;
    objectUrlsRef.current = [];
    try {
      const myPrivateKey = await getPrivateKey(user.id);
      if (!myPrivateKey) { setKeyError(true); objectUrlsRef.current = staleObjectUrls; return; }
      if (!contact.publicKeyJwk) { setError(`${contact.name} hasn't set up secure chat yet.`); objectUrlsRef.current = staleObjectUrls; return; }
      const sharedKey = await deriveSharedKey(myPrivateKey, contact.publicKeyJwk);
      sharedKeyRef.current = sharedKey;
      const res = await axios.get(`${API}/api/chat/${contact.id}/messages`, { withCredentials: true });
      const decrypted = await Promise.all(res.data.messages.map(async (m) => {
        const base = { id: m.id, fromMe: m.fromMe, createdAt: m.createdAt, messageType: m.messageType, readAt: m.readAt, editedAt: m.editedAt, reportedByMe: m.reportedByMe };
        if (m.messageType === 'text') {
          return { ...base, text: await decryptMessage(sharedKey, m.ciphertext, m.iv).catch(() => '[Could not decrypt this message]') };
        }
        try {
          // axios, not a bare fetch — this now goes through OUR OWN API
          // (GET /api/chat/:otherUserId/messages/:messageId/attachment),
          // not a presigned B2 URL directly: B2 sends no CORS headers on
          // these objects, so a browser fetch() reading the response body
          // cross-origin would simply never succeed (see that route's own
          // comment). Proxying through this origin needs the session
          // token attached — axios's shared instance already carries it
          // via AuthContext.jsx's setAuthHeader, unlike the old direct-to-
          // B2 request this replaced.
          const attRes = await axios.get(
            `${API}/api/chat/${contact.id}/messages/${m.id}/attachment`,
            { withCredentials: true, responseType: 'arraybuffer' }
          );
          const plainBuf = await decryptBytes(sharedKey, attRes.data, m.iv);
          const url = URL.createObjectURL(new Blob([plainBuf], { type: DEFAULT_MIME[m.messageType] || 'application/octet-stream' }));
          objectUrlsRef.current.push(url);
          return { ...base, mediaUrl: url };
        } catch {
          return { ...base, mediaUrl: null, text: '[Could not load this attachment]' };
        }
      }));
      setMessages(decrypted);
      staleObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    } catch (err) {
      objectUrlsRef.current = staleObjectUrls;
      if (!silent) setError(err.response?.data?.error || 'Failed to load this conversation.');
    }
  }, [user.id]);

  const selectContact = (contact) => {
    setSelectedContact(contact);
    setPendingAttachment(null);
    setReportingId(null);
    setReportNote('');
    setReportedIds(new Set());
    setEditingId(null);
    setEditDraft('');
    loadThread(contact);
  };

  const submitReport = async (message) => {
    if (!selectedContact) return;
    setReportBusy(true);
    try {
      await axios.post(
        `${API}/api/chat/${selectedContact.id}/messages/${message.id}/report`,
        { plaintextContent: message.text, note: reportNote.trim() || undefined },
        { withCredentials: true }
      );
      setReportedIds((prev) => new Set(prev).add(message.id));
      setReportingId(null);
      setReportNote('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to report this message.');
    } finally {
      setReportBusy(false);
    }
  };

  const submitEdit = async (message) => {
    if (!selectedContact || !sharedKeyRef.current || !editDraft.trim()) return;
    setEditBusy(true);
    try {
      const { ciphertext, iv } = await encryptMessage(sharedKeyRef.current, editDraft.trim());
      await axios.put(
        `${API}/api/chat/${selectedContact.id}/messages/${message.id}`,
        { ciphertext, iv },
        { withCredentials: true }
      );
      setEditingId(null);
      setEditDraft('');
      await loadThread(selectedContact, { silent: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to edit this message.');
    } finally {
      setEditBusy(false);
    }
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
    if (selectedContact && fromUserId === selectedContact.id) loadThread(selectedContact, { silent: true });
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
    const contact = selectedContact;
    const attachment = pendingAttachment;
    const textDraft = draft.trim();

    // Optimistic bubble, shown instantly (before encryption/upload even
    // starts) — this is the "Waiting" state. For an attachment, previewing
    // straight from the picked File's own blob URL needs no decryption
    // (we still hold the original bytes at this point); pushed into the
    // same objectUrlsRef the real thread reload already sweeps, so it's
    // revoked like any other attachment URL once superseded.
    const tempId = `temp-${Date.now()}`;
    const optimistic = { id: tempId, fromMe: true, createdAt: new Date().toISOString(), messageType: attachment ? attachment.messageType : 'text', pending: true };
    if (attachment) {
      const previewUrl = URL.createObjectURL(attachment.file);
      objectUrlsRef.current.push(previewUrl);
      optimistic.mediaUrl = previewUrl;
    } else {
      optimistic.text = textDraft;
    }
    setMessages((prev) => [...(prev || []), optimistic]);
    setDraft('');
    setPendingAttachment(null);
    setSending(true);
    setError('');
    try {
      const formData = new FormData();
      if (attachment) {
        const bytes = await attachment.file.arrayBuffer();
        const { ciphertext, iv } = await encryptBytes(sharedKeyRef.current, bytes);
        formData.append('messageType', attachment.messageType);
        formData.append('iv', iv);
        formData.append('file', new Blob([ciphertext]));
      } else {
        const { ciphertext, iv } = await encryptMessage(sharedKeyRef.current, textDraft);
        formData.append('messageType', 'text');
        formData.append('iv', iv);
        formData.append('ciphertext', ciphertext);
      }
      await axios.post(`${API}/api/chat/${contact.id}/messages`, formData, { withCredentials: true });
      // Silent — the optimistic bubble above already kept the thread on
      // screen the whole time; a full reload here would otherwise re-blank
      // it right as the real message arrives.
      await loadThread(contact, { silent: true });
    } catch (err) {
      setMessages((prev) => (prev || []).map((m) => (m.id === tempId ? { ...m, pending: false, error: true } : m)));
      setError(err.response?.data?.error || 'Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  if (error && !selectedContact) {
    return <div className="alert" role="alert"><span className="alert-icon">!</span><span>{error}</span></div>;
  }

  return (
    <div className="chat-shell">
      <div className={`panel chat-sidebar${selectedContact ? ' chat-sidebar-collapsed' : ''}`}>
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

      <div className={`panel chat-main${!selectedContact ? ' chat-main-collapsed' : ''}`}>
        {!selectedContact ? (
          <p className="sb-loading">Select someone from the list to start chatting.</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <button type="button" className="chat-back-btn btn btn-ghost btn-sm" onClick={() => setSelectedContact(null)}>← Back</button>
              <h3 style={{ margin: 0 }}>{selectedContact.name}</h3>
            </div>
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
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, textAlign: m.fromMe ? 'right' : 'left', display: 'flex', gap: 8, justifyContent: m.fromMe ? 'flex-end' : 'flex-start' }}>
                    <span>{formatTime(m.createdAt)}</span>
                    {m.editedAt && <span>(edited)</span>}
                    {m.fromMe && <span style={m.error ? { color: 'var(--danger)' } : undefined}>{statusLabel(m)}</span>}
                    {/* Only incoming text messages are reportable — chat is
                        genuinely E2E encrypted, so this plaintext only
                        exists because THIS browser already decrypted it;
                        the server never sees message content otherwise. */}
                    {!m.fromMe && m.messageType === 'text' && (
                      m.reportedByMe || reportedIds.has(m.id) ? (
                        <span style={{ color: 'var(--danger)' }}>Reported</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setReportingId(m.id); setReportNote(''); }}
                          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
                        >
                          Report
                        </button>
                      )
                    )}
                    {/* Same "own plaintext, own device" reasoning as
                        Report above — editing re-encrypts m.text, which
                        only exists here because this browser already
                        decrypted it. */}
                    {isEditable(m) && editingId !== m.id && (
                      <button
                        type="button"
                        onClick={() => { setEditingId(m.id); setEditDraft(m.text); }}
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {reportingId === m.id && (
                    <div className="panel" style={{ padding: '8px 12px', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input
                        value={reportNote}
                        onChange={(e) => setReportNote(e.target.value)}
                        placeholder="Add a note (optional)…"
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={reportBusy} onClick={() => setReportingId(null)}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" disabled={reportBusy} onClick={() => submitReport(m)}>
                          {reportBusy ? 'Reporting…' : 'Confirm report'}
                        </button>
                      </div>
                    </div>
                  )}
                  {editingId === m.id && (
                    <div className="panel" style={{ padding: '8px 12px', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={editBusy} onClick={() => setEditingId(null)}>Cancel</button>
                        <button type="button" className="btn btn-primary btn-sm" disabled={editBusy || !editDraft.trim()} onClick={() => submitEdit(m)}>
                          {editBusy ? 'Saving…' : 'Save edit'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {!keyError && (
              <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*,application/pdf"
                  style={{ display: 'none' }}
                  onChange={pickFile}
                />
                {pendingAttachment ? (
                  <div className="panel" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13 }}>Ready to send: {pendingAttachment.messageType}</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingAttachment(null)}>Cancel</button>
                      <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={send}>
                        {sending ? 'Sending…' : 'Send attachment'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Attach a photo, video, or document"
                      title="Attach a photo, video, or document"
                      disabled={sending || !selectedContact.publicKeyJwk}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <PaperclipIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={recording ? 'Stop recording' : 'Record a voice message'}
                      title={recording ? 'Stop recording' : 'Record a voice message'}
                      aria-expanded={recording}
                      disabled={sending || !selectedContact.publicKeyJwk}
                      onClick={recording ? stopRecording : startRecording}
                    >
                      <MicIcon />
                    </button>
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
