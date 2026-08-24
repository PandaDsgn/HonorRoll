import LegalShell from '../components/LegalShell';

export default function Terms() {
  return (
    <LegalShell>
      <h1>Terms of Service</h1>
      <p className="legal-updated">Last updated: 24th August, 2026</p>

      <p>
        These Terms of Service ("Terms") govern access to and use of HonorRoll (the "Service"), a
        platform for institutions to run assignments, exams, and academic-performance tracking. The
        Service is operated by [Legal Entity Name] ("HonorRoll", "we", "us"). By creating an
        organization, signing in, or otherwise using the Service, you agree to these Terms. If you do
        not agree, do not use the Service.
      </p>

      <p>
        <strong>This is a template.</strong> Have it reviewed by a lawyer before relying on it — in
        particular the sections on minors' data, proctoring, and liability, which carry real
        regulatory weight (FERPA/COPPA in the US, GDPR/UK GDPR, India's DPDP Act, and whatever else
        applies to the specific institutions using this platform) that a template can't fully account
        for on its own.
      </p>

      <h2>1. Who these Terms cover</h2>
      <p>
        The Service is used by three kinds of accounts: <strong>institution administrators</strong>
        {' '}who create and manage an organization's workspace, <strong>teachers</strong> assigned to
        subjects within an organization, and <strong>students</strong> enrolled in one or more
        organizations. An administrator accepts these Terms directly when creating an organization.
        A teacher or student account is created by their institution's administrator on their behalf;
        that person accepts these Terms themselves the first time they sign in.
      </p>
      <p>
        If you are under the age of majority in your jurisdiction, your use of the Service is on
        behalf of, and subject to the oversight of, your school or institution, which is responsible
        for obtaining any parental or guardian consent required by applicable law before enrolling
        you.
      </p>

      <h2>2. What the Service does</h2>
      <p>
        HonorRoll lets an institution create assignments and exams (multiple-choice, short/long
        answer, coding exercises, and scanned handwritten answers processed with optical character
        recognition), grade them, record scores and remarks, and view performance summaries. Exams
        may optionally require webcam and microphone access for proctoring. Submitted work may be
        automatically compared against other submissions to flag possible plagiarism or unusual
        handwriting similarity for a teacher's review.
      </p>

      <h2>3. Accounts and organizations</h2>
      <p>
        Each organization is an isolated workspace for one institution. The same email address can
        belong to more than one organization (for example, someone who teaches at one institution and
        studies at another) — in that case you'll be asked which workspace to enter each time you sign
        in with more than one. You're responsible for keeping your password confidential and for
        activity that happens under your account.
      </p>
      <p>
        An institution's administrator can view, edit, and remove student and teacher records within
        their own organization, including placing students into (or moving them between) the
        institution's own class/year structure, and can grant or remove a teacher's access to specific
        subjects.
      </p>

      <h2>4. Institution content and ownership</h2>
      <p>
        Assignments, exam questions, grading criteria, and similar material an institution creates
        remain that institution's own content. Work a student submits remains that student's own
        work. By submitting content to the Service, you grant HonorRoll the limited right to store,
        process, and display it as necessary to operate the features described in these Terms —
        nothing more.
      </p>

      <h2>5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Access another person's account, or data belonging to an organization you're not a member of, without authorization.</li>
        <li>Attempt to bypass exam proctoring, plagiarism detection, or any other integrity feature.</li>
        <li>Upload content you don't have the right to upload, or content that is unlawful, harassing, or infringes someone else's rights.</li>
        <li>Interfere with the Service's operation (including automated scraping, load-testing, or attempting to access another organization's data).</li>
        <li>Use the Service to store or transmit anything other than legitimate academic content for the purposes described above.</li>
      </ul>

      <h2>6. AI-assisted and automated features</h2>
      <p>
        Some features use automated processing: optical character recognition to transcribe scanned
        handwritten answers, and an AI-generated assessment note attached to certain scanned answers
        as an aid for the grading teacher. These automated outputs are <strong>never authoritative</strong>{' '}
        — a human teacher always makes the actual grading decision, and OCR/AI output can be wrong.
        Similarly, plagiarism and handwriting-similarity flags are signals for a teacher to review, not
        automatic findings of misconduct.
      </p>

      <h2>7. Exam proctoring</h2>
      <p>
        Where an exam is configured to require it, the Service may access a student's webcam and
        microphone during that exam and may log observations (for example, an inferred head-turn or
        gaze-away event) as part of academic-integrity monitoring for that exam. This only happens for
        exams an institution has explicitly configured to require it, and only for the duration of that
        exam attempt. Institutions are responsible for giving students adequate notice of proctoring
        before an exam begins and for complying with any consent or notice requirements that apply to
        them under local law.
      </p>

      <h2>8. Billing</h2>
      <p>
        Organizations may subscribe to a paid plan for additional capacity. Payments are processed by
        a third-party payment processor (Razorpay); HonorRoll does not store your full card or bank
        details. Plan terms, pricing, and cancellation are as described at checkout and in the billing
        section of the admin dashboard at the time of subscribing.
      </p>

      <h2>9. Platform administration</h2>
      <p>
        HonorRoll platform staff can access organization data, including entering an organization's
        workspace directly, for the purposes of providing support, investigating misuse, enforcing
        these Terms, and maintaining the Service. This access is limited to what's necessary for those
        purposes.
      </p>

      <h2>10. Suspension and termination</h2>
      <p>
        We may suspend or terminate access to the Service for an account or an entire organization if
        we reasonably believe these Terms have been violated, or as needed to protect the Service or
        other users. An institution administrator may stop using the Service at any time; contact
        [support email] to request deletion of an organization's data, subject to the retention
        obligations described in the Privacy Policy.
      </p>

      <h2>11. Disclaimers and limitation of liability</h2>
      <p>
        The Service is provided "as is," without warranties of any kind. In particular, we don't
        warrant that OCR transcription, AI-assisted grading aids, plagiarism/handwriting-similarity
        detection, or automated proctoring signals are accurate or complete — they are aids for human
        decision-makers, not replacements for them. To the fullest extent permitted by law, HonorRoll
        is not liable for indirect, incidental, or consequential damages arising from use of the
        Service. [This section needs jurisdiction-specific legal review — liability limitations that
        are enforceable in one jurisdiction may not be in another, especially where the Service is
        used by minors.]
      </p>

      <h2>12. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. Material changes will be reflected by an updated
        "Last updated" date above; continued use of the Service after a change takes effect means you
        accept the updated Terms.
      </p>

      <h2>13. Governing law</h2>
      <p>[Jurisdiction — to be filled in based on where the operating entity is registered.]</p>

      <h2>14. Contact</h2>
      <p>
        Questions about these Terms can be sent to{' '}
        <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a>.
      </p>
    </LegalShell>
  );
}
