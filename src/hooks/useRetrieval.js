import { useState } from 'react';
import { supabase } from '../lib/supabase';

export function useRetrieval() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const retrieveContext = async (query) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('retrieve-context', {
        body: { query }
      });

      if (fnError) {
        throw new Error(fnError.message || 'Failed to retrieve context');
      }

      setResults(data);
      return data;
    } catch (err) {
      console.error(err);
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  return { retrieveContext, loading, results, error };
}
