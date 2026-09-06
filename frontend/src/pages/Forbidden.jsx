import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ErrorPage from '../components/ErrorPage';

// Rendered by ProtectedRoute when a signed-in user's own role isn't in the
// route's allowed list — used to be a silent redirect straight to their
// own home with no explanation (see ProtectedRoute's own history), which
// reads as "the button did nothing" rather than "you don't have access."
export default function Forbidden() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const home = user?.role === 'superadmin' ? '/superadmin' : user?.role === 'admin' || user?.role === 'teacher' ? '/admin' : '/assignments';

  // PageMeta (mounted at the router root) sets a title from the URL
  // alone, so it can't tell "the real page at this path" apart from
  // "Forbidden rendered instead" — this runs after it (Forbidden sits
  // deeper in the tree, so its effect commits later) and wins.
  useEffect(() => {
    document.title = 'Access Denied · HonorRoll';
  }, []);

  return (
    <ErrorPage
      code="403"
      title="Access denied"
      message="Your account doesn't have permission to view this page."
      actions={<button type="button" className="btn btn-primary" onClick={() => navigate(home, { replace: true })}>Go to your workspace</button>}
    />
  );
}
