import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { formatDate } from '../lib/formatDate';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import SpaceSwitcher, { SpaceNotifications } from '../components/SpaceSwitcher';
import { API } from '../config';
import '../admin.css';

const STATUS_CLASS = { open: 'chip-medium', answered: 'chip-easy' };

function DocumentIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

// A doubt's attachment, shown small next to its card in every list (board,
// My Doubts, the teacher's queue) — same object either way (an image, a
// short video, or a document), just cropped square rather than shown at
// full size the way DoubtDetail renders it. Video gets no controls/poster
// of its own (pointerEvents: 'none' so a click on it still opens the card
// like the rest of it) — the browser's own first frame is enough of a
// preview here. A document has no visual preview to speak of, so it's
// just an icon in the same-sized slot for layout consistency.
function AttachmentThumb({ attachmentType, attachmentUrl }) {
  if (!attachmentUrl) return null;
  const style = {
    width: 56, height: 56, borderRadius: 'var(--radius-sm)', objectFit: 'cover',
    flexShrink: 0, border: '1px solid var(--border)', background: 'var(--surface-2)',
  };
  if (attachmentType === 'photo') return <img src={attachmentUrl} alt="Attachment preview" style={style} />;
  if (attachmentType === 'video') return <video src={attachmentUrl} muted playsInline preload="metadata" style={{ ...style, pointerEvents: 'none' }} />;
  if (attachmentType === 'document') {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
        <DocumentIcon />
      </div>
    );
  }
  return null;
}

// One row in any doubt list — shared by BoardTab/MineTab below and by
// pages/admin/DoubtsPanel.jsx's teacher queue, so the thumbnail/status-chip
// layout only exists in one place. `caption` is the one line of context
// that actually differs per list (who asked it, which subject, etc.).
export function DoubtCard({ doubt: d, caption, onOpen }) {
  return (
    <div className="panel" style={{ padding: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }} onClick={() => onOpen(d.id)}>
      <AttachmentThumb attachmentType={d.attachmentType} attachmentUrl={d.attachmentUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-h)' }}>{d.questionText}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 6 }}>{caption}</div>
      </div>
      {/* Sibling of the text block, not nested inside its header row —
          alignItems: 'center' on the outer row (above) is what actually
          centers this against the card's full height (thumbnail + two
          lines of text), not just against the question line next to it. */}
      <span className={`chip ${STATUS_CLASS[d.status]}`} style={{ flexShrink: 0 }}><span className="dot" />{d.status}</span>
    </div>
  );
}

// The public per-subject board — every doubt asked in this subject, any
// teacher, so a student can check "has this already been answered" before
// posting. Asker identity is whatever GET /api/doubts already redacted
// server-side (null unless it's the viewer's own) — this just renders
// whatever it got.
function BoardTab({ subjects, subjectId, setSubjectId, onOpen }) {
  const [search, setSearch] = useState('');
  const [doubts, setDoubts] = useState(null);
  const [error, setError] = useState('');

  const fetchDoubts = useCallback(() => {
    if (!subjectId) { setDoubts(null); return; }
    setError('');
    axios.get(`${API}/api/doubts`, { params: { subjectId, search: search.trim() || undefined }, withCredentials: true })
      .then((res) => setDoubts(res.data.doubts))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load doubts.'));
  }, [subjectId, search]);

  useEffect(() => { fetchDoubts(); }, [fetchDoubts]);

  return (
    <>
      <div className="admin-toolbar" style={{ gap: 8 }}>
        <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">Select subject…</option>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.org_unit_name})</option>)}
        </select>
        {subjectId && (
          <input
            placeholder="Search doubts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-h)', minWidth: 220 }}
          />
        )}
      </div>

      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!subjectId && <p className="sb-loading">Select a subject to browse doubts asked in it.</p>}
      {doubts && doubts.length === 0 && <p className="sb-loading">No doubts asked yet — be the first.</p>}

      {doubts && doubts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {doubts.map((d) => (
            <DoubtCard
              key={d.id}
              doubt={d}
              onOpen={onOpen}
              caption={<>Asked by {d.isMine ? 'you' : (d.askerName || 'Anonymous')} to {d.teacherName || 'any teacher'} · {formatDate(d.createdAt)}</>}
            />
          ))}
        </div>
      )}
    </>
  );
}

