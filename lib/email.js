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

// Se perdió al rediseñar la envoltura de los correos (quedó sin declarar,
// causando "FROM is not defined" en cada envío desde entonces — silencioso
// porque sendEmail() atrapa el error y solo lo reporta como { ok:false },
// nunca tumbó nada, pero tampoco mandó un solo correo). Resend exige un
// remitente verificado en tu cuenta — si RESEND_FROM_EMAIL no está puesto,
// cae al dominio de pruebas de Resend (onboarding@resend.dev), que sí manda
// pero con menos entregabilidad que un dominio propio verificado.
const FROM = process.env.RESEND_FROM_EMAIL || 'Grupo Nar <onboarding@resend.dev>';

// Mismo dominio donde vive public/ (portal.gruponar.com en producción) — de
// ahí sale la URL absoluta del isotipo del correo (email-assets/logo-mark-*.png,
// el mismo isotipo oficial recortado del manual de marca que ya usa el login).
// Los clientes de correo no tienen "origen actual" como el navegador, así que
// esta URL siempre tiene que ser absoluta.
const PORTAL_ORIGIN = process.env.PORTAL_URL || process.env.FRONTEND_ORIGIN || 'https://portal.gruponar.com';
const LOGO_MARK_URL = `${PORTAL_ORIGIN}/email-assets/logo-mark-white.png`;

