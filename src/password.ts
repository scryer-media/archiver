// Omit ambiguous letters and digits in both cases.
export const PASSWORD_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYacdefghjkmnpqrtuvwxy34679';
export const PASSWORD_LENGTH = 24;
export function generatePassword(random: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  const limit = 256 - 256 % PASSWORD_ALPHABET.length;
  const bytes = new Uint8Array(64);
  let password = '';
  while (password.length < PASSWORD_LENGTH) {
    random.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === PASSWORD_LENGTH) break;
    }
  }
  return password;
}
