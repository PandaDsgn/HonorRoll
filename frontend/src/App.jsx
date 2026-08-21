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
import Exams from './pages/Exams';
import ExamAttempt from './pages/ExamAttempt';
import ExamResult from './pages/ExamResult';
import AdminDashboard from './pages/AdminDashboard';
import ScanReview from './pages/ScanReview';
import SuperadminDashboard from './pages/SuperadminDashboard';

function App() {
  return (
    <AuthProvider>
      {/* Wrap your app in HashRouter instead of BrowserRouter */}
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/verify-organization" element={<VerifyOrganization />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          <Route path="/assignments" element={<ProtectedRoute><Problems /></ProtectedRoute>} />
          <Route path="/assignments/:id" element={<ProtectedRoute><Sandbox /></ProtectedRoute>} />
          <Route path="/assignments/:id/scan" element={<ProtectedRoute><ScanCapture /></ProtectedRoute>} />
          <Route path="/assignments/:id/result" element={<ProtectedRoute><AssignmentResult /></ProtectedRoute>} />

          <Route path="/ide" element={<ProtectedRoute><IDE /></ProtectedRoute>} />

          <Route path="/exams" element={<ProtectedRoute><Exams /></ProtectedRoute>} />
          <Route path="/exams/:id" element={<ProtectedRoute><ExamAttempt /></ProtectedRoute>} />
          <Route path="/exams/:id/result" element={<ProtectedRoute><ExamResult /></ProtectedRoute>} />

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
              <ProtectedRoute roles={['admin']}>
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

          <Route path="/sandbox" element={<Navigate to="/assignments/1" replace />} />
          <Route path="/playground" element={<Navigate to="/ide" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