// Envoltura visual de todos los correos — mismos colores exactos que
// public/index.html (--oxblood-deep, --oxblood, --stone, --gold), con
// Cormorant Garamond/Inter vía Google Fonts para los clientes que sí cargan
// @import (Apple Mail, Gmail en iOS/Android) y Georgia/Arial como respaldo
// para los que no (Outlook de escritorio, Gmail de escritorio).
//
// El isotipo oficial (blanco, para el fondo oxblood del header) va al lado
// del nombre en texto — nunca solo, porque si las imágenes vienen
// bloqueadas el correo se queda sin nada que lo identifique como Grupo NAR.
//
// bgcolor (atributo HTML) se repite en cada celda junto con el mismo color
// en el style inline, y se agrega x-apple-disable-message-reformatting —
// sin ambos, Apple Mail en iOS a veces decide "modo oscuro automático" y
// convierte el fondo blanco/crema en negro aunque los meta de color-scheme
// digan "light only" (justo lo que pasaba antes).
function renderShell({ title, bodyHtml, ctaLabel, ctaUrl }) {
  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
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
    [data-ogsc] .nar-card, [data-ogsc] .nar-card td { background-color: #FFFFFF !important; color: #211613 !important; }
  </style>
</head>
<body class="nar-body" style="margin:0; padding:0; background-color:#F6F4F0; background:#F6F4F0; font-family:Georgia, 'Times New Roman', serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F6F4F0" style="background-color:#F6F4F0; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" class="nar-card" style="max-width:520px; background-color:#FFFFFF; border-radius:14px; overflow:hidden; border:1px solid #E4DCD8;">
        <tr><td class="nar-header" bgcolor="#3A0C08" style="background-color:#3A0C08; padding:24px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:12px; vertical-align:middle;"><img src="${LOGO_MARK_URL}" width="32" height="32" alt="" style="display:block; width:32px; height:32px; border:0;"></td>
            <td style="vertical-align:middle;">
              <div style="font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size:24px; color:#F6F4F0; font-weight:700; letter-spacing:1.5px; line-height:1.1;">GRUPO NAR</div>
              <div style="font-family:'Inter', Arial, sans-serif; font-size:10px; color:#D8B9B4; letter-spacing:1.6px; text-transform:uppercase; margin-top:3px;">Coordinación de cierres</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background-color:#9C7A3E; line-height:3px; font-size:3px;" bgcolor="#9C7A3E">&nbsp;</td></tr>
        <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF; padding:28px 28px 8px;">
          <div style="font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif; font-size:21px; color:#3A0C08; font-weight:600; margin-bottom:14px;">${title}</div>
          <div style="font-family:'Inter', Arial, sans-serif; font-size:14px; line-height:1.6; color:#211613;">${bodyHtml}</div>
        </td></tr>
        ${ctaUrl ? `
        <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF; padding:8px 28px 28px;">
          <a href="${ctaUrl}" style="display:inline-block; background-color:#58130E; color:#FFFFFF; text-decoration:none; font-family:'Inter', Arial, sans-serif; font-size:13.5px; font-weight:bold; padding:11px 24px; border-radius:24px;">${ctaLabel || 'Ver'}</a>
        </td></tr>` : ''}
        <tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF; padding:16px 28px; border-top:1px solid #E4DCD8; font-family:'Inter', Arial, sans-serif; font-size:11px; color:#A79A94;">
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

// Mismo criterio que DEFAULT_KYC_LANG_BY_SCENARIO_SIDE en routes/kyc.js
// (duplicado a propósito, igual que en public/index.html y
// lib/predialReminder.js — no hay endpoint de catálogos): compra directa,
// ambos mexicanos; fideicomiso, comprador extranjero; cesión, ambos
// extranjeros; extinción, comprador mexicano. Un cliente extranjero no
// entiende un correo en español, así que todos los correos que le llegan a
// comprador/vendedor deben poder mandarse en su idioma.
const DEFAULT_LANG_BY_SCENARIO_SIDE = {
  purchase: { seller: 'es', buyer: 'es' },
  trust: { seller: 'es', buyer: 'en' },
  transfer: { seller: 'en', buyer: 'en' },
  trust_termination: { seller: 'en', buyer: 'es' }
};
function resolveClientLang(scenario, side) {
  return (DEFAULT_LANG_BY_SCENARIO_SIDE[scenario] && DEFAULT_LANG_BY_SCENARIO_SIDE[scenario][side]) || 'es';
}

// El copy varía por rol: comprador/vendedor son quienes de verdad llenan
// KYC y firman, así que a ellos se les habla de "tu checklist"/"tu
// expediente". Un agente NO llena nada de eso — es quien coordina/da
// seguimiento a sus clientes — hablarle igual que a un comprador/vendedor
// suena a que lo estamos invitando de empleado a llenar papeleo, no a
// trabajar operaciones con nosotros (por eso antes sonaba raro y no abrían
// el correo). `lang` solo aplica a la rama de comprador/vendedor — a
// agentes/abogados (equipo de Grupo Nar) se les sigue hablando en español.
function sendInviteEmail({ to, name, roleInDeal, dealProperty, url, lang }) {
  let subject, title, bodyHtml;
  const isEn = lang === 'en';

  if (['agent', 'external_lawyer'].includes(roleInDeal) && dealProperty) {
    const roleLabel = roleInDeal === 'external_lawyer' ? 'abogado(a) externo(a)' : 'agente';
    subject = `Coordinación de cierre — ${dealProperty}`;
    title = 'Grupo Nar — coordinación de tu cierre';
    bodyHtml = `Hola ${escapeHtml(name)},<br><br>Te damos acceso al portal de Grupo Nar como <b>${roleLabel}</b> para dar seguimiento al cierre de <b>${escapeHtml(dealProperty)}</b>: checklist de documentos, expediente KYC y firma del contrato de tus clientes, todo en un solo lugar y en tiempo real.<br><br>Da clic abajo para crear tu contraseña y entrar.`;
  } else if (['buyer', 'seller'].includes(roleInDeal) && dealProperty) {
    if (isEn) {
      const roleLabel = roleInDeal === 'buyer' ? 'buyer' : 'seller';
      subject = `Closing: ${dealProperty}`;
      title = 'You were invited to Grupo Nar';
      bodyHtml = `Hi ${escapeHtml(name)},<br><br>You've been invited as <b>${roleLabel}</b> to the <b>${escapeHtml(dealProperty)}</b> deal on the Grupo Nar portal. There you'll be able to see your document checklist, fill out your KYC file, and sign electronically when the time comes.<br><br>Click below to set your password and log in.`;
    } else {
      const roleLabel = roleInDeal === 'buyer' ? 'comprador(a)' : 'vendedor(a)';
      subject = `Closing: ${dealProperty}`;
      title = 'Te invitaron a Grupo Nar';
      bodyHtml = `Hola ${escapeHtml(name)},<br><br>Te invitamos como <b>${roleLabel}</b> a la operación <b>${escapeHtml(dealProperty)}</b> en el portal de Grupo Nar. Ahí vas a poder ver tu checklist de documentos, llenar tu expediente KYC y firmar electrónicamente cuando llegue el momento.<br><br>Da clic abajo para crear tu contraseña y entrar.`;
    }
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
    html: renderShell({ title, bodyHtml, ctaLabel: isEn ? 'Create my account' : 'Crear mi cuenta', ctaUrl: url })
  });
}

function sendDocumentReminderEmail({ to, name, dealProperty, pendingDocNames, url, lang }) {
  const isEn = lang === 'en';
  const list = pendingDocNames.map(n => `<li style="margin-bottom:4px;">${escapeHtml(n)}</li>`).join('');
  const bodyHtml = isEn
    ? `Hi ${escapeHtml(name)},<br><br>This is a reminder that the following documents are still needed to move forward with the closing of <b>${escapeHtml(dealProperty)}</b>:<br><br><ul style="padding-left:20px; margin:0 0 12px;">${list}</ul>You can upload them directly from the portal.`
    : `Hola ${escapeHtml(name)},<br><br>Este es un recordatorio de que todavía faltan los siguientes documentos para avanzar con el cierre de <b>${escapeHtml(dealProperty)}</b>:<br><br><ul style="padding-left:20px; margin:0 0 12px;">${list}</ul>Puedes subirlos directamente desde el portal.`;
  return sendEmail({
    to,
    subject: isEn ? `Pending documents — ${dealProperty}` : `Documentos pendientes — ${dealProperty}`,
    html: renderShell({ title: isEn ? 'Pending documents' : 'Documentos pendientes', bodyHtml, ctaLabel: isEn ? 'Go to the portal' : 'Ir al portal', ctaUrl: url })
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

// Se manda cuando alguien que YA tiene cuenta (comprador/vendedor de otra
// operación, o agente/abogado) se liga a una operación nueva — a diferencia
// de sendInviteEmail/sendPartyWelcomeEmail, aquí no hace falta poner
// contraseña ni link de bienvenida, solo avisar que ya puede entrar.
// `lang` solo aplica a comprador/vendedor (ver resolveClientLang) — a
// agentes/abogados se les sigue avisando en español.
function sendAgentAddedToDealEmail({ to, name, dealProperty, url, lang }) {
  const isEn = lang === 'en';
  const bodyHtml = isEn
    ? `Hi ${escapeHtml(name)},<br><br>You've been added to the <b>${escapeHtml(dealProperty)}</b> deal on the Grupo Nar portal. You can already see the document checklist, your KYC file, and the closing status there.<br><br>Click below to open it directly.`
    : `Hola ${escapeHtml(name)},<br><br>Te agregamos a la operación <b>${escapeHtml(dealProperty)}</b> en el portal de Grupo Nar. Ya puedes ver ahí el checklist de documentos, el expediente KYC y el estado del cierre.<br><br>Da clic abajo para abrirla directamente.`;
  return sendEmail({
    to, subject: isEn ? `You were added to: ${dealProperty}` : `Te agregaron a: ${dealProperty}`,
    html: renderShell({ title: isEn ? 'New deal on your account' : 'Nueva operación en tu cuenta', bodyHtml, ctaLabel: isEn ? 'Open deal' : 'Abrir operación', ctaUrl: url })
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

// Recordatorio anual de predial a compradores ya cerrados (lib/predialReminder.js,
// primera semana de enero) — es el único correo de esta lista que no dispara
// una acción del portal, sino que mantiene la relación viva de cara a una
// futura venta. Por eso el tono es de servicio/agradecimiento y no de
// trámite, y siempre deja el celular directo además del correo.
function sendPredialReminderEmail({ to, name, dealProperty, lang }) {
  const year = new Date().getFullYear();
  const isEn = lang === 'en';
  const subject = isEn
    ? `Reminder: ${year} property tax (predial) — ${dealProperty}`
    : `Recordatorio: pago de predial ${year} — ${dealProperty}`;
  const title = isEn ? 'Property tax (predial) reminder' : 'Recordatorio de pago de predial';
  const bodyHtml = isEn ? `
    Hi ${escapeHtml(name)},<br><br>
    We hope all is well. It was a pleasure helping you close on <b>${escapeHtml(dealProperty)}</b> with Grupo Nar, and we remain at your service.<br><br>
    This is a friendly reminder that January is when the annual property tax (<i>predial</i>) is due on your property. We recommend taking care of it soon to avoid late fees.<br><br>
    Whenever you have questions about your property, are thinking about selling it down the road, or just want to talk about the market, we're happy to help.<br><br>
    You can reach us directly at <b>+52 322 135 7031</b> or <b>santonelli@gruponar.com</b>.<br><br>
    Thank you for trusting Grupo Nar.
  ` : `
    Hola ${escapeHtml(name)},<br><br>
    Esperamos que te esté yendo muy bien. Nos dio mucho gusto acompañarte en el cierre de <b>${escapeHtml(dealProperty)}</b> con Grupo Nar, y seguimos aquí para lo que necesites.<br><br>
    Este es un recordatorio de que enero es el mes en que se debe cubrir el pago del predial de tu propiedad. Te recomendamos hacerlo a la brevedad para evitar recargos.<br><br>
    Si en algún momento tienes dudas sobre tu propiedad, piensas ponerla en venta más adelante, o simplemente quieres platicar sobre el mercado, con gusto te ayudamos.<br><br>
    Puedes contactarnos directo al <b>+52 322 135 7031</b> o a <b>santonelli@gruponar.com</b>.<br><br>
    Gracias por confiar en Grupo Nar.
  `;
  return sendEmail({ to, subject, html: renderShell({ title, bodyHtml }) });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { isConfigured, sendEmail, sendInviteEmail, sendDocumentReminderEmail, sendStatusUpdateEmail, sendPasswordResetEmail, sendAgentAddedToDealEmail, sendPendingApprovalEmail, sendPredialReminderEmail, resolveClientLang };
