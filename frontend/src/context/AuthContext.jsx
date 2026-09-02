import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API } from '../config';
import { connectRealtime, disconnectRealtime } from '../lib/realtime';

const AuthContext = createContext(null);

export const TOKEN_KEY = 'codejudge_token';

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

// Scopes a superadmin's own (never-swapped) requests to one org — see
// AdminDashboard's viewingOrgId branch and requireAdmin's own comment on the
// backend. Exported standalone rather than through the context value since
// it's a plain axios-defaults setter, same shape as setAuthHeader above, not
// something that needs to trigger a re-render.
export function setOrgOverrideHeader(organizationId) {
  if (organizationId) {
    axios.defaults.headers.common['X-Organization-Id'] = String(organizationId);
  } else {
    delete axios.defaults.headers.common['X-Organization-Id'];
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
      disconnectRealtime();
      setLoading(false);
      return;
    }
    setAuthHeader(token);
    try {
      const res = await axios.get(`${API}/api/me`);
      setUser(res.data.user);
      connectRealtime(token);
    } catch {
      // Token missing, expired, or the account behind it is gone â€” either
      // way, stop sending a dead token on every future request.
      localStorage.removeItem(TOKEN_KEY);
      setAuthHeader(null);
      setUser(null);
      disconnectRealtime();
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
    connectRealtime(token);
  }, []);

  const logout = useCallback(async () => {
    try {
      await axios.post(`${API}/api/logout`, {});
    } catch {
      // Stateless token either way â€” clearing local state is enough to log
      // out even if this call fails (e.g. already-expired token, offline).
    }
    localStorage.removeItem(TOKEN_KEY);
    setAuthHeader(null);
    setUser(null);
    disconnectRealtime();
  }, []);

  const value = {
    user,
    role: user?.role ?? null,
    isAdmin: user?.role === 'admin',
    loading,
    setUser,
    refetch,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an <AuthProvider>');
  return ctx;
}
