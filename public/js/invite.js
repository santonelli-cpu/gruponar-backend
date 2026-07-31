const STRINGS = {
    es: {
      createAccount: 'Crear tu cuenta', loadingInvite: 'Cargando invitación…',
      missingToken: 'Falta el token de invitación en el link.',
      welcomeDeal: '{name}, te invitaron como {role} a la operación "{property}". Pon una contraseña para tu cuenta ({email}).',
      welcomeTeam: '{name}, te invitaron como {role} al equipo de Grupo Nar. Pon una contraseña para tu cuenta ({email}).',
      selectAgency: 'Selecciona tu agencia...', other: 'Otro', whichAgency: '¿Cuál agencia?',
      passwordPh: 'Contraseña (mínimo 8 caracteres)', confirmPasswordPh: 'Confirma tu contraseña',
      submit: 'Crear cuenta y entrar',
      errPasswordLength: 'La contraseña debe tener al menos 8 caracteres.',
      errPasswordMismatch: 'Las contraseñas no coinciden.', errChooseAgency: 'Elige tu agencia.',
      roleBuyer: 'comprador(a)', roleSeller: 'vendedor(a)', roleAgent: 'agente', roleLawyer: 'abogado(a) / empleado(a) interno',
      totpTitle: 'Verifica tu identidad',
      totpIntroSetup: 'Escanea este código con Google Authenticator, Authy o una app similar, y pon el código de 6 dígitos que te muestre.',
      totpIntroVerify: 'Pon el código de 6 dígitos de tu app de autenticación.',
      totpIntroEmailSent: 'Te mandamos un código a tu correo — ponlo aquí (vence en 10 minutos).',
      totpManualLabel: 'O escríbelo a mano en tu app:',
      totpCodePh: '000000', totpSubmit: 'Verificar', totpErrCode: 'Falta el código.',
      totpUseEmailInstead: '¿Prefieres recibir el código por correo?',
      totpResendCode: 'Reenviar código', totpSending: 'Enviando...',
      rememberDeviceLabel: 'Recordar este dispositivo por 30 días',
      totpChooseIntro: 'Elige cómo quieres recibir tu código de verificación.',
      totpChooseApp: 'Usar app autenticadora (QR)', totpChooseEmail: 'Recibir código por correo',
      totpChangeMethod: 'Elegir otro método'
    },
    en: {
      createAccount: 'Create your account', loadingInvite: 'Loading invitation…',
      missingToken: 'The invitation token is missing from the link.',
      welcomeDeal: '{name}, you were invited as {role} to the "{property}" deal. Set a password for your account ({email}).',
      welcomeTeam: '{name}, you were invited as {role} to the Grupo Nar team. Set a password for your account ({email}).',
      selectAgency: 'Select your agency...', other: 'Other', whichAgency: 'Which agency?',
      passwordPh: 'Password (minimum 8 characters)', confirmPasswordPh: 'Confirm your password',
      submit: 'Create account and log in',
      errPasswordLength: 'The password must be at least 8 characters.',
      errPasswordMismatch: "Passwords don't match.", errChooseAgency: 'Choose your agency.',
      roleBuyer: 'buyer', roleSeller: 'seller', roleAgent: 'agent', roleLawyer: 'lawyer / internal staff',
      totpTitle: 'Verify your identity',
      totpIntroSetup: 'Scan this code with Google Authenticator, Authy, or a similar app, then enter the 6-digit code it shows you.',
      totpIntroVerify: 'Enter the 6-digit code from your authenticator app.',
      totpIntroEmailSent: 'We sent a code to your email — enter it here (expires in 10 minutes).',
      totpManualLabel: 'Or type it in by hand in your app:',
      totpCodePh: '000000', totpSubmit: 'Verify', totpErrCode: 'Missing code.',
      totpUseEmailInstead: 'Prefer to get the code by email?',
      totpResendCode: 'Resend code', totpSending: 'Sending...',
      rememberDeviceLabel: 'Remember this device for 30 days',
      totpChooseIntro: 'Choose how you\'d like to receive your verification code.',
      totpChooseApp: 'Use authenticator app (QR)', totpChooseEmail: 'Get code by email',
      totpChangeMethod: 'Choose a different method'
    }
  };
  let lang = localStorage.getItem('nar_lang') || 'es';
  function t(key, vars){
    let s = STRINGS[lang][key] || key;
    if(vars) Object.keys(vars).forEach(k => { s = s.replace(new RegExp('\\{'+k+'\\}','g'), vars[k]); });
    return s;
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const titleEl = document.getElementById('title');
  const subEl = document.getElementById('sub');
  const errorEl = document.getElementById('error');
  const formEl = document.getElementById('form');
  const agencyEl = document.getElementById('agency');
  const agencyOtherEl = document.getElementById('agency-other');
  let inviteRole = null;
  let lastInvite = null;
  agencyEl.onchange = () => { agencyOtherEl.style.display = agencyEl.value === 'Otro' ? 'block' : 'none'; };

  function applyLang(){
    document.documentElement.lang = lang;
    document.getElementById('lang-toggle').textContent = lang === 'es' ? 'EN' : 'ES';
    titleEl.textContent = t('createAccount');
    document.getElementById('agency-placeholder').textContent = t('selectAgency');
    document.getElementById('agency-other-option').textContent = t('other');
    agencyOtherEl.placeholder = t('whichAgency');
    document.getElementById('password').placeholder = t('passwordPh');
    document.getElementById('password2').placeholder = t('confirmPasswordPh');
    document.getElementById('submit').textContent = t('submit');
    if(!token){ subEl.textContent = ''; errorEl.textContent = t('missingToken'); }
    else if(lastInvite) renderInvite(lastInvite);
    else subEl.textContent = t('loadingInvite');
  }
  document.getElementById('lang-toggle').onclick = () => {
    lang = lang === 'es' ? 'en' : 'es';
    localStorage.setItem('nar_lang', lang);
    applyLang();
  };

  async function apiFetch(path, options={}){
    const res = await fetch(path, { credentials:'include', headers:{'Content-Type':'application/json'}, ...options });
    let body = null;
    try{ body = await res.json(); }catch(e){}
    if(!res.ok) throw new Error((body && body.error) || `Error ${res.status}`);
    return body;
  }

  function renderInvite(invite){
    const roleKey = { buyer: 'roleBuyer', seller: 'roleSeller', agent: 'roleAgent', lawyer: 'roleLawyer' }[invite.roleInDeal];
    const roleLabel = roleKey ? t(roleKey) : invite.roleInDeal;
    subEl.textContent = invite.dealProperty
      ? t('welcomeDeal', { name: invite.name, role: roleLabel, property: invite.dealProperty, email: invite.email })
      : t('welcomeTeam', { name: invite.name, role: roleLabel, email: invite.email });
  }

  async function init(){
    if (!token) {
      subEl.textContent = '';
      errorEl.textContent = t('missingToken');
      return;
    }
    try {
      const invite = await apiFetch('/api/invites/' + token);
      inviteRole = invite.roleInDeal;
      lastInvite = invite;
      renderInvite(invite);
      if (inviteRole === 'agent') agencyEl.style.display = 'block';
      formEl.style.display = 'block';
    } catch(e) {
      subEl.textContent = '';
      errorEl.textContent = e.message;
    }
  }

  let pendingTotpMethod = null; // 'totp' | 'email'
  let pendingTotpSetupMode = false;
  let totpQrCode = null, totpSecret = null;

  document.getElementById('submit').onclick = async () => {
    errorEl.textContent = '';
    const password = document.getElementById('password').value;
    const password2 = document.getElementById('password2').value;
    if (password.length < 8) { errorEl.textContent = t('errPasswordLength'); return; }
    if (password !== password2) { errorEl.textContent = t('errPasswordMismatch'); return; }
    const agency = agencyEl.value;
    const agencyOther = agencyOtherEl.value.trim();
    if (inviteRole === 'agent' && (!agency || (agency==='Otro' && !agencyOther))) { errorEl.textContent = t('errChooseAgency'); return; }
    try {
      const result = await apiFetch('/api/invites/' + token + '/accept', { method:'POST', body: JSON.stringify({ password, agency, agencyOther, lang }) });
      showTotpStep(result);
    } catch(e) {
      errorEl.textContent = e.message;
    }
  };

  // La cuenta ya quedó creada/ligada, pero según POST /invites/:token/accept
  // (routes/invites.js -> beginTwoFactorChallenge) todavía falta el segundo
  // factor antes de que haya sesión de verdad — ver routes/auth.js.
  // result.method: 'choose' (primera vez, ofrece las dos opciones con
  // botones en vez de mostrar el QR de entrada con un link chiquito para
  // cambiar a correo), 'totp' o 'email'.
  function showTotpStep(result){
    if (result.method === 'choose') {
      totpQrCode = result.qrCode; totpSecret = result.secret;
      pendingTotpSetupMode = true;
      showTotpChoice();
      return;
    }
    formEl.style.display = 'none';
    document.getElementById('totp-choice').style.display = 'none';
    subEl.textContent = '';
    titleEl.textContent = t('totpTitle');
    pendingTotpMethod = result.method;
    const totpForm = document.getElementById('totp-form');
    const qrWrap = document.getElementById('totp-qr-wrap');
    const showQr = result.method === 'totp';
    document.getElementById('totp-intro').textContent =
      result.method === 'email' ? t('totpIntroEmailSent') : (pendingTotpSetupMode ? t('totpIntroSetup') : t('totpIntroVerify'));
    qrWrap.style.display = showQr ? 'block' : 'none';
    if (showQr) {
      document.getElementById('totp-qr').src = totpQrCode;
      document.getElementById('totp-manual-label').textContent = t('totpManualLabel');
      document.getElementById('totp-secret').textContent = totpSecret;
    }
    document.getElementById('totp-code').placeholder = t('totpCodePh');
    document.getElementById('totp-code').value = '';
    document.getElementById('totp-remember-label').textContent = t('rememberDeviceLabel');
    document.getElementById('totp-submit').textContent = t('totpSubmit');
    const resendBtn = document.getElementById('totp-resend');
    const changeMethodBtn = document.getElementById('totp-change-method');
    resendBtn.style.display = result.method === 'email' ? 'inline' : 'none';
    resendBtn.textContent = t('totpResendCode');
    changeMethodBtn.style.display = pendingTotpSetupMode ? 'inline' : 'none';
    changeMethodBtn.textContent = t('totpChangeMethod');
    totpForm.style.display = 'block';
    document.getElementById('totp-code').focus();
  }

  function showTotpChoice(){
    formEl.style.display = 'none';
    document.getElementById('totp-form').style.display = 'none';
    subEl.textContent = '';
    titleEl.textContent = t('totpTitle');
    document.getElementById('totp-choose-intro').textContent = t('totpChooseIntro');
    document.getElementById('totp-choose-app').textContent = t('totpChooseApp');
    document.getElementById('totp-choose-email').textContent = t('totpChooseEmail');
    document.getElementById('totp-choice').style.display = 'block';
  }

  document.getElementById('totp-choose-app').onclick = () => {
    showTotpStep({ method: 'totp' });
  };
  document.getElementById('totp-choose-email').onclick = async () => {
    errorEl.textContent = '';
    try {
      await apiFetch('/api/auth/email-otp', { method:'POST', body: JSON.stringify({ lang }) });
      showTotpStep({ method: 'email' });
    } catch(e2) {
      errorEl.textContent = e2.message;
    }
  };
  document.getElementById('totp-change-method').onclick = (e) => {
    e.preventDefault();
    showTotpChoice();
  };
  document.getElementById('totp-resend').onclick = async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const resendBtn = document.getElementById('totp-resend');
    resendBtn.textContent = t('totpSending');
    try {
      await apiFetch('/api/auth/email-otp', { method:'POST', body: JSON.stringify({ lang }) });
    } catch(e2) {
      errorEl.textContent = e2.message;
    }
    resendBtn.textContent = t('totpResendCode');
  };

  document.getElementById('totp-submit').onclick = async () => {
    errorEl.textContent = '';
    const code = document.getElementById('totp-code').value.trim();
    if (!code) { errorEl.textContent = t('totpErrCode'); return; }
    const remember = document.getElementById('totp-remember').checked;
    try {
      await apiFetch('/api/auth/totp', { method:'POST', body: JSON.stringify({ code, method: pendingTotpMethod === 'email' ? 'email' : 'totp', remember }) });
      window.location.href = '/';
    } catch(e) {
      errorEl.textContent = e.message;
    }
  };
  document.getElementById('totp-code').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('totp-submit').click(); };

  applyLang();
  init();
