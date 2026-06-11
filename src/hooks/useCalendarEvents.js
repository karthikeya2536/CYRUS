import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useCalendarEvents() {
  const { user } = useAuth();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  const fetchEvents = useCallback(async () => {
    if (!user) {
      setEvents([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('calendar_events')
      .select('*')
      .eq('user_id', user.id)
      .order('start_time', { ascending: true });

    if (!error && data) {
      setEvents(data);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const syncCalendar = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('calendar-sync');
      
      if (fnError) {
        setSyncError(`Sync failed: ${fnError.message}`);
      } else if (data?.error) {
        setSyncError(`Sync failed: ${data.error}`);
      } else {
        await fetchEvents();
      }
    } catch (err) {
      setSyncError(`Unexpected error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return {
    events,
    loading,
    syncing,
    syncError,
    syncCalendar,
    refetch: fetchEvents,
  };
}
