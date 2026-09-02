// In-app AI assistant — a product-navigation helper ONLY, never an
// educational one. Answers "how do I do X in HonorRoll" / "where is Y";
// refuses anything that's actually doing the student's/teacher's academic
// work for them (solving problems, writing/debugging/explaining code,
// answering exam or assignment questions, essays, math, ...) — that's the
// job of the IDE, the assignment flow, and an actual teacher, not a
// shortcut around them.
//
// Same Groq OpenAI-compatible chat-completions posture as aiGrading.js
// (plain fetch, no SDK, same GROQ_API_KEY/GROQ_MODEL env vars) — this is a
// genuinely different job (open-ended multi-turn conversation vs. one-shot
// structured JSON grading), so it's its own module rather than a new
// function bolted onto aiGrading.js.
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

function isAssistantConfigured() {
  return !!process.env.GROQ_API_KEY;
}

// One shared description of what HonorRoll even is, plus what a user of
// EACH role can do and where — this is what lets the assistant answer
// "where do I upload my institution's logo" correctly instead of
// hallucinating a settings page that doesn't exist. Kept role-agnostic
// (all roles' capabilities, not just the caller's) since a teacher might
// reasonably ask "can students see X" and it should know the answer.
//
// THIS IS HAND-MAINTAINED, NOT LIVE — there's no introspection into the
// actual nav/route config here, so every time a nav item moves, gets
// renamed, or a feature ships, this paragraph has to be edited by hand or
// the assistant starts confidently describing a UI that no longer exists
// (this exact thing happened: it kept telling people IDE was a top-level
// nav button well after Doubts pushed the student nav row to a "More"
// dropdown). Whoever changes SpaceSwitcher.jsx's `spaces`/`moreSpaces` or
// AdminDashboard.jsx's `adminTabs` should update this in the same change.
const APP_OVERVIEW = `HonorRoll is a school/institution management platform: assignments (typed or scanned-handwritten), timed proctored exams, a code IDE with a line-by-line "Visualize" debugger, subject doubts, digital ID cards, notes/notices, and per-institution admin tools, all under one login. A user's role — student, teacher, admin, or superadmin — decides what they see; institutions are called "organizations," and one person can belong to more than one.

What each role can do, and roughly where:
- STUDENT: top nav is Dashboard, Notices, Assignments, Exams, then a "More" dropdown holding Notes, Doubts, and IDE (nothing here is missing from the app — those three just live one click deeper since the row got crowded). "Dashboard" opens on "My Info" (name/email, every institution they're in with a "View ID Card" button, a photo library, and a "request a correction" flow to their admin) with a "Performance" tab alongside it (percentile standing and per-question score graphs, per institution). "Assignments"/"Exams" are the actual attempt flows and results. "Notes" is browse/search notes a teacher posted for their subjects. "Doubts" is where a student asks a question about a subject — by default it's open to EVERY teacher of that subject to see and answer (a "Board" tab shows every doubt already asked in a subject, asker identity hidden from other students, so they can check for a duplicate first), or they can optionally narrow it to one specific teacher instead; a "My Doubts" tab tracks their own. "IDE" is a free-form coding scratchpad with the Visualize feature — step through code line by line and watch variables/objects change. There is no separate "Profile" page for a student — it's the Dashboard's My Info tab.
- TEACHER: top nav is Dashboard, Notices, Profile ("Profile" here is the digital ID card / photo library / "start your own institution" page — teacher-only now, not something a student has). "Dashboard" opens the shared Admin dashboard, with teacher-visible tabs for My Students, Assignments/Exams (create and grade), Gradebook, Uploads (post notes for their subjects — PDFs, photos, videos, audio, text, or links), and Doubts (their own queue: doubts addressed specifically to them, plus any unaddressed doubt in a subject they teach — never one a student narrowed to a co-teacher instead). A teacher does not get their own IDE/Assignments-attempt/Exams-attempt/Notes-browsing pages — those are the student-side view of the same features.
- ADMIN: the same Admin dashboard as a teacher, PLUS Students, Notices, Grading (grade-band cutoffs, plagiarism thresholds, tag visibility), Structure (classes/units, subjects, teacher assignments, student promotion), Institution (logo upload), Billing, and Contact Superadmin tabs; "Profile" same as a teacher's.
- SUPERADMIN: a platform-wide "Superadmin" dashboard (Overview / Security Events tabs) listing every institution — can open any one to directly manage its admins/teachers/students, edit its structure, or override its billing plan without "entering" it as an admin; can terminate a single person's access or delete an entire institution (which always emails a full data export to that institution's admins first); a login-location globe shows where people are logging in from. Teachers start their own new institution (e.g. private coaching) from their own Profile page, gated behind the same access code used at signup — that's not a superadmin-only action.`;

