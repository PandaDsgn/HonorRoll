import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../config';

const AuthContext = createContext(null);

export const TOKEN_KEY = 'codejudge_token';
// Holds the superadmin's own token+user while they're "inside" an
// impersonated org session — set once on the first impersonate() call,
// never overwritten by a nested one, so returning always lands back on the
// real superadmin identity regardless of how many orgs were visited.
const SUPERADMIN_BACKUP_KEY = 'codejudge_superadmin_backup';

// Sets (or clears) the Authorization header on axios's shared defaults —
// since every page imports the same 'axios' module instance, this one call
// makes every existing axios.get/post everywhere in the app automatically
// send the token, with zero per-page changes needed.
function setAuthHeader(token) {
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
}

// Wrap the app in this once, near the root. Auth is a Bearer token stored in
// localStorage, not a cookie â€” deliberately. Frontend (github.io) and backend
// (onrender.com) don't share a domain, and iOS forces every browser onto
// WebKit, which blocks third-party cookies unconditionally. A header carries
// none of that baggage, on any browser, on any device.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { id, email, role } | null
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    setAuthHeader(token);
    try {
      const res = await axios.get(`${API}/api/me`);
      setUser(res.data.user);
    } catch {
      // Token missing, expired, or the account behind it is gone â€” either
      // way, stop sending a dead token on every future request.
      localStorage.removeItem(TOKEN_KEY);
      setAuthHeader(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Called by Login.jsx right after a successful /api/login response, with
  // the token from that response body.
  const login = useCallback((token, userData) => {
    localStorage.setItem(TOKEN_KEY, token);
    setAuthHeader(token);
    setUser(userData);
  }, []);

  const logout = useCallback(async () => {
    try {
      await axios.post(`${API}/api/logout`, {});
    } catch {
      // Stateless token either way â€” clearing local state is enough to log
      // out even if this call fails (e.g. already-expired token, offline).
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SUPERADMIN_BACKUP_KEY);
    setAuthHeader(null);
    setUser(null);
  }, []);

  // Called after POST /api/superadmin/organizations/:id/impersonate
  // succeeds, with the resulting { token, user }. Stashes the CURRENT
  // (real superadmin) session first — but only if nothing's already
  // stashed, so jumping from org A straight into org B doesn't overwrite
  // the original identity with org A's impersonated one.
  const enterImpersonation = useCallback((token, userData) => {
    if (!localStorage.getItem(SUPERADMIN_BACKUP_KEY)) {
      const realToken = localStorage.getItem(TOKEN_KEY);
      if (realToken) localStorage.setItem(SUPERADMIN_BACKUP_KEY, realToken);
    }
    localStorage.setItem(TOKEN_KEY, token);
    setAuthHeader(token);
    setUser(userData);
  }, []);

  // Restores the real superadmin session from the stash and clears it.
  const exitImpersonation = useCallback(async () => {
    const realToken = localStorage.getItem(SUPERADMIN_BACKUP_KEY);
    if (!realToken) return;
    localStorage.removeItem(SUPERADMIN_BACKUP_KEY);
    localStorage.setItem(TOKEN_KEY, realToken);
    setAuthHeader(realToken);
    try {
      const res = await axios.get(`${API}/api/me`);
      setUser(res.data.user);
    } catch {
      setUser(null);
    }
  }, []);

  const isImpersonating = typeof window !== 'undefined' && !!localStorage.getItem(SUPERADMIN_BACKUP_KEY);

  const value = {
    user,
    role: user?.role ?? null,
    isAdmin: user?.role === 'admin',
    isImpersonating,
    loading,
    setUser,
    refetch,
    login,
    logout,
    enterImpersonation,
    exitImpersonation,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an <AuthProvider>');
  return ctx;
}
