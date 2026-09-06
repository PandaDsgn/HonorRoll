import { useNavigate } from 'react-router-dom';
import ErrorPage from '../components/ErrorPage';

// The wildcard route's own page (see App.jsx's path="*") — every unmatched
// URL used to silently redirect to Home with no explanation; this replaces
// that with an actual page, at the actual bad URL, same as any real site.
export default function NotFound() {
  const navigate = useNavigate();
  return (
    <ErrorPage
      code="404"
      title="Page not found"
      message="The page you're looking for doesn't exist, or it's moved."
      actions={<button type="button" className="btn btn-primary" onClick={() => navigate('/')}>Back to home</button>}
    />
  );
}
