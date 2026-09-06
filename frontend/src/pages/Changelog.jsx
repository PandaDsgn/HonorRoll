import LegalShell from '../components/LegalShell';

// Newest first. Dates are approximate — grouped by the actual development
// history, not a promise of exact release timestamps.
const ENTRIES = [
  {
    date: '06 September 2026',
    tag: 'Latest',
    items: [
      'Added a live demo — try HonorRoll as a student, teacher, or admin without creating an account. You can switch roles mid-session without losing your place, and all demo data resets automatically once the session expires.',
      'Added proper pages for "page not found," "access denied," and unexpected errors, instead of a blank screen or a silent redirect.',
      'The browser tab title now reflects whichever page you\'re actually on.',
      'Added breadcrumb navigation to results, scan review, and other pages that sit a few levels deep.',
      'Added a "skip to content" link for keyboard and screen-reader users.',
      'Added Cookie Policy and Refund Policy pages, linked from the footer alongside Terms of Service and Privacy Policy.',
      'The sign-in and sign-up screens\' side panel now follows your light/dark theme instead of always staying dark, and shows the same live product preview as the homepage.',
    ],
  },
  {
    date: '02 September 2026',
    tag: 'Improved',
    items: [
      'Added an encrypted chat between a student and each teacher of a subject they\'re enrolled in — messages are end-to-end encrypted in your browser, so not even HonorRoll\'s own servers can read them.',
      'Notifications and chat messages now arrive instantly instead of waiting for the app to next check in.',
      'Added Doubts — ask a question about a subject and, by default, every teacher of that subject can see and answer it (or narrow it to one specific teacher instead). A public board lets you check whether your question has already been asked and answered before you post it, and a "My Doubts" tab tracks your own.',
      'Teachers now get a notification whenever a doubt is posted in a subject they teach, even if it wasn\'t addressed to them specifically.',
      'A student\'s Profile — photos, institutions, ID cards — now lives on their Dashboard\'s "My Info" tab instead of a separate page, and the student navigation bar now tucks Notes, Doubts, and the IDE behind a "More" menu so the top bar stays uncluttered.',
      'The in-app assistant\'s knowledge of the app\'s own navigation was out of date and has been corrected; it now runs on an upgraded model.',
      'Fixed dropdowns and file-upload buttons across the site to match the rest of the app\'s look instead of the browser\'s own default styling.',
      'Security Events now has its own tab on the superadmin dashboard instead of being buried in the middle of the page.',
      'Fixed a bug where some logins were geolocated to the wrong country on the superadmin login map — a proxy\'s own address was being recorded instead of the actual visitor\'s.',
    ],
  },
  {
    date: '01 September 2026',
    tag: 'Improved',
    items: [
      'Redesigned the digital ID card with a real QR code — linking straight to your dashboard — in place of the old barcode, plus an overall more professional layout.',
      'Standardized the whole site on Apple\'s system font, removing a couple of leftover web-font references.',
    ],
  },
  {
    date: '30 August 2026',
    tag: 'Added',
    items: [
      'Added an in-app security audit log for admins and superadmins, tracking logins, access denials, and account/role/grade changes across the institution.',
      'Accounts now temporarily lock after 5 failed login attempts within 15 minutes, with an email alert — entering the correct password during a lockout sends a one-time code to your email that lifts it immediately instead of waiting out the timer.',
      'Signing in from a browser or device we haven\'t seen before now asks for an emailed verification code before letting you in, with an option to trust that device going forward.',
      'Superadmins can now see a live globe showing where each institution\'s students, teachers, and admins log in from, with a login from an unusual location flagged automatically.',
    ],
  },
  {
    date: '28 August 2026',
    tag: 'Added',
    items: [
      'Added a step-by-step code visualizer to the IDE — watch your code run line by line alongside a live diagram of its variables, objects, and how they reference each other, with playback controls, a PNG export, and shareable links to a specific step.',
      'The code visualizer now works for every language the IDE supports, not just Python — C, C++, Java, JavaScript, TypeScript, Go, Rust, Ruby, and PHP can all be stepped through line by line too.',
      'The visualizer\'s number display can now show integers in octal, alongside the existing decimal, binary, and hex views.',
      'Every student, teacher, and admin can now build a digital ID card from their new Profile page — upload a photo, crop and zoom it, and download the finished card as a PNG. Admins can upload (and crop) their institution\'s logo, shown on every card issued there.',
      'Anyone belonging to more than one institution can now cycle between each one\'s ID card, and can keep several photos on file to choose which one backs a particular card.',
      'Teachers can now start their own institution — for a private coaching center or similar — directly from their Profile page, without leaving the app.',
      'Fixed a bug where a downloaded ID card could come out with the profile photo or institution logo missing.',
      'Added an in-app assistant — a collapsible chat widget available to every role that helps you find your way around HonorRoll and answers "how do I..." questions. It\'s a navigation helper only: it won\'t solve assignments, answer exam questions, or help with coursework, and it stays hidden while an exam is in progress.',
    ],
  },
  {
    date: '24 August 2026',
    tag: 'Improved',
    items:[
      'The sign-in screen now actually enforces the account type you select — signing in with a student\'s credentials while "Teacher" is selected is correctly rejected, instead of silently logging you in as whatever role the account actually has.',
      'General performance and reliability improvements under heavier load.',
      'Teachers can now post notes for their subjects — PDFs, photos, videos, audio, plain text, or links — from a new Uploads tab; students can browse or search their own subjects\' notes from a new Notes tab.',
      'Admins can now post org-wide notices — PDFs, photos, text, or links — from a new Notices tab; every student and teacher can browse and search them from their own Notices tab.',
      'Students and teachers now get an in-app notification, with an unread badge, whenever a new note or notice is posted that concerns them.',
      'The assignment submission screen no longer shows a scanning-specific title for assignments that don\'t actually have a scanned question, and now notes that a scanned answer is graded a little after the rest of your submission.',
      'Removed the Assignments and Exams tabs from teachers\' navigation — teachers manage those from their own dashboard rather than attempting them.',
      'Added a calculator to exams, allowing students to use a calculator during exam attempts. The availability of the calculator and its type is configurable on the exam settings page by the teacher.'
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
            <span className={`chip ${entry.tag === 'Latest' ? 'chip-amber' : 'chip-neutral'}`}><span className="dot" />{entry.tag}</span>
          </div>
          <ul>
            {entry.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ))}
    </LegalShell>
  );
}
