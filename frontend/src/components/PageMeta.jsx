import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SITE_URL = 'https://pandadsgn.github.io/HonorRoll/';

// One static {title, description} per route, matched against the current
// path — a single source of truth instead of a per-page hook call
// copy-pasted into ~30 page files. Patterns are fully anchored (^...$), so
// match order never matters: exactly one entry can ever match a given
// exact pathname, even where routes share a prefix (e.g. /admin vs
// /admin/scan-submissions/:id vs /admin/billing/custom-quote).
//
// Deliberately static, not per-resource (an exam's own title, say) — that
// would need each detail page to thread its already-fetched data back up
// here, real added complexity for a "browser tab" nicety. Add it later,
// page by page, only where it's actually missed.
const PAGES = [
  { pattern: /^\/$/, title: 'HonorRoll', description: 'A single platform for a school, college, or coaching institution to run code assignments, timed exams, and academic performance tracking.' },
  { pattern: /^\/login$/, title: 'Sign In', description: 'Sign in to your HonorRoll workspace.' },
  { pattern: /^\/signup$/, title: 'Set Up Your Institution', description: 'Create an isolated HonorRoll workspace for your school, college, or coaching institution.' },
  { pattern: /^\/verify-organization$/, title: 'Verify Organization', description: 'Verify your institution’s email address to activate your HonorRoll workspace.' },
  { pattern: /^\/forgot-password$/, title: 'Forgot Password', description: 'Reset the password for your HonorRoll account.' },
  { pattern: /^\/reset-password$/, title: 'Reset Password', description: 'Choose a new password for your HonorRoll account.' },
  { pattern: /^\/terms$/, title: 'Terms of Service', description: 'HonorRoll’s Terms of Service.' },
  { pattern: /^\/privacy$/, title: 'Privacy Policy', description: 'HonorRoll’s Privacy Policy.' },
  { pattern: /^\/cookies$/, title: 'Cookie Policy', description: 'HonorRoll’s Cookie Policy.' },
  { pattern: /^\/refunds$/, title: 'Refund Policy', description: 'HonorRoll’s Refund Policy.' },
  { pattern: /^\/about$/, title: 'About', description: 'Code judging, OCR-scanned handwritten answers, proctored exams, plagiarism signals, and performance analytics — what HonorRoll actually does.' },
  { pattern: /^\/contact$/, title: 'Contact', description: 'Get in touch with the HonorRoll team.' },
  { pattern: /^\/changelog$/, title: 'Changelog', description: 'Recent updates to HonorRoll.' },
  { pattern: /^\/assignments$/, title: 'Assignments', description: 'Your assigned coding problems.' },
  { pattern: /^\/assignments\/[^/]+\/result$/, title: 'Assignment Result', description: 'Your result for this assignment.' },
  { pattern: /^\/assignments\/[^/]+\/scan$/, title: 'Scan Submission', description: 'Scan and submit a handwritten answer for this assignment.' },
  { pattern: /^\/assignments\/[^/]+$/, title: 'Sandbox', description: 'Write and run your solution to this assignment.' },
  { pattern: /^\/ide$/, title: 'Code IDE', description: 'A free-form scratch space to write and run code in any supported language.' },
  { pattern: /^\/admin\/billing\/custom-quote$/, title: 'Request a Quote', description: 'Request a custom billing quote for your institution.' },
  { pattern: /^\/exams$/, title: 'Exams', description: 'Your scheduled and available exams.' },
  { pattern: /^\/exams\/[^/]+\/result$/, title: 'Exam Result', description: 'Your result for this exam.' },
  { pattern: /^\/exams\/[^/]+$/, title: 'Exam', description: 'Sit this exam.' },
  { pattern: /^\/performance$/, title: 'My Performance', description: 'Your assignment and exam performance over time.' },
  { pattern: /^\/profile$/, title: 'My Profile', description: 'Your HonorRoll account details.' },
  { pattern: /^\/notes$/, title: 'Notes', description: 'Reference notes shared by your teachers.' },
  { pattern: /^\/notices$/, title: 'Notices', description: 'Announcements from your institution.' },
  { pattern: /^\/doubts$/, title: 'Doubts', description: 'Ask a question on your subject board.' },
  { pattern: /^\/chat$/, title: 'Chat', description: 'Message your teachers and admins.' },
  { pattern: /^\/admin\/scan-submissions\/[^/]+$/, title: 'Review Scan', description: 'Review and grade a scanned handwritten submission.' },
  { pattern: /^\/admin$/, title: 'Admin Dashboard', description: 'Manage assignments, exams, students, and institution settings.' },
  { pattern: /^\/superadmin\/organizations\/[^/]+$/, title: 'Organization Details', description: 'Platform-level details for this institution.' },
  { pattern: /^\/superadmin$/, title: 'Superadmin Dashboard', description: 'Platform-level oversight of every institution on HonorRoll.' },
];
const DEFAULT_PAGE = { title: 'Page Not Found', description: 'The page you’re looking for doesn’t exist, or it’s moved.' };

// Creates the tag on first call (index.html ships none, so there's nothing
// to find on the very first render) and just updates its attribute after
// that — avoids piling up duplicate <meta>/<link> tags on every route
// change.
function setHeadTag(selector, build) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = build();
    document.head.appendChild(el);
  }
  return el;
}

// Renders nothing — mounted once at the router root (see App.jsx) purely
// for its effect. Any path matching none of the entries above (the
// wildcard * route, see NotFound.jsx) falls to DEFAULT_PAGE, which is
// also correct for that page specifically. ProtectedRoute rendering
// Forbidden at a path that otherwise matches a real page (e.g. a student
// hitting /admin) is the one known gap this can't see on its own — it'll
// title/describe that page even though Forbidden is what's actually on
// screen; Forbidden.jsx sets its own document.title to win that race, see
// its own comment.
//
// Canonical URLs use the same #/path scheme as sitemap.xml, for internal
// consistency — a caveat worth knowing, not fixed here: HashRouter means
// every route is really the same server-side resource (the fragment after
// # never reaches the server), so search engines don't reliably treat
// these as separate indexable pages the way real paths would. Fixing that
// would mean switching routers entirely (BrowserRouter needs a server-
// side rewrite rule GitHub Pages doesn't support natively) — out of scope
// for adding the tags themselves.
export default function PageMeta() {
  const { pathname } = useLocation();

  useEffect(() => {
    const page = PAGES.find(({ pattern }) => pattern.test(pathname)) || DEFAULT_PAGE;
    document.title = `${page.title} · HonorRoll`;

    const descriptionTag = setHeadTag('meta[name="description"]', () => {
      const el = document.createElement('meta');
      el.setAttribute('name', 'description');
      return el;
    });
    descriptionTag.setAttribute('content', page.description);

    const canonicalTag = setHeadTag('link[rel="canonical"]', () => {
      const el = document.createElement('link');
      el.setAttribute('rel', 'canonical');
      return el;
    });
    canonicalTag.setAttribute('href', pathname === '/' ? SITE_URL : `${SITE_URL}#${pathname}`);
  }, [pathname]);

  return null;
}
