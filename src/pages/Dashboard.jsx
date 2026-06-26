import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useConnectedAccounts } from '../hooks/useConnectedAccounts';
import { useEmails } from '../hooks/useEmails';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { useMemory } from '../hooks/useMemory';
import { useBriefings } from '../hooks/useBriefings';
import { supabase } from '../lib/supabase';
import { AppLayout } from '../components/AppLayout';
import { SkeletonList, SkeletonText } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../hooks/useToast';

export default function Dashboard() {
  const { user } = useAuth();
  const { googleAccount, loading: accountsLoading, connectGoogle, disconnectGoogle } = useConnectedAccounts();
  const { emails, loading: emailsLoading, syncing: emailsSyncing, syncError: emailsSyncError, syncGmail, refetch: refetchEmails } = useEmails();
  const { events, loading: eventsLoading, syncing: eventsSyncing, syncError: eventsSyncError, syncCalendar, refetch: refetchEvents } = useCalendarEvents();
  const { memories } = useMemory();
  const { briefings } = useBriefings();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [llmJobStats, setLlmJobStats] = useState(null);
  const toast = useToast();

  useEffect(() => {
    async function fetchLlmJobStats() {
      if (!user) return;
      const { data } = await supabase
        .from('llm_jobs')
        .select('status')
        .eq('user_id', user.id);
      if (data) {
        const total = data.length;
        const completed = data.filter(j => j.status === 'completed').length;
        const failed = data.filter(j => j.status === 'permanently_failed').length;
        const pending = data.filter(j => j.status === 'pending' || j.status === 'processing').length;
        setLlmJobStats({ total, completed, failed, pending });
      }
    }
    fetchLlmJobStats();
  }, [user]);

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

  // Surface sync errors as toasts (in addition to inline messages).
  useEffect(() => {
    if (emailsSyncError) toast.error(emailsSyncError);
  }, [emailsSyncError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (eventsSyncError) toast.error(eventsSyncError);
  }, [eventsSyncError]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = async () => {
    // Optimistic UI: show connecting state immediately; connectGoogle redirects.
    setConnecting(true);
    try {
      await connectGoogle();
    } catch (err) {
      toast.error(err?.message || 'Failed to start Google connection.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectGoogle();
      await refetchEmails();
      await refetchEvents();
      toast.success('Google account disconnected.');
    } catch (err) {
      console.error('Disconnect failed:', err);
      toast.error(err?.message || 'Failed to disconnect Google.');
    }
    setDisconnecting(false);
  };

  const handleSyncGmail = async () => {
    await syncGmail();
  };

  const handleSyncCalendar = async () => {
    await syncCalendar();
  };

  return (
    <AppLayout>
      <div className="container">
        <div className="row-between" style={{ marginBottom: 'var(--space-5)' }}>
          <div>
            <h1>Dashboard</h1>
            <p className="muted" style={{ margin: 0 }}>
              Your connected accounts, calendar and inbox at a glance.
            </p>
          </div>
        </div>

        <section className="card">
          <div className="card-header">
            <h2>Summary</h2>
          </div>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-label">Connected Accounts</span>
              <span className="stat-value">{accountsLoading ? '…' : googleAccount ? '1' : '0'}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Emails</span>
              <span className="stat-value">{emails.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Calendar Events</span>
              <span className="stat-value">{events.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Memories</span>
              <span className="stat-value">{memories.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Briefings</span>
              <span className="stat-value">{briefings.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Last Sync</span>
              <span className="stat-value text-sm">
                {googleAccount?.last_synced_at
                  ? new Date(googleAccount.last_synced_at).toLocaleDateString()
                  : 'Never'}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">LLM Jobs</span>
              <span className="stat-value">
                {llmJobStats
                  ? `${llmJobStats.completed} ok${llmJobStats.failed > 0 ? ` / ${llmJobStats.failed} failed` : ''}`
                  : '…'}
              </span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Profile</h2>
          </div>
          {loading ? (
            <SkeletonText lines={2} />
          ) : (
            <dl className="kv">
              <dt>Email</dt>
              <dd>{user?.email}</dd>
              <dt>Full name</dt>
              <dd>{profile?.full_name || 'Not provided'}</dd>
            </dl>
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Connected accounts</h2>
          </div>
          {accountsLoading ? (
            <SkeletonText lines={2} />
          ) : googleAccount ? (
            <div>
              <div className="row-between">
                <div className="integration-meta">
                  <span className="integration-logo" aria-hidden="true">
                    G
                  </span>
                  <div>
                    <div className="integration-name">Google</div>
                    <div className="text-sm muted">{googleAccount.provider_email}</div>
                  </div>
                </div>
                {googleAccount.status === 'broken' ? (
                  <span className="badge badge-danger">Connection broken</span>
                ) : (
                  <span className="badge badge-success">Connected</span>
                )}
              </div>

              {googleAccount.status === 'broken' && (
                <div className="inline-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                  Connection broken — please reconnect.
                </div>
              )}

              <p className="text-sm muted" style={{ marginTop: 'var(--space-3)' }}>
                Connected on {new Date(googleAccount.connected_at).toLocaleString()}
              </p>
              {googleAccount.last_synced_at && (
                <p className="text-sm muted">
                  Last synced on {new Date(googleAccount.last_synced_at).toLocaleString()}
                </p>
              )}
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="btn btn-danger btn-sm"
                style={{ marginTop: 'var(--space-2)' }}
              >
                {disconnecting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Disconnecting…
                  </>
                ) : (
                  'Disconnect Google'
                )}
              </button>
            </div>
          ) : (
            <EmptyState
              icon="🔗"
              title="No accounts connected"
              description="Connect your Google account to sync Gmail and Calendar."
              action={
                <button onClick={handleConnect} disabled={connecting} className="btn btn-primary">
                  {connecting ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Connecting…
                    </>
                  ) : (
                    'Connect Google'
                  )}
                </button>
              }
            />
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Calendar events</h2>
            <button
              onClick={handleSyncCalendar}
              disabled={eventsSyncing || !googleAccount}
              className="btn btn-secondary btn-sm"
            >
              {eventsSyncing ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Syncing…
                </>
              ) : (
                'Sync calendar'
              )}
            </button>
          </div>

          {eventsSyncError && (
            <div className="inline-error" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
              {eventsSyncError}
            </div>
          )}

          {eventsLoading ? (
            <SkeletonList items={3} />
          ) : events.length > 0 ? (
            <>
              <p className="text-sm muted">Total events: {events.length}</p>
              <ul className="list">
                {events.map((event) => (
                  <li key={event.id} className="list-item">
                    <p>
                      <strong>{event.title || '(No title)'}</strong>
                    </p>
                    <p className="text-sm">
                      <span className="muted">Start: </span>
                      {event.start_time ? new Date(event.start_time).toLocaleString() : 'N/A'}
                    </p>
                    <p className="text-sm">
                      <span className="muted">End: </span>
                      {event.end_time ? new Date(event.end_time).toLocaleString() : 'N/A'}
                    </p>
                    {event.location && (
                      <p className="text-sm muted">Location: {event.location}</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState
              icon="📅"
              title="No events yet"
              description={
                googleAccount
                  ? 'Click Sync calendar to fetch your upcoming events.'
                  : 'Connect Google to start syncing your calendar.'
              }
            />
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Emails</h2>
            <button
              onClick={handleSyncGmail}
              disabled={emailsSyncing || !googleAccount}
              className="btn btn-secondary btn-sm"
            >
              {emailsSyncing ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Syncing…
                </>
              ) : (
                'Sync Gmail'
              )}
            </button>
          </div>

          {emailsSyncError && (
            <div className="inline-error" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
              {emailsSyncError}
            </div>
          )}

          {emailsLoading ? (
            <SkeletonList items={3} />
          ) : emails.length > 0 ? (
            <>
              <p className="text-sm muted">Total emails: {emails.length}</p>
              <ul className="list">
                {emails.map((email) => (
                  <li key={email.id} className="list-item">
                    <p className="text-sm">
                      <span className="muted">From: </span>
                      {email.sender}
                    </p>
                    <p>
                      <strong>{email.subject}</strong>
                    </p>
                    <p className="text-sm muted">{email.snippet}</p>
                    <p className="text-xs muted">
                      Received: {email.received_at ? new Date(email.received_at).toLocaleString() : 'Unknown'}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState
              icon="✉️"
              title="No emails yet"
              description={
                googleAccount
                  ? 'Click Sync Gmail to fetch your latest messages.'
                  : 'Connect Google to start syncing your inbox.'
              }
            />
          )}
        </section>
      </div>
    </AppLayout>
  );
}
