const db = require('../db');

// Registro de actividad por operación (tabla deal_activity, ver
// db/schema.sql) — una línea por acción relevante, para la línea de tiempo
// del detalle de la operación. Nunca lanza: un fallo al registrar actividad
// no debe tumbar la acción real que se está registrando.
//
// `action` es una clave corta estable (el frontend la traduce y le pone
// icono); `detail` es texto libre ya legible (nombre del documento, de la
// persona, del paso...) que se muestra tal cual.
function logActivity(dealId, userId, action, detail) {
  try {
    db.prepare('INSERT INTO deal_activity (deal_id, user_id, action, detail) VALUES (?,?,?,?)')
      .run(dealId, userId || null, action, detail || null);
  } catch (err) {
    console.error('[activity] no se pudo registrar', dealId, action, err.message);
  }
}

module.exports = { logActivity };