// Ask-a-doubt compose form. The "check for similar doubts" step is
// deliberately not optional client-side (checked resets to false whenever
// the subject or question text changes — see the effect below) — a
// student always sees whatever candidates exist for their exact current
// draft before the Post button is even reachable, though nothing stops
// them posting anyway once they've seen it (this only ever surfaces
// candidates, never blocks — see GET /api/doubts/similar's own comment).
function AskTab({ subjects, onPosted }) {
  const [subjectId, setSubjectId] = useState('');
  const [teachers, setTeachers] = useState([]);
  const [teacherId, setTeacherId] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [file, setFile] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setTeacherId('');
    setTeachers([]);
    if (!subjectId) return;
    axios.get(`${API}/api/doubts/subjects/${subjectId}/teachers`, { withCredentials: true })
      .then((res) => setTeachers(res.data.teachers))
      .catch(() => setError('Failed to load teachers for this subject.'));
  }, [subjectId]);

  useEffect(() => { setChecked(false); setSimilar([]); }, [subjectId, questionText]);

  const checkSimilar = async () => {
    if (!subjectId || !questionText.trim()) return;
    setChecking(true);
    setError('');
    try {
      const res = await axios.get(`${API}/api/doubts/similar`, { params: { subjectId, q: questionText.trim() }, withCredentials: true });
      setSimilar(res.data.doubts);
      setChecked(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to check for similar doubts.');
    } finally {
      setChecking(false);
    }
  };

  const post = async () => {
    if (!subjectId || !questionText.trim()) return;
    setPosting(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('subjectId', subjectId);
      if (teacherId) formData.append('teacherId', teacherId);
      formData.append('questionText', questionText.trim());
      if (file) formData.append('file', file);
      const res = await axios.post(`${API}/api/doubts`, formData, { withCredentials: true });
      setQuestionText('');
      setFile(null);
      onPosted(res.data.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to post your doubt.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="panel" style={{ padding: 20, maxWidth: 640 }}>
      <div className="field" style={{ marginBottom: 14 }}>
        <label htmlFor="doubt-subject">Subject</label>
        <select id="doubt-subject" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
          <option value="">Select subject…</option>
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.org_unit_name})</option>)}
        </select>
      </div>

      {subjectId && teachers.length > 0 && (
        <div className="field" style={{ marginBottom: 14 }}>
          <label htmlFor="doubt-teacher">Which teacher? (optional)</label>
          <select id="doubt-teacher" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">Any teacher of this subject</option>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name || t.email}</option>)}
          </select>
          <p className="auth-sub" style={{ margin: '6px 0 0' }}>
            Leave this on "Any teacher" and every teacher of this subject can see and answer it — pick one to send it
            to just them instead.
          </p>
        </div>
      )}
      {subjectId && teachers.length === 0 && (
        <p className="auth-sub" style={{ margin: '0 0 14px' }}>This subject has no teacher assigned yet.</p>
      )}

      <div className="field" style={{ marginBottom: 14 }}>
        <label htmlFor="doubt-question">Your question</label>
        <textarea
          id="doubt-question"
          rows={4}
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
          placeholder="What are you stuck on?"
          style={{ width: '100%', resize: 'vertical' }}
        />
      </div>

      <div className="field" style={{ marginBottom: 14 }}>
        <label htmlFor="doubt-file">Attach a photo, video, or PDF (optional)</label>
        <input
          id="doubt-file"
          type="file"
          accept="image/*,video/*,application/pdf"
          onChange={(e) => setFile(e.target.files[0] || null)}
        />
      </div>

      {error && <div className="alert" style={{ marginBottom: 14 }}><span className="alert-icon">!</span><span>{error}</span></div>}

      {!checked ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={!subjectId || !questionText.trim() || checking}
          onClick={checkSimilar}
        >
          {checking ? 'Checking…' : 'Check for similar doubts'}
        </button>
      ) : (
        <>
          {similar.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <p className="auth-sub" style={{ margin: '0 0 8px' }}>
                These already-asked doubts in this subject look similar — worth a look before you post:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {similar.map((s) => (
                  <div key={s.id} className="panel" style={{ padding: 12 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-h)' }}>{s.questionText}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 4 }}>
                      {s.firstTeacherReply ? `Answer: ${s.firstTeacherReply}` : 'Not answered yet'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" disabled={posting} onClick={() => setChecked(false)}>Back</button>
            <button type="button" className="btn btn-primary" disabled={posting} onClick={post}>
              {posting ? 'Posting…' : similar.length > 0 ? 'Post my doubt anyway' : 'Post my doubt'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// A student's own doubts, any subject, own identity never redacted (see
// GET /api/doubts/mine — it's all theirs to begin with).
function MineTab({ onOpen }) {
  const [doubts, setDoubts] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`${API}/api/doubts/mine`, { withCredentials: true })
      .then((res) => setDoubts(res.data.doubts))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load your doubts.'));
  }, []);

  return (
    <>
      {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!doubts && !error && <p className="sb-loading">Loading…</p>}
      {doubts && doubts.length === 0 && <p className="sb-loading">You haven't asked any doubts yet.</p>}

      {doubts && doubts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {doubts.map((d) => (
            <DoubtCard
              key={d.id}
              doubt={d}
              onOpen={onOpen}
              caption={<>{d.subjectName} · asked to {d.teacherName || 'any teacher'} · {formatDate(d.createdAt)}</>}
            />
          ))}
        </div>
      )}
    </>
  );
}

// Shared thread view — reached from the board, My Doubts, or the teacher's
// own queue panel alike (see pages/admin/DoubtsPanel.jsx). Reply box only
// renders when the backend has actually confirmed this viewer is the
// asker or the assigned teacher (isMine on the doubt itself, or the
// viewer's own role being 'teacher' — GET /api/doubts/:id already 403s a
// teacher who isn't the assigned one before this ever renders, so any
// teacher who successfully loaded this IS the assigned one).
export function DoubtDetail({ doubtId, onBack, role }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [replyText, setReplyText] = useState('');
  const [posting, setPosting] = useState(false);

  const fetchDetail = useCallback(() => {
    setError('');
    axios.get(`${API}/api/doubts/${doubtId}`, { withCredentials: true })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load this doubt.'));
  }, [doubtId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const postReply = async () => {
    if (!replyText.trim()) return;
    setPosting(true);
    setError('');
    try {
      await axios.post(`${API}/api/doubts/${doubtId}/replies`, { bodyText: replyText.trim() }, { withCredentials: true });
      setReplyText('');
      fetchDetail();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to post your reply.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }} onClick={onBack}>← Back</button>

      {error && !data && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}
      {!data && !error && <p className="sb-loading">Loading…</p>}

      {data && (() => {
        const { doubt, replies } = data;
        const canReply = role === 'teacher' || (role === 'student' && doubt.isMine);
        return (
          <>
            <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{doubt.subjectName}</h3>
                <span className={`chip ${STATUS_CLASS[doubt.status]}`}><span className="dot" />{doubt.status}</span>
              </div>
              <p className="auth-sub" style={{ margin: '4px 0 12px' }}>
                Asked by {doubt.isMine ? 'you' : (doubt.askerName || 'Anonymous')} to {doubt.teacherName || 'any teacher'} · {formatDate(doubt.createdAt)}
              </p>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{doubt.questionText}</p>
              {doubt.attachmentUrl && doubt.attachmentType === 'photo' && (
                <img src={doubt.attachmentUrl} alt="Doubt attachment" style={{ maxWidth: '100%', borderRadius: 'var(--radius-sm)', marginTop: 12 }} />
              )}
              {doubt.attachmentUrl && doubt.attachmentType === 'video' && (
                <video src={doubt.attachmentUrl} controls style={{ maxWidth: '100%', borderRadius: 'var(--radius-sm)', marginTop: 12 }} />
              )}
              {doubt.attachmentUrl && doubt.attachmentType === 'document' && (
                <a href={doubt.attachmentUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm" style={{ marginTop: 12 }}>
                  <DocumentIcon /> View document
                </a>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {replies.length === 0 && <p className="sb-loading">No replies yet.</p>}
              {replies.map((r) => (
                <div key={r.id} className="panel" style={{ padding: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: r.authorRole === 'teacher' ? 'var(--accent)' : 'var(--text-h)' }}>
                    {r.authorRole === 'teacher' ? `${r.authorName} (teacher)` : r.authorName}
                  </div>
                  <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{r.bodyText}</p>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{formatDate(r.createdAt)}</div>
                </div>
              ))}
            </div>

            {error && <div className="alert" style={{ marginBottom: 16 }}><span className="alert-icon">!</span><span>{error}</span></div>}

            {canReply && (
              <div className="panel" style={{ padding: 16 }}>
                <textarea
                  rows={3}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Write a reply…"
                  style={{ width: '100%', resize: 'vertical' }}
                />
                <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }} disabled={posting || !replyText.trim()} onClick={postReply}>
                  {posting ? 'Posting…' : 'Post reply'}
                </button>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

// Student-facing Doubts space — ask a subject's teacher a question, browse
// (and search) every doubt already asked in a subject before posting a
// near-duplicate, and track the ones you've personally asked. See
// ensureDoubtsSchema's own comment in schema/index.js for the full
// visibility model (public per-subject board, redacted asker identity;
// narrow per-teacher answering queue — that queue is pages/admin/
// DoubtsPanel.jsx, a teacher's own tab inside /admin, not this page).
export default function Doubts() {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { role } = useAuth();

  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [tab, setTab] = useState('board');
  const [selectedDoubtId, setSelectedDoubtId] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/doubts/subjects`, { withCredentials: true })
      .then((res) => setSubjects(res.data.subjects))
      .catch(() => {});
  }, []);

  const openDoubt = (id) => setSelectedDoubtId(id);

  return (
    <div className="sb-shell">
      <header className="sb-topbar">
        <button type="button" className="brand" onClick={() => navigate('/')}><BrandMark /></button>
        <div className="sb-actions">
          <SpaceSwitcher activeTab="doubts" />
          <SpaceNotifications />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-head">
          <h1 className="problems-title">Doubts</h1>
          {!selectedDoubtId && (
            <div className="segmented" role="tablist" aria-label="Doubts section">
              <button type="button" role="tab" aria-pressed={tab === 'board'} className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>Board</button>
              <button type="button" role="tab" aria-pressed={tab === 'ask'} className={tab === 'ask' ? 'active' : ''} onClick={() => setTab('ask')}>Ask a Doubt</button>
              <button type="button" role="tab" aria-pressed={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>My Doubts</button>
            </div>
          )}
        </div>

        {selectedDoubtId ? (
          <DoubtDetail doubtId={selectedDoubtId} role={role} onBack={() => setSelectedDoubtId(null)} />
        ) : tab === 'board' ? (
          <BoardTab subjects={subjects} subjectId={subjectId} setSubjectId={setSubjectId} onOpen={openDoubt} />
        ) : tab === 'ask' ? (
          <AskTab subjects={subjects} onPosted={openDoubt} />
        ) : (
          <MineTab onOpen={openDoubt} />
        )}
      </section>
    </div>
  );
}
