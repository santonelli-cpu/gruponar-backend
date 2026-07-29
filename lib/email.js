const { Resend } = require('resend');

// Envío de correos transaccionales (invitaciones, recordatorios) — Resend.
// Si no hay RESEND_API_KEY configurada (ej. en desarrollo local sin correo
// real), isConfigured() devuelve false y quien llama decide si seguir sin
// mandar el correo (nunca debe bloquear la acción principal — ej. crear una
// invitación tiene que funcionar aunque el correo falle, el link ya quedó
// generado y se puede compartir a mano).
let client = null;
function getClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

const FROM = process.env.RESEND_FROM_EMAIL || 'Grupo Nar <onboarding@resend.dev>';

// Logo real del despacho (public/logo.png, extraído del mismo PNG que usa
// el header del sitio) — hosteado como archivo está en vez de data URI
// embebido porque Outlook de escritorio no renderiza imágenes base64 en
// correos (las deja en blanco), pero sí una <img src> normal.
const APP_URL = (process.env.APP_URL || 'https://portal.gruponar.com').replace(/\/$/, '');
const LOGO_URL = `${APP_URL}/logo.png`;

// Envoltura visual de todos los correos — mismos colores exactos que
// public/shared.css (--oxblood-deep, --oxblood, --stone, --gold) y la
// misma composición del header del sitio (logo + wordmark + subtítulo en
// versalitas sobre franja oxblood-deep), con Cormorant Garamond/Inter vía
// Google Fonts para los clientes que sí cargan @import (Apple Mail, Gmail
// en iOS/Android) y Georgia/Arial como respaldo para los que no
// (Outlook de escritorio, Gmail de escritorio).
function renderShell({ title, bodyHtml, ctaLabel, ctaUrl }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!--[if !mso]><!-->
  <style>@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500&display=swap');</style>
  <!--<![endif]-->
</head>
<body style="margin:0; padding:0; background:#F6F4F0; font-family:Georgia, 'Times New Roman', serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F6F4F0" style="background:#F6F4F0; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#FFFFFF; border-radius:14px; overflow:hidden; border:1px solid #E4DCD8;">
        <tr><td bgcolor="#3A0C08" style="background-color:#3A0C08; padding:24px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:12px;"><img src="${LOGO_URL}" width="40" height="40" alt="Grupo Nar" style="display:block; border:0;"></td>
            <td>
              <div style="font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size:23px; color:#F6F4F0; font-weight:600; letter-spacing:0.3px; line-height:1.1;">Grupo Nar</div>
              <div style="font-family:'Inter', Arial, sans-serif; font-size:10.5px; color:#D8B9B4; letter-spacing:1.8px; text-transform:uppercase; margin-top:3px;">Coordinación de cierres</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background-color:#9C7A3E; line-height:3px; font-size:3px;" bgcolor="#9C7A3E">&nbsp;</td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <div style="font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size:21px; color:#3A0C08; font-weight:600; margin-bottom:14px;">${title}</div>
          <div style="font-family:'Inter', Arial, sans-serif; font-size:14px; line-height:1.6; color:#211613;">${bodyHtml}</div>
        </td></tr>
        ${ctaUrl ? `
        <tr><td style="padding:8px 28px 28px;">
          <a href="${ctaUrl}" style="display:inline-block; background-color:#58130E; color:#FFFFFF; text-decoration:none; font-family:'Inter', Arial, sans-serif; font-size:13.5px; font-weight:bold; padding:11px 24px; border-radius:24px;">${ctaLabel || 'Ver'}</a>
        </td></tr>` : ''}
        <tr><td style="padding:16px 28px; border-top:1px solid #E4DCD8; font-family:'Inter', Arial, sans-serif; font-size:11px; color:#A79A94;">
          Grupo Nar Legal Consultants — este correo es parte de la coordinación de tu operación inmobiliaria.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Nunca lanza — un correo que falla no debe tumbar la acción que lo disparó
// (crear invitación, marcar recordatorio). Devuelve { ok, error? }.
async function sendEmail({ to, subject, html }) {
  const resend = getClient();
  if (!resend) return { ok: false, error: 'Resend no está configurado (falta RESEND_API_KEY).' };
  try {
    // El SDK de Resend no lanza en errores de la API (dominio no
    // verificado, etc.) — los devuelve en result.error y resuelve la
    // promesa igual, hay que revisarlo explícitamente.
    const result = await resend.emails.send({ from: FROM, to, subject, html });
    if (result.error) return { ok: false, error: result.error.message || 'Error al enviar el correo.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Error al enviar el correo.' };
  }
}

const ROLE_LABEL_ES = { buyer: 'comprador(a)', seller: 'vendedor(a)', agent: 'agente', lawyer: 'abogado(a) / empleado(a) interno' };

function sendInviteEmail({ to, name, roleInDeal, dealProperty, url }) {
  const roleLabel = ROLE_LABEL_ES[roleInDeal] || roleInDeal;
  const bodyHtml = dealProperty
    ? `Hola ${escapeHtml(name)},<br><br>Te invitamos como <b>${roleLabel}</b> a la operación <b>${escapeHtml(dealProperty)}</b> en el portal de Grupo Nar. Ahí vas a poder ver tu checklist de documentos, llenar tu expediente KYC y firmar electrónicamente cuando llegue el momento.<br><br>Da clic abajo para crear tu contraseña y entrar.`
    : `Hola ${escapeHtml(name)},<br><br>Te invitamos como <b>${roleLabel}</b> al equipo de Grupo Nar en el portal de coordinación de cierres.<br><br>Da clic abajo para crear tu contraseña y entrar.`;
  return sendEmail({
    to,
    subject: dealProperty ? `Invitación — ${dealProperty}` : 'Invitación al equipo de Grupo Nar',
    html: renderShell({ title: 'Te invitaron a Grupo Nar', bodyHtml, ctaLabel: 'Crear mi cuenta', ctaUrl: url })
  });
}

function sendDocumentReminderEmail({ to, name, dealProperty, pendingDocNames, url }) {
  const list = pendingDocNames.map(n => `<li style="margin-bottom:4px;">${escapeHtml(n)}</li>`).join('');
  const bodyHtml = `Hola ${escapeHtml(name)},<br><br>Este es un recordatorio de que todavía faltan los siguientes documentos para avanzar con el cierre de <b>${escapeHtml(dealProperty)}</b>:<br><br><ul style="padding-left:20px; margin:0 0 12px;">${list}</ul>Puedes subirlos directamente desde el portal.`;
  return sendEmail({
    to,
    subject: `Documentos pendientes — ${dealProperty}`,
    html: renderShell({ title: 'Documentos pendientes', bodyHtml, ctaLabel: 'Ir al portal', ctaUrl: url })
  });
}

function sendStatusUpdateEmail({ to, name, dealProperty, message, url }) {
  const bodyHtml = `Hola ${escapeHtml(name)},<br><br>${message}<br><br>Operación: <b>${escapeHtml(dealProperty)}</b>.`;
  return sendEmail({
    to,
    subject: `Actualización — ${dealProperty}`,
    html: renderShell({ title: 'Actualización de tu operación', bodyHtml, ctaLabel: 'Ir al portal', ctaUrl: url })
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { isConfigured, sendEmail, sendInviteEmail, sendDocumentReminderEmail, sendStatusUpdateEmail };
