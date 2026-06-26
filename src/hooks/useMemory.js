import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './useAuth';

export function useMemory() {
  const { user } = useAuth();
  const [memories, setMemories] = useState([]);
  const [filteredMemories, setFilteredMemories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [metrics, setMetrics] = useState({
    total: 0,
    active: 0,
    highConfidence: 0,
    topProjects: [],
    topPeople: []
  });

  const fetchMemories = async () => {
    if (!user) return;
    setLoading(true);
    // Show only live memories: active, and not past their expiry. This mirrors
    // what retrieval/briefings now honor (migration 031), so the UI cannot imply
    // deactivated or expired "garbage" memories still exist.
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('memory_records')
      .select('*')
      .eq('user_id', user.id)
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('confidence_score', { ascending: false })
      .order('occurrence_count', { ascending: false });

    if (!error && data) {
      setMemories(data);
      setFilteredMemories(data);
      calculateMetrics(data);
    }
    setLoading(false);
  };

  const calculateMetrics = (data) => {
    const total = data.length;
    const active = data.filter(m => m.active).length;
    const highConfidence = data.filter(m => m.confidence_score >= 80).length;

    const projectCounts = {};
    const peopleCounts = {};

    data.filter(m => m.active).forEach(m => {
      if (m.category === 'project') {
         projectCounts[m.content] = (projectCounts[m.content] || 0) + m.occurrence_count;
      } else if (m.category === 'person') {
         peopleCounts[m.content] = (peopleCounts[m.content] || 0) + m.occurrence_count;
      }
    });

    const topProjects = Object.entries(projectCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    const topPeople = Object.entries(peopleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    setMetrics({ total, active, highConfidence, topProjects, topPeople });
  };

  useEffect(() => {
    fetchMemories();
  }, [user]);

  const searchMemories = (query) => {
    if (!query) {
      setFilteredMemories(memories);
    } else {
      const lower = query.toLowerCase();
      setFilteredMemories(memories.filter(m => 
        m.content.toLowerCase().includes(lower) || 
        m.category.toLowerCase().includes(lower)
      ));
    }
  };

  const updateMemory = async (id, content) => {
    const { error } = await supabase
      .from('memory_records')
      .update({ content })
      .eq('id', id);
    if (!error) {
      fetchMemories();
    }
  };

  const deactivateMemory = async (id) => {
    const { error } = await supabase
      .from('memory_records')
      .update({ active: false })
      .eq('id', id);
    if (!error) {
      fetchMemories();
    }
  };

  const deleteMemory = async (id) => {
    const { error } = await supabase
      .from('memory_records')
      .delete()
      .eq('id', id);
    if (!error) {
      fetchMemories();
    }
  };

  const triggerExtraction = async () => {
    setExtracting(true);
    try {
      const { data, error } = await supabase.functions.invoke('memory-extraction', { body: {} });
      if (error || data?.error) {
        console.error("Extraction queue error", error || data.error);
        setExtracting(false);
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
            fetchMemories();
            setExtracting(false);
            supabase.removeChannel(channel);
          } else if (status === 'permanently_failed') {
            console.error('Extraction job failed:', payload.new.last_error);
            setExtracting(false);
            supabase.removeChannel(channel);
          }
        })
        .subscribe();
    } catch (err) {
      console.error("Extraction error", err);
      setExtracting(false);
    }
  };

  return {
    memories: filteredMemories,
    allMemories: memories,
    metrics,
    loading,
    extracting,
    searchMemories,
    updateMemory,
    deactivateMemory,
    deleteMemory,
    triggerExtraction,
    refetch: fetchMemories
  };
}
