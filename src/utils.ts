export function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function formatAge(ageMs: number): string {
  const min = Math.floor(ageMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
