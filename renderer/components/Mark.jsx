// The Orin mark: a double ring. The outer ring is heavy and the inner ring is light, like the app icon.
export function Mark({ size = 20, className = '', live = false }) {
  return (
    <svg className={`mark ${live ? 'live' : ''} ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle className="mark-inner" cx="12" cy="12" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Streaming indicator: the inner ring opens into an arc that orbits inside the outer ring.
export function Working({ label = 'Working' }) {
  return <span className="working"><span className="working-mark"><Mark size={15} live /></span>{label}</span>;
}
