import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

// Prevent double-execution in React Strict Mode
let lastCodeRun = null;

export default function GoogleCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    async function handleCallback() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');
      const errorParam = params.get('error');

      if (errorParam) {
        setError(`Google OAuth error: ${errorParam}`);
        return;
      }

      if (!code) {
        setError('No authorization code received from Google.');
        return;
      }

      if (!state) {
        setError('Missing OAuth state from Google.');
        return;
      }

      const storedState = window.localStorage.getItem('google_oauth_state');
      if (!storedState || state !== storedState) {
        setError('OAuth state mismatch. Please try connecting Google again.');
        return;
      }

      if (code === lastCodeRun) return;
      lastCodeRun = code;

      try {
        const redirectUri = `${window.location.origin}/auth/google/callback`;

        const { data, error: fnError } = await supabase.functions.invoke('google-oauth-exchange', {
          body: { code, redirect_uri: redirectUri },
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

        // One-time use: clear state after successful exchange
        window.localStorage.removeItem('google_oauth_state');

        navigate('/dashboard', { replace: true });
      } catch (err) {
        setError(`Unexpected error: ${err?.message || String(err)}`);
        lastCodeRun = null;
      }
    }

    handleCallback();
  }, [navigate]);

  if (error) {
    return (
      <div style={{ maxWidth: '500px', margin: '0 auto', padding: '2rem' }}>
        <h1>Connection Failed</h1>
        <p style={{ color: 'red' }}>{error}</p>
        <button
          onClick={() => navigate('/dashboard')}
          style={{ padding: '0.5rem 1rem', marginTop: '1rem' }}
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '500px', margin: '0 auto', padding: '2rem' }}>
      <p>Connecting your Google account...</p>
    </div>
  );
}
