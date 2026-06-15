export function SkeletonText({ lines = 3 }) {
  const widths = ['long', 'medium', 'short'];
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className={`skeleton skeleton-line ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

export function SkeletonList({ items = 3 }) {
  return (
    <ul className="list" aria-hidden="true">
      {Array.from({ length: items }).map((_, i) => (
        <li key={i} className="list-item">
          <span className="skeleton skeleton-line short" />
          <span className="skeleton skeleton-line long" />
          <span className="skeleton skeleton-line medium" />
        </li>
      ))}
    </ul>
  );
}
