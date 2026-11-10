// Política da senha do acesso sem supervisão (usada pela interface e pelo processo principal).
// A senha é criada pela pessoa, vale só para um computador e nunca tem valor padrão.

const COMMON = new Set([
  '123456789012', '1234567890ab', 'senha1234567', 'senhasenha12', 'password1234', 'password123!',
  'qwertyuiop12', 'qwerty123456', 'abcdefghijkl', 'abc123abc123', 'iloveyou1234', 'admin1234567',
  'brasil123456', 'mudar1234567', 'trocar123456', 'ponte1234567',
]);

const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function hasObviousSequence(lower) {
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 6 <= seq.length; i++) {
      const part = seq.slice(i, i + 6);
      if (lower.includes(part) || lower.includes([...part].reverse().join(''))) return true;
    }
  }
  return false;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function checkPassword(password) {
  const problems = [];
  const pw = typeof password === 'string' ? password : '';
  const lower = pw.toLowerCase();
  if (pw.length < PASSWORD_MIN) problems.push(`Use pelo menos ${PASSWORD_MIN} caracteres.`);
  if (pw.length > PASSWORD_MAX) problems.push(`Use no máximo ${PASSWORD_MAX} caracteres.`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  // Frases longas (16+) são fortes mesmo com poucos tipos de caractere.
  if (pw.length >= PASSWORD_MIN && pw.length < 16 && classes < 3) {
    problems.push('Misture letras maiúsculas, minúsculas, números ou símbolos (ou use uma frase com 16+ caracteres).');
  }
  if (/^\d+$/.test(pw)) problems.push('Não use só números.');
  if (/(.)\1{3,}/.test(pw)) problems.push('Evite repetir o mesmo caractere várias vezes seguidas.');
  if (hasObviousSequence(lower)) problems.push('Evite sequências óbvias como 123456, abcdef ou qwerty.');
  if (COMMON.has(lower) || lower.includes('ponte')) problems.push('Essa senha é comum demais. Crie uma só para este computador.');
  return { ok: problems.length === 0, problems };
}
