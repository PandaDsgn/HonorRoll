import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../context/AuthContext';
import ThemeToggle from '../components/ThemeToggle';
import BrandMark from '../components/BrandMark';
import { EyeIcon, EyeOffIcon } from '../components/EyeIcons';
import { API } from '../config';
import { getDeviceId } from '../lib/deviceId';
import { ensureE2eeKeys } from '../lib/e2eeKeyStore';

// Routes a freshly-issued session token to the right landing page, shared
// by the direct-login path and the post-picker path below.
function landingPathFor(role) {
  if (role === 'superadmin') return '/superadmin';
  return role === 'admin' || role === 'teacher' ? '/admin' : '/assignments';
}

const OTP_LENGTH = 6;

// One box per digit — the now-standard OTP entry pattern (auto-advances
// as you type, backspace steps back into the previous box, a paste of the
// full code fills every box at once) instead of one plain text field.
// `value`/`onChange` still deal in a single joined string, so the parent
// (Login's otpCode state, and everything that reads it — handleVerifyOtp,
// the submit button's disabled check) doesn't need to know this is
// secretly N inputs under the hood.
function OtpBoxInput({ value, onChange, disabled, resetSignal }) {
  const inputRefs = useRef([]);
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] || '');

  const focusBox = (index) => inputRefs.current[index]?.focus();

  // resetSignal ticks up every time the parent clears `value` after a
  // failed attempt (see Login's handleVerifyOtp) — without this, the box
  // that happened to be focused when the wrong code was rejected (usually
  // the last one, since that's what triggers auto-submit) would just sit
  // there empty, forcing a manual click back to box 1 to retype.
  useEffect(() => {
    if (resetSignal) focusBox(0);
  }, [resetSignal]);

  const handleChange = (index, e) => {
    // Only the digit just typed matters — the box already shows the
    // previous one, so a fresh keystroke replaces rather than appends.
    const digit = e.target.value.replace(/\D/g, '').slice(-1);
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join(''));
    if (digit && index < OTP_LENGTH - 1) focusBox(index + 1);
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      focusBox(index - 1);
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    onChange(pasted);
    focusBox(Math.min(pasted.length, OTP_LENGTH - 1));
  };

  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
      {digits.map((digit, i) => (
        <input
          // Fixed-length, position-addressed boxes (never reordered or
          // inserted), so index-as-key is exactly right here.
          key={i}
          ref={(el) => { inputRefs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={digit}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          disabled={disabled}
          autoFocus={i === 0}
          aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
          style={{
            width: 44, height: 52, textAlign: 'center', fontSize: 22, fontWeight: 600,
            borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text)',
          }}
        />
      ))}
    </div>
  );
}

// Sent to the backend as `audience` and enforced there (see POST
// /api/login) — picking a tab is a real filter, not just a label:
// signing in with a student's own credentials while "Teacher" is selected
// is now a rejection, not a silent redirect into the student area.
const AUDIENCES = [
  { key: 'student', label: 'Student' },
  { key: 'teacher', label: 'Teacher' },
  { key: 'admin', label: 'Admin' },
  { key: 'superadmin', label: 'Super Admin' },
];

