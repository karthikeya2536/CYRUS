import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';
import { AppLayout } from '../components/AppLayout';
import { SkeletonText } from '../components/Skeleton';
import { useToast } from '../hooks/useToast';

export default function Profile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    async function load() {
      if (!user) return;
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();
      if (active) {
        setProfile(data || null);
        setFullName(data?.full_name || '');
        setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [user]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    const previous = profile?.full_name || '';
    // Optimistic update of local view.
    setProfile((p) => ({ ...(p || { id: user.id }), full_name: fullName }));
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', user.id);
    if (error) {
      setProfile((p) => ({ ...(p || {}), full_name: previous }));
      setFullName(previous);
      toast.error(error.message || 'Failed to save profile.');
    } else {
      toast.success('Profile updated.');
    }
    setSaving(false);
  };

  return (
    <AppLayout>
      <div className="container">
        <h1>Profile</h1>
        <p className="muted">Manage how your name appears across Cyrus.</p>

        <section className="card">
          <div className="card-header">
            <h2>Personal information</h2>
          </div>
          {loading ? (
            <SkeletonText lines={3} />
          ) : (
            <form onSubmit={handleSave} className="stack">
              <div className="field">
                <label className="label" htmlFor="profile-email">
                  Email
                </label>
                <input id="profile-email" type="email" value={user?.email || ''} disabled />
                <span className="text-xs muted">Email is managed by your account and cannot be changed here.</span>
              </div>
              <div className="field">
                <label className="label" htmlFor="profile-name">
                  Full name
                </label>
                <input
                  id="profile-name"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your name"
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Saving…
                    </>
                  ) : (
                    'Save changes'
                  )}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </AppLayout>
  );
}