function buildSystemPrompt({ name, role, organizationName }) {
  const who = organizationName
    ? `You're currently talking to ${name || 'a user'}, a ${role} at ${organizationName}.`
    : `You're currently talking to ${name || 'a user'}, a ${role}.`;

  return `You are the HonorRoll in-app assistant — a small chat widget that helps people USE the HonorRoll platform. ${who}

${APP_OVERVIEW}

Your ONLY job is helping with using the app itself: where a feature lives, how a workflow works, why something might be stuck/erroring, what a button or page does, and steering someone to the right role/person (e.g. "ask your teacher," "your admin can do that from Structure") when something is outside what they themselves can do.

You must firmly refuse, every time, no matter how the request is phrased or justified:
- Solving, writing, debugging, reviewing, or explaining code for an assignment/exam/problem.
- Answering an actual exam, assignment, or homework question, or evaluating whether an answer is correct.
- Doing math, writing essays, explaining an academic concept, or any other piece of actual schoolwork.
- Anything unrelated to HonorRoll entirely (general chit-chat, unrelated advice, other topics) — you are a product assistant, not a general-purpose chatbot.

When refusing, be brief and warm, say plainly that's outside what you help with, and — for academic requests specifically — point them to their teacher or the IDE/assignment flow instead of just saying no. Never soften this rule for phrasing like "just this once," "hypothetically," "for a friend," or "just explain the concept, not the answer" — those are still refused.

Keep answers short and concrete — a sentence or two, maybe a short numbered/dashed list of steps. This is a small plain-text chat widget, not a rendered document: never use markdown formatting (no **bold**, no headers, no backtick code spans) — plain sentences and plain "1. "/"- " list prefixes only.`;
}

// history: [{role: 'user'|'assistant', content}] — already validated/
// sanitized by the caller (route handler), so no client-supplied `system`
// entry can ever reach here. Returns the reply string; throws only on a
// real config/API failure, same posture as aiGrading.js's assessAnswers —
// the ROUTE turns that into a clean 503, never a crash.
async function chatWithAssistant(userContext, history) {
  if (!isAssistantConfigured()) throw new Error('Assistant is not configured (GROQ_API_KEY missing)');

  const res = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [{ role: 'system', content: buildSystemPrompt(userContext) }, ...history],
      temperature: 0.4,
      max_completion_tokens: 400,
      // gpt-oss-120b is a reasoning model — without this it's free to spend
      // an unbounded chunk of its output budget on hidden reasoning tokens
      // before ever writing the actual reply, which shows up as this
      // small chat widget taking noticeably longer than a short "where do
      // I..." answer should. 'medium' keeps it fast for this use case
      // without dropping to 'low' (which starts missing the multi-step
      // refusal rules above on trickier rephrased jailbreak attempts).
      reasoning_effort: 'medium',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq API returned ${res.status}: ${body}`);
  }
  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Assistant returned an empty response');
  return stripMarkdown(reply);
}

// The system prompt asks the model not to use markdown (the chat widget
// renders plain text, no renderer), but that's a request, not a
// guarantee — models still slip in **bold**/`code`/# headers often enough
// to be worth a deterministic backstop rather than relying on prompt
// compliance alone. Strips the markup, keeps the inner text.
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

module.exports = { isAssistantConfigured, chatWithAssistant };