export default function Login() {
  const [audience, setAudience] = useState('student');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // Set only when one email maps to more than one organization — see
  // POST /api/login, which returns { requiresOrgSelection: true, ... }
  // instead of a usable token in that case.
  const [orgChoice, setOrgChoice] = useState(null);
  const [selectingOrgId, setSelectingOrgId] = useState(null);
  // Set when the account is a teacher/student signing in for the first
  // time — their account was created by an admin, so they never saw a
  // Terms of Service checkbox anywhere else (see POST /api/login's
  // requiresTosAcceptance branch). Holds the short-lived token that
  // completes the login once they accept.
  const [tosPendingToken, setTosPendingToken] = useState(null);
  const [acceptingTos, setAcceptingTos] = useState(false);
  // Set when the account is mid-lockout (see POST /api/login's isLocked
  // branch) AND the password just entered was actually correct — the
  // backend won't grant a session yet, only a short-lived token that
  // POST /api/login/verify-lockout-otp needs to lift the lock. email/
  // password/audience are still sitting in state from the attempt that
  // got here, so once the OTP checks out, doLogin() below just replays
  // the exact same login — no separate "now sign in for real" step for
  // the user to do by hand.
  const [lockoutOtpToken, setLockoutOtpToken] = useState(null);
  // Set when POST /api/login reports this browser/device has never
  // completed verification for this account before (see that route's
  // isDeviceTrusted check). Unlike lockoutOtpToken, verifying this one
  // ALSO finishes the login outright (see handleVerifyDeviceOtp) — there's
  // no safe way to just say "now try logging in again," since a decline
  // on the trust-this-device checkbox would leave the device untrusted
  // forever and loop back into this same screen every time.
  const [deviceOtpToken, setDeviceOtpToken] = useState(null);
  // Defaults to unchecked — trusting a device is an opt-IN convenience,
  // not the default, so a login from a shared/public computer doesn't
  // silently leave a 30-day standing trust behind unless asked for.
  const [trustDevice, setTrustDevice] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpResetSignal, setOtpResetSignal] = useState(0);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  // Seconds left before "Resend code" is clickable again — 0 means ready.
  // POST /api/login/resend-lockout-otp allows the first resend instantly
  // and only starts gating from the 2nd resend onward (see that route's
  // own comment), so this only ever gets set to a nonzero value by that
  // route's 429 response, never preemptively on the frontend's own guess.
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { login } = useAuth();

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const timer = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const audienceLabel = AUDIENCES.find((a) => a.key === audience)?.label || 'Student';

  // Best-effort, fire-and-forget — chat's encrypted-key setup must never
  // block or delay a successful login. Called with whatever the `password`
  // field currently holds right at the moment each of the 4 login-
  // completion points below fires; see ensureE2eeKeys's own comment for
  // why the plaintext password (not persisted anywhere) is what a fresh
  // device needs to recover or set up this account's chat key.
  const setUpChatKeys = (userId) => {
    ensureE2eeKeys(password, userId).catch((err) => console.error('Failed to set up encrypted chat keys (continuing anyway):', err));
  };

  // Separate from handleLogin's onSubmit wrapper below so handleVerifyOtp
  // can replay the exact same login attempt once the OTP clears the lock,
  // without duplicating the requiresOrgSelection/requiresTosAcceptance/
  // requiresLockoutOtp branching a second time.
  const doLogin = async () => {
    setError('');
    setIsLoading(true);
    try {
      const response = await axios.post(
        `${API}/api/login`,
        { email, password, audience, deviceId: getDeviceId() }
      );

      if (response.data.requiresDeviceVerification) {
        setDeviceOtpToken(response.data.deviceOtpToken);
        return;
      }

      if (response.data.requiresOrgSelection) {
        setOrgChoice(response.data);
        return;
      }

      if (response.data.requiresTosAcceptance) {
        setTosPendingToken(response.data.tosPendingToken);
        return;
      }

      if (response.data.requiresLockoutOtp) {
        setLockoutOtpToken(response.data.lockoutOtpToken);
        return;
      }

      if (response.status === 200) {
        login(response.data.token, response.data.user);
        setUpChatKeys(response.data.user.id);
        // replace, not push — otherwise /login stays one swipe/back-button
        // press behind the dashboard forever, and a signed-in user landing
        // back on the login form (then having to swipe forward again to
        // undo it) reads as a bug, not real "back" navigation.
        navigate(landingPathFor(response.data.user.role), { replace: true });
      }
    } catch (err) {
      if (err.response?.data?.error) {
        setError(err.response.data.error);
      } else {
        setError('Network error. Is the backend server running?');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    doLogin();
  };

  // e is optional — called both as the form's onSubmit (button click/Enter)
  // and automatically once every box is filled (see the effect below), and
  // the latter has no event to prevent-default.
  const handleVerifyOtp = async (e) => {
    e?.preventDefault();
    setError('');
    setVerifyingOtp(true);
    try {
      await axios.post(`${API}/api/login/verify-lockout-otp`, { lockoutOtpToken, otp: otpCode });
      setLockoutOtpToken(null);
      setOtpCode('');
      await doLogin();
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setOtpCode('');
      setOtpResetSignal((s) => s + 1);
    } finally {
      setVerifyingOtp(false);
    }
  };

  // Unlike verify-lockout-otp, this route ALSO finishes the login itself
  // (see its own comment in routes/auth.js) — so this handles every
  // response shape completeLoginForUser can produce, exactly the same way
  // doLogin above does, rather than just calling doLogin() again.
  const handleVerifyDeviceOtp = async (e) => {
    e?.preventDefault();
    setError('');
    setVerifyingOtp(true);
    try {
      const response = await axios.post(`${API}/api/login/verify-device-otp`, { deviceOtpToken, otp: otpCode, trustDevice });
      setDeviceOtpToken(null);
      setOtpCode('');

      if (response.data.requiresOrgSelection) {
        setOrgChoice(response.data);
        return;
      }
      if (response.data.requiresTosAcceptance) {
        setTosPendingToken(response.data.tosPendingToken);
        return;
      }
      if (response.data.token) {
        login(response.data.token, response.data.user);
        setUpChatKeys(response.data.user.id);
        navigate(landingPathFor(response.data.user.role), { replace: true });
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setOtpCode('');
      setOtpResetSignal((s) => s + 1);
    } finally {
      setVerifyingOtp(false);
    }
  };

  // Auto-submits the instant the 6th box is filled (typing the last digit,
  // or pasting a full code) — the explicit "Verify and continue" button
  // below still works too, for anyone who'd rather not rely on that.
  // lockoutOtpToken/deviceOtpToken are never both set at once (mutually
  // exclusive branches of doLogin), so exactly one of these fires.
  useEffect(() => {
    if (otpCode.length !== OTP_LENGTH || verifyingOtp) return;
    if (lockoutOtpToken) handleVerifyOtp();
    else if (deviceOtpToken) handleVerifyDeviceOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on otpCode reaching full length, not on the handlers' own identity
  }, [otpCode, lockoutOtpToken, deviceOtpToken]);

  const handleResendOtp = async () => {
    setError('');
    setResendMessage('');
    setResending(true);
    try {
      if (lockoutOtpToken) {
        const response = await axios.post(`${API}/api/login/resend-lockout-otp`, { lockoutOtpToken });
        setLockoutOtpToken(response.data.lockoutOtpToken);
      } else if (deviceOtpToken) {
        const response = await axios.post(`${API}/api/login/resend-device-otp`, { deviceOtpToken });
        setDeviceOtpToken(response.data.deviceOtpToken);
      }
      setResendMessage('A new code is on its way.');
    } catch (err) {
      if (err.response?.data?.retryAfterSeconds) {
        setResendCooldown(err.response.data.retryAfterSeconds);
      }
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
    } finally {
      setResending(false);
    }
  };

  const handleSelectOrg = async (organizationId) => {
    setError('');
    setSelectingOrgId(organizationId);
    try {
      const response = await axios.post(`${API}/api/login/select-organization`, {
        preAuthToken: orgChoice.preAuthToken,
        organizationId,
      });
      if (response.data.requiresTosAcceptance) {
        setOrgChoice(null);
        setTosPendingToken(response.data.tosPendingToken);
        return;
      }
      login(response.data.token, response.data.user);
      setUpChatKeys(response.data.user.id);
      navigate(landingPathFor(response.data.user.role), { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setOrgChoice(null);
    } finally {
      setSelectingOrgId(null);
    }
  };

  const handleAcceptTos = async () => {
    setError('');
    setAcceptingTos(true);
    try {
      const response = await axios.post(`${API}/api/login/accept-tos`, { tosPendingToken });
      login(response.data.token, response.data.user);
      setUpChatKeys(response.data.user.id);
      navigate(landingPathFor(response.data.user.role), { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Network error. Is the backend server running?');
      setTosPendingToken(null);
    } finally {
      setAcceptingTos(false);
    }
  };

  if (orgChoice) {
    return (
      <div className="auth-shell">
        <div className="auth-panel" aria-hidden="true">
          <span className="auth-panel-eyebrow">HonorRoll</span>
          <p className="auth-panel-quote">“Where assignments earn their grade.”</p>
        </div>

        <div className="auth-card">

          <div className="auth-card-head">
            <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>

          <h2 className="auth-title">Choose a workspace</h2>
          <p className="auth-sub">This email belongs to more than one organization.</p>

          <div className="org-picker-list">
            {orgChoice.organizations.map((org) => (
              <button
                key={org.organizationId}
                type="button"
                className="org-picker-item"
                disabled={selectingOrgId !== null}
                onClick={() => handleSelectOrg(org.organizationId)}
              >
                <span className="org-picker-item-name">{org.organizationName}</span>
                <span className={`chip chip-${org.role === 'admin' ? 'hard' : org.role === 'teacher' ? 'medium' : 'easy'}`}>
                  <span className="dot" />
                  {org.role}
                </span>
              </button>
            ))}
          </div>

          <div className="auth-back-row">
            <button type="button" className="auth-link" onClick={() => setOrgChoice(null)}>
              Back to sign in
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (lockoutOtpToken) {
    return (
      <div className="auth-shell">
        <div className="auth-panel" aria-hidden="true">
          <span className="auth-panel-eyebrow">HonorRoll</span>
          <p className="auth-panel-quote">“Where assignments earn their grade.”</p>
        </div>

        <div className="auth-card">

          <div className="auth-card-head">
            <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>

          <h2 className="auth-title">Enter verification code</h2>
          <p className="auth-sub">
            Your account is temporarily locked after repeated failed login attempts, but that password was
            correct. We emailed a 6-digit code to {email} — enter it below to lift the lock and finish signing in.
          </p>

          <form onSubmit={handleVerifyOtp} className="auth-form">
            <div className="field">
              <label style={{ textAlign: 'center' }}>Verification code</label>
              <OtpBoxInput value={otpCode} onChange={setOtpCode} disabled={verifyingOtp} resetSignal={otpResetSignal} />
            </div>

            <button type="submit" className="btn btn-primary auth-submit" disabled={verifyingOtp || otpCode.length !== OTP_LENGTH}>
              {verifyingOtp && <span className="spinner" />}
              {verifyingOtp ? 'Verifying…' : 'Verify and continue'}
            </button>
          </form>

          <p className="auth-sub" style={{ textAlign: 'center', margin: '14px 0 0' }}>
            Didn't get a code?{' '}
            <button
              type="button"
              className="auth-link"
              style={{ display: 'inline' }}
              disabled={resending || resendCooldown > 0}
              onClick={handleResendOtp}
            >
              {resending ? 'Sending…' : resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}
            </button>
          </p>
          {resendMessage && <p className="auth-sub" style={{ textAlign: 'center', color: 'var(--accent)', margin: '6px 0 0' }}>{resendMessage}</p>}

          <div className="auth-back-row">
            <button type="button" className="auth-link" onClick={() => { setLockoutOtpToken(null); setOtpCode(''); setError(''); setResendMessage(''); setResendCooldown(0); }}>
              Back to sign in
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (deviceOtpToken) {
    return (
      <div className="auth-shell">
        <div className="auth-panel" aria-hidden="true">
          <span className="auth-panel-eyebrow">HonorRoll</span>
          <p className="auth-panel-quote">“Where assignments earn their grade.”</p>
        </div>

        <div className="auth-card">

          <div className="auth-card-head">
            <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>

          <h2 className="auth-title">Verify this device</h2>
          <p className="auth-sub">
            We don't recognize this browser for {email}. We emailed a 6-digit code — enter it below to continue.
          </p>

          <form onSubmit={handleVerifyDeviceOtp} className="auth-form">
            <div className="field">
              <label style={{ textAlign: 'center' }}>Verification code</label>
              <OtpBoxInput value={otpCode} onChange={setOtpCode} disabled={verifyingOtp} resetSignal={otpResetSignal} />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, justifyContent: 'center' }}>
              <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
              Trust this device for 30 days
            </label>

            <button type="submit" className="btn btn-primary auth-submit" disabled={verifyingOtp || otpCode.length !== OTP_LENGTH}>
              {verifyingOtp && <span className="spinner" />}
              {verifyingOtp ? 'Verifying…' : 'Verify and continue'}
            </button>
          </form>

          <p className="auth-sub" style={{ textAlign: 'center', margin: '14px 0 0' }}>
            Didn't get a code?{' '}
            <button
              type="button"
              className="auth-link"
              style={{ display: 'inline' }}
              disabled={resending || resendCooldown > 0}
              onClick={handleResendOtp}
            >
              {resending ? 'Sending…' : resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}
            </button>
          </p>
          {resendMessage && <p className="auth-sub" style={{ textAlign: 'center', color: 'var(--accent)', margin: '6px 0 0' }}>{resendMessage}</p>}

          <div className="auth-back-row">
            <button type="button" className="auth-link" onClick={() => { setDeviceOtpToken(null); setOtpCode(''); setError(''); setResendMessage(''); setResendCooldown(0); }}>
              Back to sign in
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (tosPendingToken) {
    return (
      <div className="auth-shell">
        <div className="auth-panel" aria-hidden="true">
          <span className="auth-panel-eyebrow">HonorRoll</span>
          <p className="auth-panel-quote">“Where assignments earn their grade.”</p>
        </div>

        <div className="auth-card">

          <div className="auth-card-head">
            <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>

          <h2 className="auth-title">Before you continue</h2>
          <p className="auth-sub">
            This is your first time signing in — please review and accept our Terms of Service and
            Privacy Policy to continue.
          </p>

          <p style={{ margin: '16px 0' }}>
            <a href="#/terms" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Terms of Service</a>
            {' · '}
            <a href="#/privacy" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Privacy Policy</a>
          </p>

          <button type="button" className="btn btn-primary auth-submit" disabled={acceptingTos} onClick={handleAcceptTos}>
            {acceptingTos && <span className="spinner" />}
            {acceptingTos ? 'Continuing…' : 'Accept and continue'}
          </button>

          <div className="auth-back-row">
            <button type="button" className="auth-link" onClick={() => setTosPendingToken(null)}>
              Back to sign in
            </button>
          </div>

          {error && (
            <div className="alert" role="alert">
              <span className="alert-icon">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel" aria-hidden="true">
        <span className="auth-panel-eyebrow">HonorRoll</span>
        <p className="auth-panel-quote">“Where assignments earn their grade.”</p>
      </div>

      <div className="auth-card">

        <div className="auth-card-head">
          <button type="button" className="brand" onClick={() => navigate('/', { replace: true })}><BrandMark /></button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>

        <h2 className="auth-title">Sign in to your workspace</h2>
        <p className="auth-sub">Use your {audienceLabel.toLowerCase()} credentials to continue.</p>

        <div className="segmented" role="tablist" aria-label="Signing in as" style={{ margin: '4px 0 20px' }}>
          {AUDIENCES.map((a) => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-pressed={audience === a.key}
              className={audience === a.key ? 'active' : ''}
              onClick={() => setAudience(a.key)}
            >
              {a.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleLogin} className="auth-form">
          <div className="field">
            <label htmlFor="email">{audienceLabel} email</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="password-field-wrap">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          <div className="auth-forgot-row">
            <button type="button" className="auth-link" onClick={() => navigate('/forgot-password', { replace: true })}>
              Forgot your password?
            </button>
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={isLoading}>
            {isLoading && <span className="spinner" />}
            {isLoading ? 'Signing in' : 'Sign in'}
          </button>
        </form>

        <div className="auth-divider">New institution</div>
        <button type="button" className="auth-alt-action" onClick={() => navigate('/signup', { replace: true })}>
          <span className="auth-alt-action-text">
            <span className="auth-alt-action-title">Set up your school or college</span>
            <span className="auth-alt-action-sub">Create an isolated workspace for your institution</span>
          </span>
          <span className="auth-alt-action-arrow" aria-hidden="true">→</span>
        </button>

        {error && (
          <div className="alert" role="alert">
            <span className="alert-icon">!</span>
            <span>{error}</span>
          </div>
        )}

        <p className="auth-sub" style={{ textAlign: 'center', margin: '20px 0 0' }}>
          <a href="#/terms" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Terms of Service</a>
          {' · '}
          <a href="#/privacy" target="_blank" rel="noreferrer" className="auth-link" style={{ display: 'inline' }}>Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
