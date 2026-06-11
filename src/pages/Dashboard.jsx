import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useConnectedAccounts } from '../hooks/useConnectedAccounts';
import { useEmails } from '../hooks/useEmails';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { supabase } from '../lib/supabase';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const { googleAccount, loading: accountsLoading, connectGoogle, disconnectGoogle } = useConnectedAccounts();
  const { emails, loading: emailsLoading, syncing: emailsSyncing, syncError: emailsSyncError, syncGmail, refetch: refetchEmails } = useEmails();
  const { events, loading: eventsLoading, syncing: eventsSyncing, syncError: eventsSyncError, syncCalendar, refetch: refetchEvents } = useCalendarEvents();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    async function fetchProfile() {
      if (user) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .maybeSingle();

        if (!error && data) {
          setProfile(data);
        } else if (!data) {
          const { data: newProfile, error: insertError } = await supabase
            .from('profiles')
            .insert([{ id: user.id, email: user.email, full_name: user.user_metadata?.full_name || '' }])
            .select()
            .single();
          
          if (!insertError && newProfile) {
            setProfile(newProfile);
          }
        }
      }
      setLoading(false);
    }
    fetchProfile();
  }, [user]);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectGoogle();
      await refetchEmails();
      await refetchEvents();
    } catch (err) {
      console.error('Disconnect failed:', err);
    }
    setDisconnecting(false);
  };

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
      </div>

      <div style={{ marginTop: '2rem', padding: '1rem', border: '1px solid #ccc' }}>
        <h2>Connected Accounts</h2>
        {accountsLoading ? (
          <p>Loading connections...</p>
        ) : googleAccount ? (
          <div>
            <p><strong>Google:</strong> Connected as {googleAccount.provider_email}</p>
            {googleAccount.status === 'broken' && (
              <p style={{ color: 'red' }}><strong>Connection Broken! Please reconnect.</strong></p>
            )}
            <p style={{ fontSize: '0.85rem', color: '#666' }}>
              Connected on {new Date(googleAccount.connected_at).toLocaleString()}
            </p>
            {googleAccount.last_synced_at && (
              <p style={{ fontSize: '0.85rem', color: '#666' }}>
                Last synced on {new Date(googleAccount.last_synced_at).toLocaleString()}
              </p>
            )}
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              style={{ padding: '0.5rem 1rem', marginTop: '0.5rem', backgroundColor: '#cc0000', color: 'white', border: 'none', cursor: 'pointer' }}
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect Google'}
            </button>
          </div>
        ) : (
          <div>
            <p>No Google account connected.</p>
            <button onClick={connectGoogle} style={{ padding: '0.5rem 1rem', marginTop: '0.5rem', cursor: 'pointer' }}>
              Connect Google
            </button>
          </div>
        )}
      </div>

      <div style={{ marginTop: '2rem', padding: '1rem', border: '1px solid #ccc' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Calendar Events</h2>
          <button 
            onClick={syncCalendar} 
            disabled={eventsSyncing || !googleAccount}
            style={{ padding: '0.5rem 1rem', cursor: (eventsSyncing || !googleAccount) ? 'not-allowed' : 'pointer' }}
          >
            {eventsSyncing ? 'Syncing...' : 'Manual Sync Calendar'}
          </button>
        </div>
        
        {eventsSyncError && <div style={{ color: 'red', marginTop: '1rem', marginBottom: '1rem' }}>{eventsSyncError}</div>}

        {eventsLoading ? (
          <p>Loading events...</p>
        ) : events.length > 0 ? (
          <div style={{ marginTop: '1rem' }}>
            <p>Total Events: {events.length}</p>
            <ul style={{ listStyleType: 'none', padding: 0 }}>
              {events.map(event => (
                <li key={event.id} style={{ borderBottom: '1px solid #eee', padding: '1rem 0' }}>
                  <p style={{ margin: '0 0 0.5rem 0' }}><strong>Title:</strong> {event.title || '(No Title)'}</p>
                  <p style={{ margin: '0 0 0.5rem 0' }}><strong>Start:</strong> {event.start_time ? new Date(event.start_time).toLocaleString() : 'N/A'}</p>
                  <p style={{ margin: '0 0 0.5rem 0' }}><strong>End:</strong> {event.end_time ? new Date(event.end_time).toLocaleString() : 'N/A'}</p>
                  {event.location && <p style={{ margin: '0 0 0.5rem 0', color: '#555', fontSize: '0.9rem' }}>Location: {event.location}</p>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p style={{ marginTop: '1rem' }}>No events found. Click Sync to fetch upcoming events.</p>
        )}
      </div>

      <div style={{ marginTop: '2rem', padding: '1rem', border: '1px solid #ccc' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Emails</h2>
          <button 
            onClick={syncGmail} 
            disabled={emailsSyncing || !googleAccount}
            style={{ padding: '0.5rem 1rem', cursor: (emailsSyncing || !googleAccount) ? 'not-allowed' : 'pointer' }}
          >
            {emailsSyncing ? 'Syncing...' : 'Manual Sync Gmail'}
          </button>
        </div>
        
        {emailsSyncError && <div style={{ color: 'red', marginTop: '1rem', marginBottom: '1rem' }}>{emailsSyncError}</div>}

        {emailsLoading ? (
          <p>Loading emails...</p>
        ) : emails.length > 0 ? (
          <div style={{ marginTop: '1rem' }}>
            <p>Total Emails: {emails.length}</p>
            <ul style={{ listStyleType: 'none', padding: 0 }}>
              {emails.map(email => (
                <li key={email.id} style={{ borderBottom: '1px solid #eee', padding: '1rem 0' }}>
                  <p style={{ margin: '0 0 0.5rem 0' }}><strong>From:</strong> {email.sender}</p>
                  <p style={{ margin: '0 0 0.5rem 0' }}><strong>Subject:</strong> {email.subject}</p>
                  <p style={{ margin: '0 0 0.5rem 0', color: '#555', fontSize: '0.9rem' }}>{email.snippet}</p>
                  <p style={{ margin: '0', color: '#888', fontSize: '0.8rem' }}>
                    Received: {email.received_at ? new Date(email.received_at).toLocaleString() : 'Unknown'}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p style={{ marginTop: '1rem' }}>No emails found. Click Sync to fetch emails.</p>
        )}
      </div>

    </div>
  );
}
