import { useState } from 'react';
import { AppLayout } from '../components/AppLayout';
import { SkeletonList } from '../components/Skeleton';
import { useToast } from '../hooks/useToast';
import { useSubscription } from '../hooks/useSubscription';
import { PLANS, PLAN_ORDER } from '../lib/plans';
import { supabase } from '../lib/supabase';

export default function Billing() {
  const { plan: currentPlan, loading } = useSubscription();
  const toast = useToast();
  const [busyPlan, setBusyPlan] = useState(null);

  const rank = (p) => PLAN_ORDER.indexOf(p);

  const handleSelect = async (planId) => {
    if (planId === 'free') return;
    if (planId === 'enterprise') {
      window.location.assign('mailto:sales@cyrus.app?subject=Enterprise%20plan');
      return;
    }

    setBusyPlan(planId);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { plan: planId, return_url: window.location.origin },
      });
      if (error || !data?.url) {
        const msg = data?.error || error?.message || 'Could not start checkout.';
        throw new Error(msg);
      }
      window.location.assign(data.url);
    } catch (err) {
      toast.error(err?.message || 'Could not start checkout.');
      setBusyPlan(null);
    }
  };

  return (
    <AppLayout>
      <div className="container">
        <h1>Billing &amp; Plans</h1>
        <p className="muted">Choose the plan that fits how you work. Upgrade or downgrade anytime.</p>

        {loading ? (
          <SkeletonList items={2} />
        ) : (
          <div className="plan-grid">
            {PLAN_ORDER.map((id) => {
              const p = PLANS[id];
              const isCurrent = id === currentPlan;
              const isDowngrade = rank(id) < rank(currentPlan);
              return (
                <section className={`card plan-card${isCurrent ? ' plan-card-current' : ''}`} key={id}>
                  <div className="plan-card-head">
                    <h2>{p.name}</h2>
                    {isCurrent && <span className="badge badge-success">Current</span>}
                  </div>
                  <div className="plan-price">
                    <span className="plan-price-amount">{p.price}</span>
                    <span className="text-sm muted"> {p.cadence}</span>
                  </div>
                  <p className="text-sm muted">{p.tagline}</p>
                  <ul className="plan-features">
                    {p.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <button
                    className={`btn btn-block ${isCurrent ? 'btn-secondary' : 'btn-primary'}`}
                    disabled={isCurrent || isDowngrade || busyPlan === id}
                    aria-disabled={isCurrent || isDowngrade || busyPlan === id}
                    onClick={() => handleSelect(id)}
                  >
                    {busyPlan === id ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Redirecting…
                      </>
                    ) : isCurrent ? (
                      'Current plan'
                    ) : isDowngrade ? (
                      'Included below your plan'
                    ) : id === 'enterprise' ? (
                      'Contact sales'
                    ) : id === 'free' ? (
                      'Free'
                    ) : (
                      `Upgrade to ${p.name}`
                    )}
                  </button>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
