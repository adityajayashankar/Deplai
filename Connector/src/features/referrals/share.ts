export function whatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export function smsShareUrl(message: string): string {
  return `sms:?&body=${encodeURIComponent(message)}`;
}

export function emailShareUrl(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function telegramShareUrl(message: string): string {
  return `https://t.me/share/url?text=${encodeURIComponent(message)}`;
}

export function openShareUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
