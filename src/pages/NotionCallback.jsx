import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

// Prevent double-execution in React Strict Mode
let lastCodeRun = null;

export default function NotionCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    async function handleCallback() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');
      const errorParam = params.get('error');

      if (errorParam) {
        setError(`Notion OAuth error: ${errorParam}`);
        return;
      }
      if (!code) {
        setError('No authorization code received from Notion.');
        return;
      }
      if (!state) {
        setError('Missing OAuth state from Notion.');
        return;
      }

      if (code === lastCodeRun) return;
      lastCodeRun = code;

      try {
        const redirectUri = `${window.location.origin}/auth/notion/callback`;

        const { data, error: fnError } = await supabase.functions.invoke('notion-oauth-exchange', {
          body: { code, redirect_uri: redirectUri, state },
        });

        if (fnError) {
          let msg = fnError.message;
          if (data?.error) msg = data.error;
          setError(`Token exchange failed: ${msg}`);
          lastCodeRun = null;
          return;
        }
        if (data?.error) {
          setError(`Token exchange failed: ${data.error}`);
          lastCodeRun = null;
          return;
        }

        navigate('/integrations', { replace: true });
      } catch (err) {
        setError(`Unexpected error: ${err?.message || String(err)}`);
        lastCodeRun = null;
      }
    }

    handleCallback();
  }, [navigate]);

  if (error) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Connection failed</h1>
          <div className="inline-error" role="alert" style={{ margin: 'var(--space-4) 0' }}>
            {error}
          </div>
          <button onClick={() => navigate('/integrations')} className="btn btn-primary btn-block">
            Back to integrations
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="brand" style={{ justifyContent: 'center' }}>
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>Cyrus</span>
        </div>
        <p className="muted" style={{ marginTop: 'var(--space-4)' }}>
          <span className="spinner" aria-hidden="true" /> Connecting your Notion workspace…
        </p>
      </div>
    </div>
  );
}
