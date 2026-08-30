export const DIFFICULTY_CLASS = { Easy: 'chip-easy', Medium: 'chip-medium', Hard: 'chip-hard' };
export const STATUS_CLASS = { open: 'chip-easy', upcoming: 'chip-medium', closed: 'chip-hard' };

// timeZoneName is spelled out (not just dateStyle/timeStyle) so a browser
// whose effective timezone silently isn't the viewer's own (a stale
// DevTools Sensors override, a misconfigured OS) shows up as visibly wrong
// ("... UTC") instead of a quietly-mis-converted number that looks plausible.
export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// Turns accumulated time-on-task seconds into a compact "2h 14m" / "45m" /
// "30s" string for the students table.
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

export function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SCAN_STATUS_LABELS = { pending: 'Pending', processing: 'Processing', ocr_done: 'Complete', ocr_failed: 'Failed' };
export function formatScanStatus(status) {
  return SCAN_STATUS_LABELS[status] || status;
}
