import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Wrap any route element in this.
 *  - No `roles` prop  -> just requires "logged in, any role".
 *  - roles={['admin']} -> requires that specific role, otherwise bounces the
 *    user to their own home instead of showing a dead end.
 *
 * Usage:
 *   <Route path="/admin" element={<ProtectedRoute roles={['admin']}><AdminDashboard /></ProtectedRoute>} />
 */
export default function ProtectedRoute({ children, roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="sb-loading" style={{ padding: 40 }}>Checking session…</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (roles && !roles.includes(user.role)) {
    // Teacher lands in the same admin shell as admin for now — AdminDashboard
    // itself hides admin-only panels (org structure, approvals) when the
    // signed-in role is 'teacher'. A superadmin has no org membership at
    // all, so /admin or /assignments would both 404 on them — they only
    // ever belong on /superadmin.
    const home = user.role === 'superadmin' ? '/superadmin' : user.role === 'admin' || user.role === 'teacher' ? '/admin' : '/assignments';
    return <Navigate to={home} replace />;
  }

  return children;
}
