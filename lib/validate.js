// Validación compartida de entradas de usuario — nada exhaustivo (no hay
// verificación de que el correo exista de verdad, por ejemplo), solo
// rechazar formatos obviamente inválidos antes de guardarlos o de intentar
// mandarles algo (Resend/DocuSign ya rechazan un correo mal formado, pero
// mejor no llegar hasta ahí y no guardar basura en la base de datos).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.trim().length <= 254 && EMAIL_RE.test(email.trim());
}

module.exports = { isValidEmail };
