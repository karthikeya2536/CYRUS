// Plan catalog for the billing UI. Entitlements are enforced server-side in
// supabase/functions/_shared/plans.ts — this file is for display only.

export const PLAN_ORDER = ['free', 'pro', 'business', 'enterprise'];

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    tagline: 'For individuals exploring Cyrus.',
    features: [
      'Gmail & Google Calendar',
      'Basic memory extraction',
      '1 briefing per day',
      '20 AI queries per day',
      'Up to 500 memories',
      'Standard retrieval',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: '$20',
    cadence: 'per month',
    tagline: 'For power users and professionals.',
    features: [
      'Everything in Free',
      'Unlimited AI queries',
      'Unlimited briefings',
      'Slack integration',
      'Extended memory (5,000)',
      'Priority processing',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    price: '$50',
    cadence: 'per month',
    tagline: 'For teams and organizations.',
    features: [
      'Everything in Pro',
      'Notion & Linear integrations',
      'Team briefings',
      'Extended memory (50,000)',
      'Role-based access',
      'Priority support',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'contact us',
    tagline: 'For large organizations.',
    features: [
      'Everything in Business',
      'Unlimited memory',
      'SSO & enterprise auth',
      'Audit logs & compliance',
      'Custom integrations',
      'Dedicated support',
    ],
  },
};
