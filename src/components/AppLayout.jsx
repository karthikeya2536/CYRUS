import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/search', label: 'Search' },
  { to: '/memories', label: 'Memories' },
  { to: '/briefings', label: 'Briefings' },
  { to: '/notifications', label: 'Notifications' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/billing', label: 'Billing' },
  { to: '/account', label: 'Account' },
  { to: '/profile', label: 'Profile' },
];

export function AppLayout({ children }) {
  const { logout } = useAuth();
  const { resolved, toggle } = useTheme();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <NavLink to="/dashboard" className="brand">
            <span className="brand-mark" aria-hidden="true">
              C
            </span>
            <span>Cyrus</span>
          </NavLink>

          <nav className="nav" aria-label="Primary">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="nav">
            <button
              type="button"
              className="icon-btn"
              onClick={toggle}
              aria-label={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={resolved === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {resolved === 'dark' ? '☀' : '☾'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={logout}>
              Log out
            </button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
