import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ToastProvider } from './components/Toast';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Dashboard from './pages/Dashboard';
import GoogleCallback from './pages/GoogleCallback';
import SlackCallback from './pages/SlackCallback';
import NotionCallback from './pages/NotionCallback';
import Onboarding from './pages/Onboarding';
import Account from './pages/Account';
import Integrations from './pages/Integrations';
import Profile from './pages/Profile';
import Notifications from './pages/Notifications';
import Billing from './pages/Billing';

function App() {
  return (
    <ToastProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/onboarding"
            element={
              <ProtectedRoute>
                <Onboarding />
              </ProtectedRoute>
            }
          />
          <Route
            path="/integrations"
            element={
              <ProtectedRoute>
                <Integrations />
              </ProtectedRoute>
            }
          />
          <Route
            path="/account"
            element={
              <ProtectedRoute>
                <Account />
              </ProtectedRoute>
            }
          />
          <Route
            path="/billing"
            element={
              <ProtectedRoute>
                <Billing />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            }
          />
          <Route
            path="/notifications"
            element={
              <ProtectedRoute>
                <Notifications />
              </ProtectedRoute>
            }
          />
          <Route
            path="/auth/google/callback"
            element={
              <ProtectedRoute>
                <GoogleCallback />
              </ProtectedRoute>
            }
          />
          <Route
            path="/auth/slack/callback"
            element={
              <ProtectedRoute>
                <SlackCallback />
              </ProtectedRoute>
            }
          />
          <Route
            path="/auth/notion/callback"
            element={
              <ProtectedRoute>
                <NotionCallback />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Router>
    </ToastProvider>
  );
}

export default App;
