import { useState } from 'react';
import { useRetrieval } from '../hooks/useRetrieval';
import { AppLayout } from '../components/AppLayout';
import { EmptyState } from '../components/EmptyState';

export default function Search() {
  const { retrieveContext, loading, results, error } = useRetrieval();
  const [query, setQuery] = useState('');

  const handleSearch = async (e) => {
    e?.preventDefault();
    if (!query.trim()) return;
    await retrieveContext(query.trim());
  };

  return (
    <AppLayout>
      <div className="container">
        <h1>Search</h1>
        <p className="muted">Retrieve relevant context from your connected data.</p>

        <form onSubmit={handleSearch} className="search-form">
          <div className="search-input-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What are you looking for?"
              disabled={loading}
              className="search-input"
            />
            <button type="submit" className="btn btn-primary" disabled={loading || !query.trim()}>
              {loading ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Searching…
                </>
              ) : (
                'Search'
              )}
            </button>
          </div>
        </form>

        {loading && (
          <section className="card" style={{ marginTop: 'var(--space-4)' }}>
            <div className="card-header">
              <h2>Results</h2>
            </div>
            <p className="muted">
              <span className="spinner" aria-hidden="true" /> Retrieving context…
            </p>
          </section>
        )}

        {error && (
          <div className="inline-error" role="alert" style={{ marginTop: 'var(--space-4)' }}>
            {error}
          </div>
        )}

        {!loading && !error && results && (
          <>
            {results.parsed && (
              <section className="card" style={{ marginTop: 'var(--space-4)' }}>
                <div className="card-header">
                  <h2>Query Analysis</h2>
                </div>
                <dl className="kv">
                  <dt>Intent</dt>
                  <dd>{results.parsed.intent || 'N/A'}</dd>
                  {results.parsed.entities?.length > 0 && (
                    <>
                      <dt>Entities</dt>
                      <dd>{results.parsed.entities.join(', ')}</dd>
                    </>
                  )}
                </dl>
              </section>
            )}

            <section className="card">
              <div className="card-header">
                <h2>Context</h2>
                <span className="badge badge-accent">
                  {results.metadata?.included || 0} items
                </span>
              </div>
              {results.context?.length > 0 ? (
                <ul className="list">
                  {results.context.map((item) => (
                    <li key={item.id} className="list-item">
                      <div className="row-between">
                        <p><strong>{item.text}</strong></p>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <span className={`badge ${item.source === 'memory' ? 'badge-accent' : item.source === 'email' ? 'badge' : 'badge-muted'}`}>
                            {item.source}
                          </span>
                          <span className="badge badge-muted">
                            {(item.score * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon="🔍"
                  title="No relevant context found"
                  description="Try a different search term."
                />
              )}
            </section>

            <section className="card">
              <div className="card-header">
                <h2>Metadata</h2>
              </div>
              <dl className="kv">
                <dt>Total Retrieved</dt>
                <dd>{results.metadata?.total_retrieved ?? 'N/A'}</dd>
                <dt>Above Threshold</dt>
                <dd>{results.metadata?.above_threshold ?? 'N/A'}</dd>
                <dt>Included</dt>
                <dd>{results.metadata?.included ?? 'N/A'}</dd>
                <dt>Estimated Words</dt>
                <dd>{results.metadata?.estimated_words ?? 'N/A'}</dd>
                {results.metadata?.source_counts && (
                  <>
                    <dt>Source Counts</dt>
                    <dd>
                      {Object.entries(results.metadata.source_counts)
                        .map(([source, count]) => `${source}: ${count}`)
                        .join(', ')}
                    </dd>
                  </>
                )}
                <dt>Latency</dt>
                <dd>{results.latencyMs != null ? `${results.latencyMs}ms` : 'N/A'}</dd>
                <dt>Embedding Available</dt>
                <dd>{results.metadata?.embeddingAvailable != null ? (results.metadata.embeddingAvailable ? 'Yes' : 'No') : 'N/A'}</dd>
              </dl>
            </section>
          </>
        )}

        {!loading && !error && !results && (
          <section className="card" style={{ marginTop: 'var(--space-4)' }}>
            <EmptyState
              icon="🔎"
              title="Search your data"
              description="Enter a query above to retrieve relevant memories, emails, and calendar events."
            />
          </section>
        )}
      </div>
    </AppLayout>
  );
}
