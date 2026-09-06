// Change BrowserRouter to HashRouter
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Home from './pages/Home';
import Login from './pages/Login';
import Signup from './pages/Signup';
import VerifyOrganization from './pages/VerifyOrganization';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Problems from './pages/Problems';
import AssignmentResult from './pages/AssignmentResult';
import Sandbox from './pages/Sandbox';
import ScanCapture from './pages/ScanCapture';
import IDE from './pages/IDE';
import CustomQuoteRequest from './pages/CustomQuoteRequest';
import Exams from './pages/Exams';
import ExamAttempt from './pages/ExamAttempt';
import ExamResult from './pages/ExamResult';
import AdminDashboard from './pages/AdminDashboard';
import MyPerformance from './pages/MyPerformance';
import MyProfile from './pages/MyProfile';
import Notes from './pages/Notes';
import Notices from './pages/Notices';
import Doubts from './pages/Doubts';
import Chat from './pages/Chat';
import ScanReview from './pages/ScanReview';
import SuperadminDashboard from './pages/SuperadminDashboard';
import SuperadminOrgDetail from './pages/SuperadminOrgDetail';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import CookiePolicy from './pages/CookiePolicy';
import RefundPolicy from './pages/RefundPolicy';
import About from './pages/About';
import Contact from './pages/Contact';
import Changelog from './pages/Changelog';
import AssistantWidget from './components/AssistantWidget';
import DemoBanner from './components/DemoBanner';
import ErrorBoundary from './components/ErrorBoundary';
import PageMeta from './components/PageMeta';
import NotFound from './pages/NotFound';

function App() {
  return (
    <AuthProvider>
      {/* Wrap your app in HashRouter instead of BrowserRouter */}
      <HashRouter>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <PageMeta />
        <DemoBanner />
        <ErrorBoundary>
        <main id="main-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/verify-organization" element={<VerifyOrganization />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/cookies" element={<CookiePolicy />} />
          <Route path="/refunds" element={<RefundPolicy />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/changelog" element={<Changelog />} />

          <Route path="/assignments" element={<ProtectedRoute><Problems /></ProtectedRoute>} />
          <Route path="/assignments/:id" element={<ProtectedRoute><Sandbox /></ProtectedRoute>} />
          <Route path="/assignments/:id/scan" element={<ProtectedRoute><ScanCapture /></ProtectedRoute>} />
          <Route path="/assignments/:id/result" element={<ProtectedRoute><AssignmentResult /></ProtectedRoute>} />

          <Route path="/ide" element={<ProtectedRoute><IDE /></ProtectedRoute>} />
          <Route path="/admin/billing/custom-quote" element={<ProtectedRoute roles={['admin']}><CustomQuoteRequest /></ProtectedRoute>} />

          <Route path="/exams" element={<ProtectedRoute><Exams /></ProtectedRoute>} />
          <Route path="/exams/:id" element={<ProtectedRoute><ExamAttempt /></ProtectedRoute>} />
          <Route path="/exams/:id/result" element={<ProtectedRoute><ExamResult /></ProtectedRoute>} />

          <Route path="/performance" element={<ProtectedRoute roles={['student']}><MyPerformance /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute roles={['admin', 'teacher', 'superadmin']}><MyProfile /></ProtectedRoute>} />
          <Route path="/notes" element={<ProtectedRoute roles={['student']}><Notes /></ProtectedRoute>} />
          <Route path="/notices" element={<ProtectedRoute roles={['student', 'teacher']}><Notices /></ProtectedRoute>} />
          <Route path="/doubts" element={<ProtectedRoute roles={['student']}><Doubts /></ProtectedRoute>} />
          <Route path="/chat" element={<ProtectedRoute roles={['student']}><Chat /></ProtectedRoute>} />

          <Route
            path="/admin"
            element={
              <ProtectedRoute roles={['admin', 'teacher']}>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />

          <Route
            path="/admin/scan-submissions/:id"
            element={
              <ProtectedRoute roles={['admin', 'teacher']}>
                <ScanReview />
              </ProtectedRoute>
            }
          />

          <Route
            path="/superadmin"
            element={
              <ProtectedRoute roles={['superadmin']}>
                <SuperadminDashboard />
              </ProtectedRoute>
            }
          />

          <Route
            path="/superadmin/organizations/:orgId"
            element={
              <ProtectedRoute roles={['superadmin']}>
                <SuperadminOrgDetail />
              </ProtectedRoute>
            }
          />

          <Route path="/sandbox" element={<Navigate to="/assignments/1" replace />} />
          <Route path="/playground" element={<Navigate to="/ide" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </main>
        </ErrorBoundary>
        <AssistantWidget />
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
