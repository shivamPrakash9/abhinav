/**
 * Live-room join codes.
 *
 * The alphabet excludes characters that are easy to confuse when a code is read
 * aloud, printed on a slide, or typed from a screenshot:
 *   excluded letters: I, O
 *   excluded digits:  0, 1
 * That leaves 32 unambiguous symbols, so a 6-character code has 32^6 ≈ 1.07e9
 * combinations. The database CHECK constraint
 * `live_session_code_format` enforces this exact alphabet.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * Cryptographically random code without modulo bias.
 *
 * `random % 32` would be unbiased only if 256 were a multiple of 32 (it is, so
 * modulo would technically be fine here) — but the alphabet length is a
 * deliberate constant that may change, so rejection sampling keeps the function
 * correct for ANY alphabet length rather than relying on that coincidence.
 */
export function generateRoomCode(length: number = CODE_LENGTH): string {
  const alphabetLength = CODE_ALPHABET.length;
  // Largest multiple of alphabetLength that fits in a byte.
  const unbiasedLimit = Math.floor(256 / alphabetLength) * alphabetLength;
  const bytes = new Uint8Array(length * 2);
  let code = '';

  while (code.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= unbiasedLimit) continue; // reject to avoid modulo bias
      code += CODE_ALPHABET[byte % alphabetLength];
      if (code.length === length) break;
    }
  }

  return code;
}

/** Normalises user input: trims, upper-cases, strips spaces and dashes. */
export function normalizeRoomCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidRoomCode(input: string): boolean {
  return CODE_PATTERN.test(normalizeRoomCode(input));
}

/**
 * URL-safe slug from a title. Kept deliberately simple: ASCII-only so quiz links
 * are stable and shareable, with a random suffix added by `withSlugSuffix` when
 * the slug is already taken.
 */
export function slugify(input: string, maxLength = 60): string {
  const base = input
    .normalize('NFKD')
    // Strip diacritics so "Café Quiz" becomes "cafe-quiz".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  return base.length > 0 ? base : 'quiz';
}

/** Appends a short random suffix to resolve slug collisions (e.g. "-f3k9a2"). */
export function withSlugSuffix(slug: string, suffixLength = 6): string {
  const bytes = new Uint8Array(suffixLength);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join('')
    .toLowerCase();
  return `${slug}-${suffix}`;
}
