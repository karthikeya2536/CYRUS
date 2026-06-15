import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

// Reads the user's current subscription. A missing row means the free plan,
// matching the server-side default in _shared/plans.ts.
export function useSubscription() {
  const { user } = useAuth();
  const [plan, setPlan] = useState('free');
  const [status, setStatus] = useState('active');
  const [loading, setLoading] = useState(true);

  const fetchSubscription = useCallback(async () => {
    if (!user) {
      setPlan('free');
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan, status')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!error && data && data.status === 'active') {
      setPlan(data.plan || 'free');
      setStatus(data.status);
    } else {
      setPlan('free');
      setStatus(data?.status || 'active');
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  return { plan, status, loading, refetch: fetchSubscription };
}
