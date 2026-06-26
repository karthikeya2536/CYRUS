import { useMemo, useState } from 'react';
import { useMemory } from '../hooks/useMemory';
import { AppLayout } from '../components/AppLayout';
import { SkeletonList } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

export default function Memories() {
  const { memories, loading, metrics } = useMemory();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return memories;
    const lower = search.toLowerCase();
    return memories.filter(m =>
      m.content?.toLowerCase().includes(lower) ||
      m.category?.toLowerCase().includes(lower)
    );
  }, [memories, search]);

  return (
    <AppLayout>
      <div className="container">
        <div className="row-between" style={{ marginBottom: 'var(--space-5)' }}>
          <div>
            <h1>Memories</h1>
            <p className="muted" style={{ margin: 0 }}>
              Extracted knowledge from your connected data sources.
            </p>
          </div>
        </div>

        <div className="stat-grid" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="stat-card">
            <span className="stat-label">Total</span>
            <span className="stat-value">{metrics.total}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Active</span>
            <span className="stat-value">{metrics.active}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">High Confidence</span>
            <span className="stat-value">{metrics.highConfidence}</span>
          </div>
        </div>

        <div className="field" style={{ maxWidth: 400, marginBottom: 'var(--space-4)' }}>
          <input
            type="text"
            placeholder="Search memories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <section className="card">
          {loading ? (
            <SkeletonList items={5} />
          ) : filtered.length > 0 ? (
            <ul className="list">
              {filtered.map((m) => (
                <li key={m.id} className="list-item">
                  <div className="row-between">
                    <p><strong>{m.content}</strong></p>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      {m.category && <span className="badge badge-accent">{m.category}</span>}
                      <span className="badge badge-muted">{(m.confidence_score * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                  {m.source_excerpt && (
                    <p className="text-sm muted" style={{ margin: 'var(--space-1) 0' }}>
                      {m.source_excerpt}
                    </p>
                  )}
                  <div className="text-xs muted" style={{ marginTop: 'var(--space-1)' }}>
                    {m.created_at && <span>Created: {new Date(m.created_at).toLocaleString()}</span>}
                    {m.last_seen_at && <span> · Last seen: {new Date(m.last_seen_at).toLocaleString()}</span>}
                    {m.source_type && <span> · Source: {m.source_type}</span>}
                    {m.occurrence_count > 1 && <span> · Seen {m.occurrence_count} times</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : search ? (
            <EmptyState
              icon="🔍"
              title="No matching memories"
              description="Try a different search term."
            />
          ) : (
            <EmptyState
              icon="🧠"
              title="No memories yet"
              description="Memories are extracted automatically when you sync your data."
            />
          )}
        </section>
      </div>
    </AppLayout>
  );
}
