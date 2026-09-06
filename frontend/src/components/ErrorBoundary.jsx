import { Component } from 'react';
import ErrorPage from './ErrorPage';

// A class component because React's error-boundary API (getDerivedState
// FromError/componentDidCatch) has no hook equivalent — this is the one
// place in the app that has to be one. Wraps <Routes> in App.jsx: today,
// an uncaught render-time exception anywhere in the app unmounts
// everything with no boundary above it, leaving a blank white page with
// no explanation. This is the difference between that and an actual 500
// page. Doesn't catch errors in event handlers or async code (React
// boundaries never do) — those are still each page's own job, same as the
// inline "Failed to load X" alerts already used throughout this app.
export default class ErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('Uncaught render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorPage
          code="500"
          title="Something went wrong"
          message="An unexpected error occurred. Reloading usually fixes it."
          actions={<button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>}
        />
      );
    }
    return this.props.children;
  }
}
