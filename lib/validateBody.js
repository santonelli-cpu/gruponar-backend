const { z } = require('zod');

// Valida y sanea req.body contra un schema de zod antes de que la ruta
// corra. Cada schema debe declararse con .strict() (o construirse con
// strictObject) para que un campo que el frontend NO manda a propósito
// tumbe la request con un 400 claro, en vez de guardarse en silencio o
// colarse hasta una query — esto es aparte de las reglas de negocio de
// cada endpoint (existe la operación, ya está ligada, etc.), que se quedan
// donde ya estaban.
//
// Si pasa, reemplaza req.body por el resultado ya parseado (con defaults
// aplicados, strings recortados vía .trim() donde el schema lo pida, etc.)
// — las rutas ya no necesitan repetir esas revisiones a mano.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue.code === 'unrecognized_keys'
        ? issue.keys.join(', ')
        : (issue.path.length ? issue.path.join('.') : 'body');
      return res.status(400).json({ error: `Dato inválido (${field}): ${issue.message}` });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateBody, z };
