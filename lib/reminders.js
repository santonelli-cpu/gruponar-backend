const db = require('../db');
const mailer = require('./email');

// Recordatorio automático de documentos pendientes: corre una vez al
// arrancar el servidor y luego cada 24h (ver server.js). Por cada parte con
// cuenta ligada y documentos pendientes, manda un correo si no se le mandó
// uno (manual o automático) en los últimos REMINDER_COOLDOWN_DAYS — para no
// bombardear a nadie por revisar el checklist más de una vez al día.
const REMINDER_COOLDOWN_DAYS = 7;

function pendingDocsForParty(partyId, side, dealId) {
  return side === 'seller'
    ? db.prepare("SELECT name FROM documents WHERE status = 'pending' AND deal_id = ? AND (deal_party_entity_id = ? OR deal_party_entity_id IS NULL)").all(dealId, partyId)
    : db.prepare("SELECT name FROM documents WHERE status = 'pending' AND deal_party_entity_id = ?").all(partyId);
}

async function runAutomaticReminders() {
  if (!mailer.isConfigured()) return;

  const linkedParties = db.prepare(`
    SELECT dpe.id AS partyId, dpe.side, dpe.deal_id AS dealId, d.property AS dealProperty, u.name AS userName, u.email AS userEmail
    FROM deal_party_entities dpe
    JOIN deal_parties dp ON dp.deal_party_entity_id = dpe.id
    JOIN users u ON u.id = dp.user_id
    JOIN deals d ON d.id = dpe.deal_id
  `).all();

  const lastSent = db.prepare('SELECT deal_party_entity_id AS partyId, last_sent_at AS lastSentAt FROM document_reminders_log').all();
  const lastSentByParty = {};
  lastSent.forEach(r => { lastSentByParty[r.partyId] = r.lastSentAt; });

  const cutoff = Date.now() - REMINDER_COOLDOWN_DAYS * 86400000;
  let sent = 0;

  for (const p of linkedParties) {
    const last = lastSentByParty[p.partyId];
    if (last && new Date(last + 'Z').getTime() > cutoff) continue;

    const pending = pendingDocsForParty(p.partyId, p.side, p.dealId);
    if (!pending.length) continue;

    const url = process.env.APP_URL || 'https://portal.gruponar.com/';
    const result = await mailer.sendDocumentReminderEmail({
      to: p.userEmail, name: p.userName, dealProperty: p.dealProperty, pendingDocNames: pending.map(d => d.name), url
    });
    if (result.ok) {
      db.prepare(`
        INSERT INTO document_reminders_log (deal_party_entity_id, last_sent_at) VALUES (?, datetime('now'))
        ON CONFLICT(deal_party_entity_id) DO UPDATE SET last_sent_at = datetime('now')
      `).run(p.partyId);
      sent++;
    }
  }
  if (sent) console.log(`[reminders] ${sent} recordatorio(s) automático(s) de documentos enviados`);
}

module.exports = { runAutomaticReminders, REMINDER_COOLDOWN_DAYS };
