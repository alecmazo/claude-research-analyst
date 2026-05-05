/**
 * Date / number formatters used across screens.
 *
 * Keep these pure — no React, no side effects — so they can be imported
 * anywhere without dragging dependencies along.
 */

/**
 * Format an ISO timestamp as "May 4, 2026, 3:42 PM".
 * Falls back to the raw string if the date can't be parsed.
 */
export function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

/**
 * Compact date like "May 4" — drops the year when it matches the current year.
 * Used for dense list rows where every glyph counts.
 */
export function formatDateCompact(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    const yr = dt.getFullYear();
    const nowY = new Date().getFullYear();
    return dt.toLocaleDateString('en-US',
      yr === nowY
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: '2-digit' });
  } catch { return iso; }
}

/** "12:42 PM" — clock-only, used for "Updated …" stamps. */
export function formatTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  try {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

/** "3h ago", "12m ago", "2d ago" — coarse relative time. */
export function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Format a percent like "+2.34%" or "-1.05%". Returns empty string on null.
 */
export function formatPct(pct) {
  if (pct == null) return '';
  const n = Number(pct);
  if (Number.isNaN(n)) return '';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * Format a currency price like "$1,234.56". Returns null on null input
 * so callers can render a placeholder.
 */
export function formatPrice(price) {
  if (price == null) return null;
  const n = Number(price);
  if (Number.isNaN(n)) return null;
  return `$${n.toFixed(2)}`;
}
