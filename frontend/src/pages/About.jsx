import { useNavigate } from 'react-router-dom';
import LegalShell from '../components/LegalShell';

const FEATURES = [
  {
    title: 'Code assignments, judged instantly',
    body: 'Students write and run real code against hidden and sample test cases, in whatever language the assignment allows — graded the moment they submit, no waiting on a teacher to run it by hand.',
  },
  {
    title: 'Scanned handwritten answers, OCR-read',
    body: 'Not every subject is code. A student photographs or scans a handwritten answer sheet; HonorRoll transcribes it and hands the teacher an AI-assisted first pass on each answer — the teacher always makes the final call.',
  },
  {
    title: 'Timed exams with real proctoring',
    body: 'Multiple-choice, short/long answer, and coding questions in one exam. Optional webcam/microphone proctoring flags tab-switching, lost focus, or a face going missing — logged for the teacher, not auto-penalized.',
  },
  {
    title: 'Plagiarism & integrity signals',
    body: 'Code submissions are compared against each other for suspicious similarity; scanned answers get the same treatment for handwriting. Both surface as flags for a teacher to review, never an automatic verdict.',
  },
  {
    title: 'Performance analytics that mean something',
    body: 'Percentile and grade-band tags a student actually understands, plus per-assignment and per-exam graphs — score trend, percentile standing, and a question-by-question breakdown, not just a single average.',
  },
  {
    title: 'Your institution\'s own structure',
    body: 'Build your actual hierarchy — campus, department, year, section, whatever tiers your institution really has — instead of being forced into someone else\'s idea of "class" and "section".',
  },
  {
    title: 'Bulk onboarding, not one-by-one',
    body: 'Import a whole roster from a CSV, or wire up a Google Form so new students land in the right class automatically. Bring last year\'s scores in too, so a fresh HonorRoll rollout doesn\'t start with a blank slate.',
  },
  {
    title: 'Multi-institution accounts, done right',
    body: 'The same person can be a student at one institution and a teacher at another, under one login — HonorRoll keeps every institution\'s data completely isolated from every other, regardless.',
  },
];

const PERKS = [
  'One platform for assignments, exams, proctoring, and analytics — not four separate tools stitched together with CSV exports.',
  'Every institution is its own isolated workspace: your students, your structure, your grading rules, never mixed with anyone else\'s.',
  'Transparent, per-student pricing that scales with your institution — see exact plan pricing before you ever talk to anyone.',
  'Nothing here is a black box: every automated grading aid, plagiarism flag, and proctoring signal is a suggestion for a human, never the final word.',
];

export default function About() {
  const navigate = useNavigate();

  return (
    <LegalShell>
      <h1>About HonorRoll</h1>
      <p className="legal-updated">Where assignments earn their grade.</p>

      <p>
        HonorRoll is a single platform for a school, college, or coaching institution to run
        assignments, exams, and academic performance tracking — replacing the usual patchwork of a
        separate code judge, a separate exam tool, a separate plagiarism checker, and a spreadsheet
        for tracking who's actually doing well.
      </p>

      <h2>What you get</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, margin: '16px 0 32px' }}>
        {FEATURES.map((f) => (
          <div key={f.title} className="panel" style={{ padding: 18 }}>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{f.title}</h3>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0, color: 'var(--text)' }}>{f.body}</p>
          </div>
        ))}
      </div>

      <h2>Why institutions choose HonorRoll</h2>
      <ul>
        {PERKS.map((p) => <li key={p}>{p}</li>)}
      </ul>

      <h2>Built for every role</h2>
      <p>
        <strong>Admins</strong> get a full picture of their institution — roster, structure, billing,
        and oversight — without needing to touch a database. <strong>Teachers</strong> grade only what's
        theirs to grade, with plagiarism and OCR doing the first pass. <strong>Students</strong> get
        instant feedback on code, clear standing on exams, and one login across every institution
        they're part of.
      </p>

      <div style={{ marginTop: 32, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={() => navigate('/signup')}>
          Set up your school or college
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('/contact')}>
          Have questions? Contact us
        </button>
      </div>
    </LegalShell>
  );
}
