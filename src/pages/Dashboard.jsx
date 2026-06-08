import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProfile() {
      if (user) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .single();
        
        if (!error && data) {
          setProfile(data);
        }
      }
      setLoading(false);
    }
    fetchProfile();
  }, [user]);

  if (loading) {
    return <div style={{ padding: '2rem' }}>Loading dashboard...</div>;
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Dashboard</h1>
        <button onClick={logout} style={{ padding: '0.5rem 1rem' }}>Logout</button>
      </div>
      
      <div style={{ marginTop: '2rem', padding: '1rem', border: '1px solid #ccc' }}>
        <h2>Profile Information</h2>
        <p><strong>Email:</strong> {user?.email}</p>
        <p><strong>Full Name:</strong> {profile?.full_name || 'Not provided'}</p>
        <p><strong>Profile ID:</strong> {profile?.id}</p>
        <p><strong>Created At:</strong> {profile?.created_at ? new Date(profile.created_at).toLocaleString() : ''}</p>
      </div>
    </div>
  );
}
