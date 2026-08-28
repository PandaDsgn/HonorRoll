import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { API } from '../config';
import '../Assistant.css';

const OPEN_KEY = 'honorroll_assistant_open';

// Matches /exams/:id (an in-progress attempt) but NOT /exams (the list) or
// /exams/:id/result — the widget hides itself only while a timed/proctored
// attempt is actually active, reappearing the moment it's submitted.
const EXAM_ATTEMPT_PATH = /^\/exams\/[^/]+$/;

function ChatIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export default function AssistantWidget() {
  const { user } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  }, [open]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, sending, open]);

  if (!user || EXAM_ATTEMPT_PATH.test(location.pathname)) return null;

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setDraft('');
    setError(null);
    setSending(true);
    try {
      const res = await axios.post(`${API}/api/assistant/chat`, { messages: next });
      setMessages((cur) => [...cur, { role: 'assistant', content: res.data.reply }]);
    } catch {
      setError('Assistant is unavailable right now — try again in a bit.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      {!open && (
        <button type="button" className="assistant-fab" onClick={() => setOpen(true)} aria-label="Open assistant" title="Assistant">
          <ChatIcon />
        </button>
      )}

      {open && (
        <div className="assistant-panel">
          <div className="assistant-header">
            <span>Assistant</span>
            <button type="button" className="assistant-collapse-btn" onClick={() => setOpen(false)} aria-label="Collapse assistant">
              <CloseIcon />
            </button>
          </div>

          <div className="assistant-messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="assistant-empty">
                Ask me how to do something in HonorRoll — where a feature lives, how a workflow works, or why something looks stuck. I can't help with assignments, exams, or coursework itself — that's your teacher's and the IDE's job.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`assistant-bubble assistant-bubble-${m.role}`}>{m.content}</div>
            ))}
            {sending && <div className="assistant-bubble assistant-bubble-assistant assistant-thinking">Thinking…</div>}
            {error && <div className="assistant-bubble assistant-bubble-error">{error}</div>}
          </div>

          <div className="assistant-input-row">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask how to do something…"
              rows={1}
              disabled={sending}
            />
            <button type="button" className="assistant-send-btn" onClick={send} disabled={sending || !draft.trim()} aria-label="Send">
              <SendIcon />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
