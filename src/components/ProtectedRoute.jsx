import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function ProtectedRoute({ children }) {
  const { session, loading } = useAuth();

  if (loading) {
    return <div>Loading session...</div>;
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
