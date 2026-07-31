const db = require('../db');
const mailer = require('./email');

// Recordatorios internos de fechas límite — corre una vez al día (ver
// server.js). Para cada operación activa con fecha de cierre o fin de due
// diligence capturada, avisa al equipo cuando faltan 7 días y otra vez
// cuando faltan 2. El registro en deadline_reminders_log (una fila por
// operación+tipo+fecha objetivo) garantiza que cada aviso salga UNA vez,
// sin importar reinicios ni cuántas veces corra el chequeo.
//
// Va solo al equipo (admins + abogados ligados a la operación o su
// creador) — el resumen para clientes es aparte y manual
// (send-progress-summary), aquí el punto es que a quien coordina no se le
// pase una fecha.
const THRESHOLDS_DAYS = [7, 2];
const KINDS = [
  { column: 'closing_date', kind: 'closing', label: 'fecha de cierre' },
  { column: 'due_diligence_end_date', kind: 'due_diligence', label: 'fin de due diligence' }
];

function recipientsForDeal(deal) {
  const admins = db.prepare("SELECT id, name, email FROM users WHERE role = 'admin' AND status = 'active'").all();
  const lawyers = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.email FROM users u
    WHERE u.role = 'lawyer' AND u.status = 'active' AND (
      u.id = ? OR u.id IN (SELECT user_id FROM deal_parties WHERE deal_id = ?)
    )
  `).all(deal.created_by || 0, deal.id);
  const seen = new Set();
  return [...admins, ...lawyers].filter(u => !seen.has(u.id) && seen.add(u.id));
}

async function checkAndSendDeadlineReminders(baseUrl) {
  if (!mailer.isConfigured()) return;

  for (const { column, kind, label } of KINDS) {
    for (const days of THRESHOLDS_DAYS) {
      const deals = db.prepare(`
        SELECT * FROM deals
        WHERE status = 'active' AND deleted_at IS NULL
          AND ${column} IS NOT NULL AND ${column} = date('now', '+' || ? || ' days')
      `).all(days);

      for (const deal of deals) {
        const logKey = `${kind}_${days}d`;
        const already = db.prepare('SELECT 1 FROM deadline_reminders_log WHERE deal_id = ? AND kind = ? AND target_date = ?')
          .get(deal.id, logKey, deal[column]);
        if (already) continue;

        const recipients = recipientsForDeal(deal);
        if (!recipients.length) continue;

        const results = await Promise.all(recipients.map(u => mailer.sendDeadlineReminderEmail({
          to: u.email, name: u.name, dealProperty: deal.property,
          kindLabel: label, targetDate: deal[column], daysLeft: days,
          url: `${baseUrl}/?dealId=${deal.id}`
        })));
        const anySent = results.some(r => r.ok);
        if (anySent) {
          db.prepare('INSERT OR IGNORE INTO deadline_reminders_log (deal_id, kind, target_date) VALUES (?,?,?)')
            .run(deal.id, logKey, deal[column]);
          console.log(`[deadline-reminder] ${deal.property}: ${label} en ${days} días — avisado a ${recipients.length} persona(s)`);
        }
      }
    }
  }
}

module.exports = { checkAndSendDeadlineReminders };
