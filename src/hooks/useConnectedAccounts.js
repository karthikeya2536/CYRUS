import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useConnectedAccounts() {
  const { session, user } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    if (!user) {
      setAccounts([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', user.id);

    if (!error && data) {
      setAccounts(data);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const connectGoogle = () => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    const redirectUri = `${window.location.origin}/auth/google/callback`;
    const scope = encodeURIComponent('openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly');

    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    const state = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    window.localStorage.setItem('google_oauth_state', state);

    const url =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&state=${state}`;

    window.location.href = url;
  };

  const disconnectGoogle = async () => {
    if (!user) return;

    // 1. Invoke edge function to clean up secrets first
    const { error: fnError } = await supabase.functions.invoke('google-oauth-disconnect', {
      body: { provider: 'google' },
    });

    if (fnError) {
      console.error('Error cleaning up secrets:', fnError);
      // We log but continue, because we want to clear the local db records anyway
    }

    // 2. Delete connected account
    const { error } = await supabase
      .from('connected_accounts')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', 'google');

    if (error) {
      console.error('Error disconnecting Google:', error);
      throw error;
    }

    // 3. Delete emails
    const { error: emailsError } = await supabase
      .from('emails')
      .delete()
      .eq('user_id', user.id);

    if (emailsError) {
      console.error('Error deleting emails:', emailsError);
    }

    // 4. Delete calendar events
    const { error: eventsError } = await supabase
      .from('calendar_events')
      .delete()
      .eq('user_id', user.id);

    if (eventsError) {
      console.error('Error deleting calendar events:', eventsError);
    }

    await fetchAccounts();
  };

  const googleAccount = accounts.find((a) => a.provider === 'google');

  return {
    accounts,
    googleAccount,
    loading,
    connectGoogle,
    disconnectGoogle,
    refetch: fetchAccounts,
  };
}
