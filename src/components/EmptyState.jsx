export function EmptyState({ icon = '◦', title, description, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      {title && <h3>{title}</h3>}
      {description && <p className="muted">{description}</p>}
      {action}
    </div>
  );
}
