import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

export function useBriefings() {
  const { user } = useAuth();
  const [briefings, setBriefings] = useState([]);
  const [latestBriefing, setLatestBriefing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  const fetchBriefings = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('briefings')
      .select('*')
      .eq('user_id', user.id)
      .order('generated_at', { ascending: false });

    if (fetchError) {
      console.error('Error fetching briefings:', fetchError);
      setError(fetchError.message);
    } else {
      setBriefings(data || []);
      if (data && data.length > 0) {
        setLatestBriefing(data[0]);
      } else {
        setLatestBriefing(null);
      }
    }
    setLoading(false);
  };

  const generateBriefing = async () => {
    if (!user) return;
    setGenerating(true);
    setError(null);

    const { data, error: fnError } = await supabase.functions.invoke('generate-briefing', {
      body: {}
    });

    if (fnError || data?.error) {
      console.error('Error queueing briefing:', fnError || data.error);
      setError(fnError?.message || data?.error || 'Failed to queue briefing');
      setGenerating(false);
      return;
    }

    const jobId = data.job_id;
    const channel = supabase.channel(`job_${jobId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'llm_jobs',
        filter: `id=eq.${jobId}`
      }, (payload) => {
        const status = payload.new.status;
        if (status === 'completed') {
          fetchBriefings();
          setGenerating(false);
          supabase.removeChannel(channel);
        } else if (status === 'permanently_failed') {
          setError(payload.new.last_error || 'Briefing generation permanently failed');
          setGenerating(false);
          supabase.removeChannel(channel);
        }
      })
      .subscribe();
  };

  useEffect(() => {
    fetchBriefings();
  }, [user]);

  return {
    briefings,
    latestBriefing,
    loading,
    generating,
    error,
    generateBriefing,
    fetchBriefings
  };
}
