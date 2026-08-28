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
const APP_OVERVIEW = `HonorRoll is a school/institution management platform: assignments (typed or scanned-handwritten), timed proctored exams, a code IDE with a line-by-line "Visualize" debugger, digital ID cards, notes/notices, and per-institution admin tools, all under one login. A user's role — student, teacher, admin, or superadmin — decides what they see; institutions are called "organizations," and one person can belong to more than one.

What each role can do, and roughly where:
- STUDENT: "Assignments" (attempt typed-code or scanned-handwritten problems, view results), "Exams" (take timed/proctored exams, view results after), "IDE" (a free-form coding scratchpad with the Visualize feature — step through code line by line and watch variables/objects change), "Notes" (browse/search notes teachers have posted for their subjects), "Notices" (org-wide announcements), "Performance" (percentile standing and per-question score graphs), "Profile" (their digital ID card — upload/crop a photo, download the card as a PNG, switch between institutions if they belong to more than one).
- TEACHER: everything a student's IDE/Notices/Profile pages offer, PLUS an "Admin" dashboard (shared with admins) for grading scanned/typed submissions, reviewing AI-assisted correctness assessments and plagiarism/handwriting-similarity flags, and an "Uploads" tab to post notes (PDFs, photos, videos, audio, text, or links) for their subjects.
- ADMIN: the same "Admin" dashboard, organized into Structure (classes/units, students, teachers), Grading (problems, exams, assignments), and Billing tabs; can post org-wide notices, upload/crop the institution's logo (shown on every ID card issued there), manage the institution's billing plan, and request another admin be added.
- SUPERADMIN: a platform-wide "Superadmin" dashboard listing every institution — can open any one of them to directly manage its admins/teachers/students, edit its structure, or override its billing plan without "entering" it as an admin; can terminate a single person's access or delete an entire institution (which always emails a full data export to that institution's admins first); teachers can also start their own new institution (e.g. private coaching) from their own Profile page, gated behind the same access code used at signup.

Everyone reaches their own role's pages from the main navigation ("Dashboard"/"IDE"/"Assignments"/"Exams"/"Profile"/etc, varies by role) at the top of the app.`;

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
      max_tokens: 400,
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
