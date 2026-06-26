import { useBriefings } from '../hooks/useBriefings';
import { AppLayout } from '../components/AppLayout';
import { SkeletonList } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';

export default function Briefings() {
  const { briefings, latestBriefing, loading, generating, error, generateBriefing } = useBriefings();

  return (
    <AppLayout>
      <div className="container">
        <div className="row-between align-center">
          <div>
            <h1>Briefings</h1>
            <p className="muted">Daily summaries of your most important updates.</p>
          </div>
          <button 
            className="btn btn-primary" 
            onClick={generateBriefing} 
            disabled={generating}
          >
            {generating ? 'Generating...' : 'Generate Briefing'}
          </button>
        </div>
        {error && (
          <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginBottom: 'var(--space-4)' }}>
            Error: {error}
          </div>
        )}

        {latestBriefing && (
          <section className="card" style={{ borderColor: 'var(--accent)' }}>
            <div className="card-header">
              <h2>Latest briefing</h2>
              <span className="badge badge-success">
                {new Date(latestBriefing.generated_at).toLocaleDateString()}
              </span>
            </div>
            <div className="briefing-content">
              {latestBriefing.content}
            </div>
            <div className="text-xs muted" style={{ marginTop: 'var(--space-2)' }}>
              Generated: {new Date(latestBriefing.generated_at).toLocaleString()}
              {latestBriefing.email_count_used > 0 && ` · ${latestBriefing.email_count_used} emails`}
              {latestBriefing.event_count_used > 0 && ` · ${latestBriefing.event_count_used} events`}
              {latestBriefing.generator_provider && ` · Model: ${latestBriefing.generator_provider}`}
            </div>
          </section>
        )}

        <section className="card">
          <div className="card-header">
            <h2>All briefings</h2>
          </div>
          {loading ? (
            <SkeletonList items={3} />
          ) : briefings.length > 0 ? (
            <ul className="list">
              {briefings.map((b) => (
                <li key={b.id} className="list-item">
                  <div className="row-between">
                    <p><strong>{new Date(b.generated_at).toLocaleDateString()}</strong></p>
                    <span className="badge badge-accent">
                      {new Date(b.generated_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm muted" style={{ margin: 'var(--space-1) 0' }}>
                    {b.content?.split('\n')[0] || '(No content)'}
                  </p>
                  <div className="text-xs muted">
                    {b.email_count_used > 0 && `${b.email_count_used} emails`}
                    {b.email_count_used > 0 && b.event_count_used > 0 && ' · '}
                    {b.event_count_used > 0 && `${b.event_count_used} events`}
                    {b.generator_provider && ` · ${b.generator_provider}`}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon="📋"
              title="No briefings yet"
              description="Briefings are generated daily. Sync your data to get started."
            />
          )}
        </section>
      </div>
    </AppLayout>
  );
}
