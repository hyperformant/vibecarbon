/**
 * Escape text for HTML: safe inside an element and inside a quoted attribute
 * value (& < > " and ' all become entities). The server's one HTML escaper,
 * used by the SEO shell injection, the email templates and the contact form
 * notification.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
