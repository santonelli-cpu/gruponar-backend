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

const FROM = process.env.RESEND_FROM_EMAIL || 'Grupo NAR <onboarding@resend.dev>';

// Envoltura visual de todos los correos — mismos colores exactos que
// public/shared.css (--oxblood-deep, --oxblood, --stone, --gold), con
// Cormorant Garamond/Inter vía Google Fonts para los clientes que sí cargan
// @import (Apple Mail, Gmail en iOS/Android) y Georgia/Arial como respaldo
// para los que no (Outlook de escritorio, Gmail de escritorio).
//
// El header es SOLO texto ("GRUPO NAR" en mayúsculas), no la imagen del
// logo — el logo real (public/logo.png) es del mismo tono oxblood que el
// fondo de esta franja, así que ahí se volvía casi invisible. Texto en
// crema sobre oxblood da el contraste correcto en cualquier cliente de
// correo, sin depender de que la imagen cargue.
function renderShell({ title, bodyHtml, ctaLabel, ctaUrl }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- Sin esto, Gmail/Apple Mail pueden invertir los colores en modo oscuro
       (el oxblood del header se vuelve otra cosa, o el fondo crema se pone
       negro) — obliga a que el correo se vea siempre en modo claro, tal
       como se diseñó. -->
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <!--[if !mso]><!-->
  <style>@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500&display=swap');</style>
  <!--<![endif]-->
  <style>
    :root { color-scheme: light only; supported-color-schemes: light only; }
    [data-ogsc] .nar-header { background-color: #3A0C08 !important; }
    [data-ogsc] .nar-body { background-color: #F6F4F0 !important; color: #211613 !important; }
  </style>
</head>
<body class="nar-body" style="margin:0; padding:0; background:#F6F4F0; font-family:Georgia, 'Times New Roman', serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F6F4F0" style="background:#F6F4F0; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#FFFFFF; border-radius:14px; overflow:hidden; border:1px solid #E4DCD8;">
        <tr><td class="nar-header" bgcolor="#3A0C08" style="background-color:#3A0C08; padding:26px 28px;">
          <div style="font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size:26px; color:#F6F4F0; font-weight:700; letter-spacing:2px; line-height:1.1;">GRUPO NAR</div>
          <div style="font-family:'Inter', Arial, sans-serif; font-size:10.5px; color:#D8B9B4; letter-spacing:1.8px; text-transform:uppercase; margin-top:4px;">Coordinación de cierres</div>
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
          Grupo NAR Legal Consultants — este correo es parte de la coordinación de tu operación inmobiliaria.
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

// El copy varía por rol: comprador/vendedor son quienes de verdad llenan
// KYC y firman, así que a ellos se les habla de "tu checklist"/"tu
// expediente". Un agente NO llena nada de eso — es quien coordina/da
// seguimiento a sus clientes — hablarle igual que a un comprador/vendedor
// suena a que lo estamos invitando de empleado a llenar papeleo, no a
// trabajar operaciones con nosotros (por eso antes sonaba raro y no abrían
// el correo).
function sendInviteEmail({ to, name, roleInDeal, dealProperty, url }) {
  let subject, title, bodyHtml;

  if (['agent', 'external_lawyer'].includes(roleInDeal) && dealProperty) {
    const roleLabel = roleInDeal === 'external_lawyer' ? 'abogado(a) externo(a)' : 'agente';
    subject = `Coordinación de cierre — ${dealProperty}`;
    title = 'Grupo Nar — coordinación de tu cierre';
    bodyHtml = `Hola ${escapeHtml(name)},<br><br>Te damos acceso al portal de Grupo Nar como <b>${roleLabel}</b> para dar seguimiento al cierre de <b>${escapeHtml(dealProperty)}</b>: checklist de documentos, expediente KYC y firma del contrato de tus clientes, todo en un solo lugar y en tiempo real.<br><br>Da clic abajo para crear tu contraseña y entrar.`;
  } else if (['buyer', 'seller'].includes(roleInDeal) && dealProperty) {
    const roleLabel = roleInDeal === 'buyer' ? 'comprador(a)' : 'vendedor(a)';
    subject = `Closing: ${dealProperty}`;
    title = 'Te invitaron a Grupo Nar';
    bodyHtml = `Hola ${escapeHtml(name)},<br><br>Te invitamos como <b>${roleLabel}</b> a la operación <b>${escapeHtml(dealProperty)}</b> en el portal de Grupo Nar. Ahí vas a poder ver tu checklist de documentos, llenar tu expediente KYC y firmar electrónicamente cuando llegue el momento.<br><br>Da clic abajo para crear tu contraseña y entrar.`;
  } else {
    // Invitación de equipo (agente, abogado externo, o abogado interno, sin operación específica).
    const roleLabel = roleInDeal === 'lawyer' ? 'abogado(a) / colaborador(a) interno'
      : roleInDeal === 'external_lawyer' ? 'abogado(a) externo(a)' : 'agente';
    subject = 'Te invitaron a Grupo Nar';
    title = 'Bienvenido a Grupo Nar';
    bodyHtml = `Hola ${escapeHtml(name)},<br><br>Te invitamos a unirte como <b>${roleLabel}</b> al portal de coordinación de cierres de Grupo Nar, para dar seguimiento a tus operaciones en tiempo real.<br><br>Da clic abajo para crear tu contraseña y entrar.`;
  }

  return sendEmail({
    to, subject,
    html: renderShell({ title, bodyHtml, ctaLabel: 'Crear mi cuenta', ctaUrl: url })
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

function sendAgentAddedToDealEmail({ to, name, dealProperty, url }) {
  const bodyHtml = `Hola ${escapeHtml(name)},<br><br>Te agregamos a la operación <b>${escapeHtml(dealProperty)}</b> en el portal de Grupo Nar. Ya puedes ver ahí el checklist de documentos, el expediente KYC y el estado del cierre.<br><br>Da clic abajo para abrirla directamente.`;
  return sendEmail({
    to, subject: `Te agregaron a: ${dealProperty}`,
    html: renderShell({ title: 'Nueva operación en tu cuenta', bodyHtml, ctaLabel: 'Abrir operación', ctaUrl: url })
  });
}

// Se manda a los admins cuando alguien se autoregistra (agente/abogado) y
// queda en status='pending' — antes había que acordarse de revisar la
// pestaña "Equipo" a mano para ver si había alguien esperando aprobación.
function sendPendingApprovalEmail({ to, applicantName, applicantEmail, applicantRole, applicantAgency, url }) {
  const roleLabel = applicantRole === 'lawyer' ? 'abogado(a) / colaborador(a) interno'
    : applicantRole === 'external_lawyer' ? 'abogado(a) externo(a)' : 'agente';
  const bodyHtml = `Se registró una cuenta nueva que necesita tu aprobación:<br><br>
    <b>${escapeHtml(applicantName)}</b> — ${escapeHtml(applicantEmail)}<br>
    Rol: ${roleLabel}${applicantAgency ? `<br>Agencia: ${escapeHtml(applicantAgency)}` : ''}<br><br>
    Mientras no la apruebes, esta persona no puede iniciar sesión.`;
  return sendEmail({
    to, subject: `Nueva cuenta pendiente de aprobar — ${applicantName}`,
    html: renderShell({ title: 'Cuenta pendiente de aprobación', bodyHtml, ctaLabel: 'Ir al portal', ctaUrl: url })
  });
}

function sendPasswordResetEmail({ to, name, url }) {
  const bodyHtml = `Hola ${escapeHtml(name)},<br><br>Pediste restablecer tu contraseña en el portal de Grupo Nar. Da clic abajo para poner una nueva — este link es válido por 1 hora.<br><br>Si tú no lo pediste, puedes ignorar este correo; tu contraseña actual sigue funcionando.`;
  return sendEmail({
    to, subject: 'Restablece tu contraseña — Grupo Nar',
    html: renderShell({ title: 'Restablece tu contraseña', bodyHtml, ctaLabel: 'Poner nueva contraseña', ctaUrl: url })
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { isConfigured, sendEmail, sendInviteEmail, sendDocumentReminderEmail, sendStatusUpdateEmail, sendPasswordResetEmail, sendAgentAddedToDealEmail, sendPendingApprovalEmail };
