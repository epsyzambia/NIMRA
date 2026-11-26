// Small helpers shared by the Worker: responses, errors, password hashing, sessions.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (m) => new HttpError(400, m);
export const forbidden = (m = 'You are not allowed to do that.') => new HttpError(403, m);
export const notFound = (m = 'Not found.') => new HttpError(404, m);

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomHex = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// PBKDF2 at 100,000 rounds: the most the Workers runtime allows.
export async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) throw bad('Enter a valid phone number.');
  // Zambia: 0971234567 and 260971234567 are the same person
  if (digits.startsWith('260')) return digits;
  if (digits.startsWith('0')) return '260' + digits.slice(1);
  return digits;
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function num(v, label, { min = 0, allowZero = true } = {}) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw bad(`${label} must be a number.`);
  if (n < min || (!allowZero && n === 0)) throw bad(`${label} must be ${allowZero ? 'zero or more' : 'above zero'}.`);
  return n;
}

export function text(v, label, { max = 300, required = true } = {}) {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} is too long (most ${max} characters).`);
  return s || null;
}
