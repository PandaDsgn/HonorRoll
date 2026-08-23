import LegalShell from '../components/LegalShell';

export default function Privacy() {
  return (
    <LegalShell>
      <h1>Privacy Policy</h1>
      <p className="legal-updated">Last updated: [date] — replace before publishing</p>

      <p>
        This Privacy Policy describes what information HonorRoll collects through the Service, why,
        and how it's handled. It should be read alongside the{' '}
        <a href="#/terms">Terms of Service</a>.
      </p>

      <p>
        <strong>This is a template.</strong> Because the Service handles student records — including,
        in many institutions, data belonging to minors — have this reviewed against the specific laws
        that apply to your institution's students (e.g. FERPA and COPPA in the US, GDPR/UK GDPR,
        India's DPDP Act) before relying on it. Where a school is the "data controller" and HonorRoll
        is acting as a processor on its behalf, your institution's own data-protection agreement with
        HonorRoll (if any) governs alongside this policy.
      </p>

      <h2>1. Information we collect</h2>
      <p><strong>Identity and roster data</strong> — name, email address, role (admin/teacher/student), roll number, and placement within your institution's class/department/year structure. Provided by your institution's administrator (manually, by CSV, or via a connected roster form) or, for an administrator's own account, by that person at signup.</p>
      <p><strong>Academic content</strong> — assignment and exam questions set by teachers; code, text, and multiple-choice answers submitted by students; scanned images of handwritten answer sheets and the text HonorRoll's OCR transcribes from them; grades, marks, and remarks left by teachers.</p>
      <p><strong>Proctoring data</strong> — for exams an institution has configured to require it, webcam and microphone access during that exam, and any resulting integrity observations (e.g. a logged head-turn or gaze-away event) tied to that exam attempt.</p>
      <p><strong>Usage data</strong> — login timestamps, time spent on an assignment, and similar activity logs used to power teacher/admin dashboards.</p>
      <p><strong>Billing data</strong> — an organization's subscription plan and status. Payment card/bank details are collected and processed directly by our payment processor, Razorpay — HonorRoll does not receive or store full card numbers.</p>

      <h2>2. How we use this information</h2>
      <ul>
        <li>To operate the core features of the Service: presenting assignments/exams, accepting and grading submissions, and showing results and remarks to the right people.</li>
        <li>To transcribe scanned handwritten answers via optical character recognition, and to generate a non-authoritative AI assessment note on certain scanned answers as a grading aid.</li>
        <li>To compare submissions against each other within the same assignment/institution to flag possible plagiarism, and to compare handwriting characteristics across a student's own submission history, for a teacher to review.</li>
        <li>To power performance dashboards for teachers (their own subjects' students), students (their own results, across every institution they're enrolled in), and administrators (their own organization).</li>
        <li>To process payments for paid plans and manage subscription status.</li>
        <li>To provide support, investigate misuse, and maintain the security and integrity of the Service.</li>
      </ul>

      <h2>3. Who your data is shared with, within your institution</h2>
      <p>
        Visibility is scoped by role. A teacher can see students and content connected to the subjects
        they've been assigned to by their institution's administrator, and everyone enrolled under
        those subjects' place in the institution's structure. A student sees their own submissions,
        grades, and remarks, and their own results across every institution they're a member of. An
        institution's administrator can see and manage every student, teacher, and record within their
        own organization — but not other organizations'.
      </p>

      <h2>4. Third-party processors</h2>
      <p>We use the following third-party services to operate the Service. Each processes only what's necessary for its specific role:</p>
      <ul>
        <li><strong>Google Gemini API</strong> — transcribes scanned handwritten answer images into text.</li>
        <li><strong>Groq</strong> — generates the non-authoritative AI assessment note used as a grading aid on certain scanned answers.</li>
        <li><strong>Backblaze B2</strong> — stores uploaded scanned-answer PDFs.</li>
        <li><strong>Razorpay</strong> — processes subscription payments for paid plans.</li>
        <li>An email delivery provider — sends account, verification, and notification emails.</li>
      </ul>
      <p>
        [List the actual database/hosting providers here too (e.g. the Postgres host and the
        application hosting provider) — they process essentially all of the data described above and
        belong in this list.]
      </p>

      <h2>5. Children's data</h2>
      <p>
        Many users of the Service are students at a school or college, some of whom may be minors.
        HonorRoll does not knowingly collect data directly from a minor outside the context of their
        enrolling institution's use of the Service — student accounts are created by the institution's
        administrator, not through a public sign-up. Institutions are responsible for ensuring they
        have the appropriate legal basis (parental/guardian consent or otherwise, as required by
        applicable law) before enrolling a minor.
      </p>

      <h2>6. Platform administration access</h2>
      <p>
        A small number of HonorRoll platform staff (superadmin accounts) can view the list of
        organizations on the platform and can enter any organization's workspace directly, for support,
        misuse-investigation, and platform-maintenance purposes. This is a direct-access capability, not
        currently limited by a separate approval step or automatically logged audit trail — treat it as
        equivalent to platform staff having admin-level access to any organization's data on request.
        [If you add audit logging or an approval workflow for this later, update this section to
        reflect it — as written, this describes the capability that actually exists today, not an
        aspiration.]
      </p>

      <h2>7. Data retention</h2>
      <p>
        We retain academic records for as long as an organization's account is active, so that
        historical performance data (including scores an institution imports from before it started
        using HonorRoll) remains available. An institution administrator can remove an individual
        student or teacher record at any time. To request deletion of an entire organization's data,
        contact <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a> — this is
        subject to any legal obligation an institution may have to retain academic records for a
        minimum period under its own jurisdiction's education law.
      </p>

      <h2>8. Security</h2>
      <p>
        Passwords are stored hashed, never in plain text. Access to the Service is authenticated per
        request and scoped to your account's role and organization; one organization's data is not
        accessible to another organization's members. No system is perfectly secure, and we can't
        guarantee absolute security of information transmitted to or stored by the Service.
      </p>

      <h2>9. Your rights</h2>
      <p>
        Depending on your jurisdiction, you may have rights to access, correct, or request deletion of
        your personal data. Because student/teacher accounts are managed by their institution, the
        first step for most requests is your institution's administrator, who can view and edit your
        record directly. For anything they can't resolve, contact{' '}
        <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a>.
      </p>

      <h2>10. International data transfers</h2>
      <p>
        [Describe where data is actually hosted/processed, and add a transfer-mechanism statement
        (e.g. standard contractual clauses) if any users are in a jurisdiction — like the EU/UK —
        that requires one for transfers outside it.]
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        We may update this policy from time to time. Material changes will be reflected by an updated
        "Last updated" date above.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions about this policy can be sent to{' '}
        <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a>.
      </p>
    </LegalShell>
  );
}
