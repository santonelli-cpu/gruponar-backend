const db = require('../db');
const { sendPredialReminderEmail } = require('./email');

// Mismo criterio que defaultKycLang en routes/kyc.js (duplicado a propósito,
// igual que DEFAULT_KYC_LANG_BY_SCENARIO_SIDE en public/index.html) — compra
// directa: comprador mexicano; fideicomiso: comprador extranjero; cesión:
// ambos extranjeros; extinción: comprador mexicano.
const DEFAULT_LANG_BY_SCENARIO_BUYER = {
  purchase: 'es', trust: 'en', transfer: 'en', trust_termination: 'es'
};

const SETTINGS_KEY = 'predial_reminder_last_sent_year';

function isFirstWeekOfJanuary(date) {
  return date.getMonth() === 0 && date.getDate() <= 7;
}

function getLastSentYear() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTINGS_KEY);
  return row ? Number(row.value) : null;
}

function setLastSentYear(year) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTINGS_KEY, String(year));
}

// Compradores de operaciones ya cerradas (status='completed') — ya son
// dueños, así que son quienes deben el predial. Un renglón por cada
// (comprador, operación): si compró más de una propiedad con nosotros, debe
// el predial de cada una por separado.
function getCompletedBuyers() {
  return db.prepare(`
    SELECT u.id AS userId, u.name, u.email, d.id AS dealId, d.property, d.scenario
    FROM deal_parties dp
    JOIN users u ON u.id = dp.user_id
    JOIN deals d ON d.id = dp.deal_id
    WHERE dp.role_in_deal = 'buyer' AND d.status = 'completed'
  `).all();
}

// Se llama al arrancar el servidor y luego cada tantas horas (ver server.js)
// en vez de depender de un cron externo — con esto basta porque solo manda
// una vez al año y es idempotente (setLastSentYear evita reenviar si el
// servidor se reinicia varias veces dentro de la misma primera semana de
// enero). Nunca lanza: un correo que falla no debe tumbar el proceso.
async function checkAndSendPredialReminders(now = new Date()) {
  if (!isFirstWeekOfJanuary(now)) return;
  const year = now.getFullYear();
  if (getLastSentYear() === year) return;

  const buyers = getCompletedBuyers();
  for (const b of buyers) {
    const lang = DEFAULT_LANG_BY_SCENARIO_BUYER[b.scenario] || 'es';
    try {
      const result = await sendPredialReminderEmail({ to: b.email, name: b.name, dealProperty: b.property, lang });
      if (!result.ok) console.error('[predial-reminder] no se pudo mandar a', b.email, 'deal', b.dealId, '-', result.error);
    } catch (err) {
      console.error('[predial-reminder] error inesperado mandando a', b.email, 'deal', b.dealId, '-', err.message);
    }
  }
  setLastSentYear(year);
  console.log(`[predial-reminder] recordatorio de predial ${year} enviado a ${buyers.length} comprador(es).`);
}

module.exports = { checkAndSendPredialReminders };
