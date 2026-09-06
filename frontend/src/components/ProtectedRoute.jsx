import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Forbidden from '../pages/Forbidden';

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
    return <Forbidden />;
  }

  return children;
}
