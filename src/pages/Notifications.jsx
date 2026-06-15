import { useConnectedAccounts } from '../hooks/useConnectedAccounts';
import { useEmails } from '../hooks/useEmails';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { AppLayout } from '../components/AppLayout';
import { SkeletonList } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

function buildNotifications({ googleAccount, emails, events }) {
  const items = [];

  if (!googleAccount) {
    items.push({
      id: 'no-google',
      type: 'warning',
      title: 'Connect your Google account',
      body: 'Sync Gmail and Calendar to start receiving updates.',
    });
  } else {
    if (googleAccount.status === 'broken') {
      items.push({
        id: 'google-broken',
        type: 'error',
        title: 'Google connection needs attention',
        body: 'Your Google connection is broken. Reconnect to resume syncing.',
        time: googleAccount.connected_at,
      });
    }
    if (googleAccount.last_synced_at) {
      items.push({
        id: 'last-sync',
        type: 'info',
        title: 'Accounts synced',
        body: `Last successful sync for ${googleAccount.provider_email}.`,
        time: googleAccount.last_synced_at,
      });
    }
    if (events.length > 0) {
      items.push({
        id: 'events',
        type: 'info',
        title: `${events.length} calendar event${events.length === 1 ? '' : 's'} synced`,
        body: 'Your upcoming events are up to date.',
      });
    }
    if (emails.length > 0) {
      items.push({
        id: 'emails',
        type: 'info',
        title: `${emails.length} email${emails.length === 1 ? '' : 's'} synced`,
        body: 'Your inbox snapshot is up to date.',
      });
    }
  }

  return items;
}

const TYPE_BADGE = {
  info: 'badge-accent',
  warning: 'badge',
  error: 'badge-danger',
};

export default function Notifications() {
  const { googleAccount, loading: accountsLoading } = useConnectedAccounts();
  const { emails, loading: emailsLoading } = useEmails();
  const { events, loading: eventsLoading } = useCalendarEvents();

  const loading = accountsLoading || emailsLoading || eventsLoading;
  const notifications = loading ? [] : buildNotifications({ googleAccount, emails, events });

  return (
    <AppLayout>
      <div className="container">
        <h1>Notifications</h1>
        <p className="muted">Updates about your connections and synced data.</p>

        <section className="card">
          {loading ? (
            <SkeletonList items={3} />
          ) : notifications.length > 0 ? (
            <ul className="list">
              {notifications.map((n) => (
                <li key={n.id} className="list-item">
                  <div className="row-between">
                    <p>
                      <strong>{n.title}</strong>
                    </p>
                    <span className={`badge ${TYPE_BADGE[n.type] || 'badge'}`}>{n.type}</span>
                  </div>
                  <p className="text-sm muted" style={{ margin: 0 }}>
                    {n.body}
                  </p>
                  {n.time && (
                    <p className="text-xs muted" style={{ marginTop: 'var(--space-1)' }}>
                      {new Date(n.time).toLocaleString()}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="🔔"
              title="You're all caught up"
              description="There are no notifications right now."
            />
          )}
        </section>
      </div>
    </AppLayout>
  );
}
