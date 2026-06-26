import { useState } from 'react';
import { useConnectedAccounts } from '../hooks/useConnectedAccounts';
import { AppLayout } from '../components/AppLayout';
import { SkeletonList } from '../components/Skeleton';
import { useToast } from '../hooks/useToast';

const COMING_SOON = [
  { name: 'Outlook', logo: 'O' },
  { name: 'Microsoft Teams', logo: 'T' },
  { name: 'GitHub', logo: 'G' },
  { name: 'Jira', logo: 'J' },
  { name: 'Linear', logo: 'L' },
];

export default function Integrations() {
  const {
    googleAccount,
    slackAccount,
    loading,
    connectGoogle,
    disconnectGoogle,
    connectSlack,
    disconnectSlack,
    notionAccount,
    connectNotion,
    disconnectNotion,
  } = useConnectedAccounts();
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [slackConnecting, setSlackConnecting] = useState(false);
  const [slackDisconnecting, setSlackDisconnecting] = useState(false);
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [notionDisconnecting, setNotionDisconnecting] = useState(false);

  const handleConnect = async () => {
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
      toast.success('Google account disconnected.');
    } catch (err) {
      toast.error(err?.message || 'Failed to disconnect Google.');
    }
    setDisconnecting(false);
  };

  const handleSlackConnect = async () => {
    setSlackConnecting(true);
    try {
      await connectSlack();
    } catch (err) {
      toast.error(err?.message || 'Failed to start Slack connection.');
      setSlackConnecting(false);
    }
  };

  const handleSlackDisconnect = async () => {
    setSlackDisconnecting(true);
    try {
      await disconnectSlack();
      toast.success('Slack workspace disconnected.');
    } catch (err) {
      toast.error(err?.message || 'Failed to disconnect Slack.');
    }
    setSlackDisconnecting(false);
  };

  const handleNotionConnect = async () => {
    setNotionConnecting(true);
    try {
      await connectNotion();
    } catch (err) {
      toast.error(err?.message || 'Failed to start Notion connection.');
      setNotionConnecting(false);
    }
  };

  const handleNotionDisconnect = async () => {
    setNotionDisconnecting(true);
    try {
      await disconnectNotion();
      toast.success('Notion workspace disconnected.');
    } catch (err) {
      toast.error(err?.message || 'Failed to disconnect Notion.');
    }
    setNotionDisconnecting(false);
  };

  return (
    <AppLayout>
      <div className="container">
        <h1>Integrations</h1>
        <p className="muted">Connect the tools you use. Google powers Gmail and Calendar sync today.</p>

        <section className="card">
          <div className="card-header">
            <h2>Available</h2>
          </div>
          {loading ? (
            <SkeletonList items={1} />
          ) : (
            <div className="integration-row">
              <div className="integration-meta">
                <span className="integration-logo" aria-hidden="true">
                  G
                </span>
                <div>
                  <div className="integration-name">Google</div>
                  <div className="text-sm muted">
                    {googleAccount ? googleAccount.provider_email : 'Gmail & Calendar'}
                  </div>
                </div>
              </div>
              {googleAccount ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                    <span className={`badge ${googleAccount.status === 'broken' ? 'badge-danger' : 'badge-success'}`}>
                      {googleAccount.status === 'broken' ? 'Broken' : 'Connected'}
                    </span>
                    <button
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="btn btn-danger btn-sm"
                    >
                      {disconnecting ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> Disconnecting…
                        </>
                      ) : (
                        'Disconnect'
                      )}
                    </button>
                  </div>
                  {googleAccount.last_synced_at && (
                    <p className="text-xs muted">Last sync: {new Date(googleAccount.last_synced_at).toLocaleString()}</p>
                  )}
                  <p className="text-xs muted">Connected: {new Date(googleAccount.connected_at).toLocaleDateString()}</p>
                </div>
              ) : (
                <button onClick={handleConnect} disabled={connecting} className="btn btn-primary btn-sm">
                  {connecting ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Connecting…
                    </>
                  ) : (
                    'Connect'
                  )}
                </button>
              )}
            </div>
          )}
          {!loading && (
            <div className="integration-row">
              <div className="integration-meta">
                <span className="integration-logo" aria-hidden="true">
                  #
                </span>
                <div>
                  <div className="integration-name">Slack</div>
                  <div className="text-sm muted">
                    {slackAccount ? slackAccount.provider_email || 'Connected workspace' : 'Workspace messages'}
                  </div>
                </div>
              </div>
              {slackAccount ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                    <span className={`badge ${slackAccount.status === 'broken' ? 'badge-danger' : 'badge-success'}`}>
                      {slackAccount.status === 'broken' ? 'Broken' : 'Connected'}
                    </span>
                    <button
                      onClick={handleSlackDisconnect}
                      disabled={slackDisconnecting}
                      className="btn btn-danger btn-sm"
                    >
                      {slackDisconnecting ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> Disconnecting…
                        </>
                      ) : (
                        'Disconnect'
                      )}
                    </button>
                  </div>
                  {slackAccount.last_synced_at && (
                    <p className="text-xs muted">Last sync: {new Date(slackAccount.last_synced_at).toLocaleString()}</p>
                  )}
                  <p className="text-xs muted">Connected: {new Date(slackAccount.connected_at).toLocaleDateString()}</p>
                </div>
              ) : (
                <button onClick={handleSlackConnect} disabled={slackConnecting} className="btn btn-primary btn-sm">
                  {slackConnecting ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Connecting…
                    </>
                  ) : (
                    'Connect'
                  )}
                </button>
              )}
            </div>
          )}
          {!loading && (
            <div className="integration-row">
              <div className="integration-meta">
                <span className="integration-logo" aria-hidden="true">
                  N
                </span>
                <div>
                  <div className="integration-name">Notion</div>
                  <div className="text-sm muted">
                    {notionAccount ? notionAccount.provider_email || 'Connected workspace' : 'Workspace pages'}
                  </div>
                </div>
              </div>
              {notionAccount ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
                    <span className={`badge ${notionAccount.status === 'broken' ? 'badge-danger' : 'badge-success'}`}>
                      {notionAccount.status === 'broken' ? 'Broken' : 'Connected'}
                    </span>
                    <button
                      onClick={handleNotionDisconnect}
                      disabled={notionDisconnecting}
                      className="btn btn-danger btn-sm"
                    >
                      {notionDisconnecting ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> Disconnecting…
                        </>
                      ) : (
                        'Disconnect'
                      )}
                    </button>
                  </div>
                  {notionAccount.last_synced_at && (
                    <p className="text-xs muted">Last sync: {new Date(notionAccount.last_synced_at).toLocaleString()}</p>
                  )}
                  <p className="text-xs muted">Connected: {new Date(notionAccount.connected_at).toLocaleDateString()}</p>
                </div>
              ) : (
                <button onClick={handleNotionConnect} disabled={notionConnecting} className="btn btn-primary btn-sm">
                  {notionConnecting ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Connecting…
                    </>
                  ) : (
                    'Connect'
                  )}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Coming soon</h2>
          </div>
          {COMING_SOON.map((integration) => (
            <div className="integration-row" key={integration.name}>
              <div className="integration-meta">
                <span className="integration-logo" aria-hidden="true">
                  {integration.logo}
                </span>
                <div>
                  <div className="integration-name">{integration.name}</div>
                  <div className="text-sm muted">Not yet available</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <span className="badge badge-muted">Coming soon</span>
                <button className="btn btn-secondary btn-sm" disabled aria-disabled="true">
                  Connect
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </AppLayout>
  );
}
