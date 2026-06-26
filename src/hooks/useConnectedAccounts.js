import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useConnectedAccounts() {
  const { user } = useAuth();
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

  const connectGoogle = async () => {
    if (!user) return;

    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) {
      console.error('Missing VITE_GOOGLE_CLIENT_ID');
      return;
    }

    const redirectUri = `${window.location.origin}/auth/google/callback`;
    const scope = encodeURIComponent('openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly');

    // Get cryptographically secure state from server
    const { data, error: fnError } = await supabase.functions.invoke('create-oauth-state', {
      body: { provider: 'google', redirect_uri: redirectUri },
    });

    if (fnError || !data?.state) {
      console.error('Failed to create OAuth state:', fnError);
      throw new Error('Failed to initiate Google connection');
    }

    const { state } = data;

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

  const connectSlack = async () => {
    if (!user) return;

    const clientId = import.meta.env.VITE_SLACK_CLIENT_ID;
    if (!clientId) {
      console.error('Missing VITE_SLACK_CLIENT_ID');
      throw new Error('Slack is not configured.');
    }

    const redirectUri = `${window.location.origin}/auth/slack/callback`;
    const userScope = encodeURIComponent('search:read');

    const { data, error: fnError } = await supabase.functions.invoke('create-oauth-state', {
      body: { provider: 'slack', redirect_uri: redirectUri },
    });

    if (fnError || !data?.state) {
      console.error('Failed to create OAuth state:', fnError);
      throw new Error('Failed to initiate Slack connection');
    }

    const { state } = data;

    const url =
      `https://slack.com/oauth/v2/authorize` +
      `?client_id=${clientId}` +
      `&user_scope=${userScope}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    window.location.href = url;
  };

  const disconnectSlack = async () => {
    if (!user) return;

    const { error: fnError } = await supabase.functions.invoke('google-oauth-disconnect', {
      body: { provider: 'slack' },
    });

    if (fnError) {
      console.error('Error cleaning up Slack secrets:', fnError);
    }

    const { error } = await supabase
      .from('connected_accounts')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', 'slack');

    if (error) {
      console.error('Error disconnecting Slack:', error);
      throw error;
    }

    const { error: msgError } = await supabase
      .from('slack_messages')
      .delete()
      .eq('user_id', user.id);

    if (msgError) {
      console.error('Error deleting Slack messages:', msgError);
    }

    await fetchAccounts();
  };

  const connectNotion = async () => {
    if (!user) return;

    const clientId = import.meta.env.VITE_NOTION_CLIENT_ID;
    if (!clientId) {
      console.error('Missing VITE_NOTION_CLIENT_ID');
      throw new Error('Notion is not configured.');
    }

    const redirectUri = `${window.location.origin}/auth/notion/callback`;

    const { data, error: fnError } = await supabase.functions.invoke('create-oauth-state', {
      body: { provider: 'notion', redirect_uri: redirectUri },
    });

    if (fnError || !data?.state) {
      console.error('Failed to create OAuth state:', fnError);
      throw new Error('Failed to initiate Notion connection');
    }

    const { state } = data;

    const url =
      `https://api.notion.com/v1/oauth/authorize` +
      `?client_id=${clientId}` +
      `&response_type=code` +
      `&owner=user` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;

    window.location.href = url;
  };

  const disconnectNotion = async () => {
    if (!user) return;

    const { error: fnError } = await supabase.functions.invoke('google-oauth-disconnect', {
      body: { provider: 'notion' },
    });

    if (fnError) {
      console.error('Error cleaning up Notion secrets:', fnError);
    }

    const { error } = await supabase
      .from('connected_accounts')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', 'notion');

    if (error) {
      console.error('Error disconnecting Notion:', error);
      throw error;
    }

    const { error: pageError } = await supabase
      .from('notion_pages')
      .delete()
      .eq('user_id', user.id);

    if (pageError) {
      console.error('Error deleting Notion pages:', pageError);
    }

    await fetchAccounts();
  };

  const googleAccount = accounts.find((a) => a.provider === 'google');
  const slackAccount = accounts.find((a) => a.provider === 'slack');
  const notionAccount = accounts.find((a) => a.provider === 'notion');

  return {
    accounts,
    googleAccount,
    slackAccount,
    notionAccount,
    loading,
    connectGoogle,
    disconnectGoogle,
    connectSlack,
    disconnectSlack,
    connectNotion,
    disconnectNotion,
    refetch: fetchAccounts,
  };
}
