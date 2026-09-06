import LegalShell from '../components/LegalShell';

export default function CookiePolicy() {
  return (
    <LegalShell>
      <h1>Cookie Policy</h1>
      <p className="legal-updated">Last updated: 6th September, 2026</p>

      <p>
        HonorRoll does not set any cookies — no session cookies, no advertising cookies, no
        analytics or tracking cookies, first-party or third-party. This policy exists for
        transparency about the small amount of browser storage the Service does use instead.
      </p>

      <h2>1. What we use instead of cookies</h2>
      <p>
        The Service stores a few small values in your browser's local storage
        (<code>localStorage</code>), scoped to this site only and never sent to any other site.
        Each exists purely to make the Service work:
      </p>
      <ul>
        <li><strong>Session token</strong> — keeps you signed in between visits.</li>
        <li><strong>Theme preference</strong> — remembers light/dark mode.</li>
        <li><strong>Editor font size and panel layout</strong> — remembers your IDE/sandbox display preferences.</li>
        <li><strong>"Trusted device" marker</strong> — set only if you choose to skip repeat email verification on a device you use regularly.</li>
        <li><strong>Chat encryption key</strong> — if you use the chat feature, your device's end-to-end encryption private key is kept here so messages can be decrypted; it never leaves your device.</li>
        <li><strong>A small UI preference</strong> — whether the help widget is open or closed.</li>
      </ul>
      <p>
        None of this is used to track you across other websites, build an advertising profile, or
        shared with any third party. Clearing your browser's site data for HonorRoll removes all
        of it, and will sign you out.
      </p>

      <h2>2. Third-party requests</h2>
      <p>
        The page loads a stylesheet and font files from Google Fonts (fonts.googleapis.com /
        fonts.gstatic.com) so headings render correctly. This is a standard asset request, not a
        tracking script, and sets no cookie of its own — though like any request to a third-party
        server, it does reveal your IP address to Google as the operator of that CDN.
      </p>

      <h2>3. Do we need a cookie consent banner?</h2>
      <p>
        No. Consent banners exist to cover non-essential cookies (tracking, analytics,
        advertising) — since the Service sets none of those, there's nothing that requires opt-in
        consent under GDPR/ePrivacy-style rules. The local storage described above is "strictly
        necessary" for the Service to function (staying signed in, remembering your preferences),
        which is exempt from that consent requirement in every major framework we're aware of.
        <strong> If you later add analytics, ads, or any third-party tracking script, revisit this
        — that would change the answer.</strong>
      </p>

      <h2>4. Changes to this policy</h2>
      <p>
        We may update this policy if what the Service stores in your browser changes. Material
        changes will be reflected by an updated "Last updated" date above.
      </p>

      <h2>5. Contact</h2>
      <p>
        Questions about this policy can be sent to{' '}
        <a href="mailto:honorroll.admin@gmail.com">honorroll.admin@gmail.com</a>.
      </p>
    </LegalShell>
  );
}
