import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useEmails() {
  const { user } = useAuth();
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  const fetchEmails = useCallback(async () => {
    if (!user) {
      setEmails([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('emails')
      .select('*')
      .eq('user_id', user.id)
      .order('received_at', { ascending: false });

    if (!error && data) {
      setEmails(data);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  const syncGmail = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('gmail-sync');
      
      if (fnError) {
        setSyncError(`Sync failed: ${fnError.message}`);
      } else if (data?.error) {
        setSyncError(`Sync failed: ${data.error}`);
      } else {
        await fetchEmails();
      }
    } catch (err) {
      setSyncError(`Unexpected error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return {
    emails,
    loading,
    syncing,
    syncError,
    syncGmail,
    refetch: fetchEmails,
  };
}
