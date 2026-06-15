import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { AppLayout } from '../components/AppLayout';
import { useSubscription } from '../hooks/useSubscription';
import { useToast } from '../hooks/useToast';
import { PLANS } from '../lib/plans';

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function Account() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { plan, refetch } = useSubscription();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  useEffect(() => {
    const checkout = params.get('checkout');
    if (checkout === 'success') {
      toast.success('Payment received. Your plan will update shortly.');
      refetch();
      navigate('/account', { replace: true });
    } else if (checkout === 'cancel') {
      toast.info('Checkout canceled.');
      navigate('/account', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const planMeta = PLANS[plan] || PLANS.free;

  return (
    <AppLayout>
      <div className="container">
        <h1>Account settings</h1>
        <p className="muted">Manage your account and appearance preferences.</p>

        <section className="card">
          <div className="card-header">
            <h2>Account</h2>
          </div>
          <dl className="kv">
            <dt>Email</dt>
            <dd>{user?.email || '—'}</dd>
            <dt>User ID</dt>
            <dd className="text-sm muted">{user?.id || '—'}</dd>
          </dl>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Plan</h2>
            <span className="badge badge-success">{planMeta.name}</span>
          </div>
          <p className="text-sm muted">
            You are on the {planMeta.name} plan. Manage or upgrade on the billing page.
          </p>
          <Link to="/billing" className="btn btn-primary btn-sm">
            View plans
          </Link>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Appearance</h2>
          </div>
          <div className="field" style={{ maxWidth: 280 }}>
            <label className="label" htmlFor="theme-select">
              Theme
            </label>
            <select
              id="theme-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              {THEME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="text-xs muted">
              &quot;System&quot; follows your operating system setting.
            </span>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Session</h2>
          </div>
          <p className="text-sm muted">Sign out of your account on this device.</p>
          <button onClick={logout} className="btn btn-danger">
            Log out
          </button>
        </section>
      </div>
    </AppLayout>
  );
}
