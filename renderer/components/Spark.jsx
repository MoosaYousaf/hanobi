// The Hanobi mark: a firework burst. Twelve rays alternate long and short around a core.
const rays = Array.from({ length: 12 }, (_, i) => {
  const angle = (i * Math.PI) / 6;
  const [inner, outer] = i % 2 ? [5.2, 8.6] : [4.2, 11];
  const r = v => Math.round(v * 100) / 100;
  return `M${r(12 + Math.cos(angle) * inner)} ${r(12 + Math.sin(angle) * inner)}L${r(12 + Math.cos(angle) * outer)} ${r(12 + Math.sin(angle) * outer)}`;
}).join('');

export function Spark({ size = 20, className = '' }) {
  return (
    <svg className={`spark ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={rays} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" fill="none" />
      <circle cx="12" cy="12" r="1.9" fill="currentColor" />
    </svg>
  );
}

// Streaming indicator: the mark, animated on a wrapper so the SVG itself is not re-laid out.
export function Working({ label = 'Working' }) {
  return <span className="working"><span className="working-spark"><Spark size={15} /></span>{label}</span>;
}
