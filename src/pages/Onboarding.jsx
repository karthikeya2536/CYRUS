import { useNavigate } from 'react-router-dom';
import { useConnectedAccounts } from '../hooks/useConnectedAccounts';
import { AppLayout } from '../components/AppLayout';
import { useToast } from '../hooks/useToast';
import { useState } from 'react';

export default function Onboarding() {
  const navigate = useNavigate();
  const { googleAccount, loading, connectGoogle } = useConnectedAccounts();
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await connectGoogle();
    } catch (err) {
      toast.error(err?.message || 'Failed to start Google connection.');
      setConnecting(false);
    }
  };

  const steps = [
    {
      title: 'Create your account',
      description: 'You are signed in — your workspace is ready.',
      done: true,
    },
    {
      title: 'Connect Google',
      description: 'Sync Gmail and Calendar to power your dashboard.',
      done: !!googleAccount,
    },
    {
      title: 'Explore your dashboard',
      description: 'Review your synced emails and upcoming events.',
      done: false,
    },
  ];

  return (
    <AppLayout>
      <div className="container">
        <h1>Welcome to Cyrus</h1>
        <p className="muted">Let&apos;s get your workspace set up in a few steps.</p>

        <section className="card">
          <ul className="list">
            {steps.map((step) => (
              <li key={step.title} className="list-item">
                <div className="row-between">
                  <div>
                    <p>
                      <strong>{step.title}</strong>
                    </p>
                    <p className="text-sm muted" style={{ margin: 0 }}>
                      {step.description}
                    </p>
                  </div>
                  {step.done ? (
                    <span className="badge badge-success">Done</span>
                  ) : (
                    <span className="badge badge-muted">Pending</span>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="row-between" style={{ marginTop: 'var(--space-4)' }}>
            {!loading && !googleAccount && (
              <button onClick={handleConnect} disabled={connecting} className="btn btn-primary">
                {connecting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Connecting…
                  </>
                ) : (
                  'Connect Google'
                )}
              </button>
            )}
            <button onClick={() => navigate('/dashboard')} className="btn btn-secondary">
              Go to dashboard
            </button>
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
