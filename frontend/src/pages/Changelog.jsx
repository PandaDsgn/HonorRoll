import LegalShell from '../components/LegalShell';

// Newest first. Dates are approximate — grouped by the actual development
// history, not a promise of exact release timestamps.
const ENTRIES = [
  {
    date: '24 August 2026',
    tag: 'Latest',
    items:[
      'The sign-in screen now actually enforces the account type you select — signing in with a student\'s credentials while "Teacher" is selected is correctly rejected, instead of silently logging you in as whatever role the account actually has.',
      'General performance and reliability improvements under heavier load.',
      'Teachers can now post notes for their subjects — PDFs, photos, videos, audio, plain text, or links — from a new Uploads tab; students can browse or search their own subjects\' notes from a new Notes tab.',
      'Admins can now post org-wide notices — PDFs, photos, text, or links — from a new Notices tab; every student and teacher can browse and search them from their own Notices tab.',
      'Students and teachers now get an in-app notification, with an unread badge, whenever a new note or notice is posted that concerns them.',
      'The assignment submission screen no longer shows a scanning-specific title for assignments that don\'t actually have a scanned question, and now notes that a scanned answer is graded a little after the rest of your submission.',
      'Removed the Assignments and Exams tabs from teachers\' navigation — teachers manage those from their own dashboard rather than attempting them.',
    ],
  },
  {
    date: '16 August 2026',
    tag: 'Improved',
    items: [
    'Added About, Contact, and this Changelog page, linked from the homepage.',
    'Every role now gets a "Dashboard" button in the same spot in the top navigation — previously teachers had no way back to their own dashboard once they navigated away from it.',
    'Superadmins can now open any institution and directly manage its admins, teachers, and students, edit its structure, and override its billing plan — all from one page, without needing to "enter" the institution as its admin.',
    'Superadmins can now terminate any single person\'s access to an institution, or permanently delete an institution entirely — deletion always emails a full data export to the institution\'s admin(s) first, and only proceeds once that email is confirmed sent.',
    'Institution admins can now request that another admin be added to their institution, and can message the platform owner directly for anything else.',
    'Students can now see their assignment and exam performance as graphs — percentile standing and a per-question score breakdown — instead of just a plain percentage.',
    'The student dashboard now opens on "My Info" first, with performance graphs a click away.',
    ],
  },
  {
    date: '23 July 2026',
    tag: 'Improved',
    items: [
      'Reorganized the admin dashboard into clearer sections — Structure, Grading, and Billing each got their own dedicated tab.',
      'Added a proper student-promotion flow for moving students between class/year units at the end of a term.',
      'Teachers can now be edited directly from the admin dashboard — update a teacher\'s name or unit without recreating their account.',
      'Assigning a teacher to a subject now uses a searchable picker scoped to that subject\'s own unit, instead of typing an email — the old add-by-email option is gone entirely.',
    ],
  },
  {
    date: '10 July 2026',
    tag: 'Added',
    items: [
      'Scanned handwritten assignments now support plagiarism and handwriting-similarity detection, flagging suspicious pairs for a teacher to review.',
      'Teachers can now view the transcribed text of a scanned submission directly from the submissions list.',
    ],
  },
  {
    date: '03 July 2026',
    tag: 'Added',
    items: [
      'Introduced scanned assignment submissions — students can photograph or scan a handwritten answer sheet instead of writing code, and HonorRoll transcribes it automatically.',
    ],
  },
  {
    date: '17 June 2026',
    tag: 'Added',
    items: [
      'Major platform overhaul: multi-tenant institution support, timed exams with proctoring, and a full grading system.',
    ],
  },
];

export default function Changelog() {
  return (
    <LegalShell>
      <h1>Changelog</h1>
      <p className="legal-updated">What's changed on HonorRoll, most recent first.</p>

      {ENTRIES.map((entry) => (
        <div key={entry.date} style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{entry.date}</h2>
            <span className="chip chip-neutral"><span className="dot" />{entry.tag}</span>
          </div>
          <ul>
            {entry.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ))}
    </LegalShell>
  );
}
