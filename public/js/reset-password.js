const STRINGS = {
    es: {
      title: 'Restablece tu contraseña', loading: 'Cargando…',
      missingToken: 'Falta el token en el link. Pide uno nuevo desde la pantalla de inicio de sesión.',
      passwordPh: 'Nueva contraseña (mínimo 8 caracteres)', confirmPasswordPh: 'Confirma tu nueva contraseña',
      submit: 'Guardar y entrar', loginLink: 'Ir a iniciar sesión',
      errPasswordLength: 'La contraseña debe tener al menos 8 caracteres.',
      errPasswordMismatch: 'Las contraseñas no coinciden.',
      successMsg: 'Tu contraseña se actualizó. Ya puedes iniciar sesión con la nueva.',
      readyMsg: 'Escribe tu nueva contraseña.',
      tokenError: 'Este link ya no es válido — puede que haya expirado o que ya lo hayas usado. Pide uno nuevo desde la pantalla de inicio de sesión.'
    },
    en: {
      title: 'Reset your password', loading: 'Loading…',
      missingToken: 'The token is missing from the link. Request a new one from the login screen.',
      passwordPh: 'New password (minimum 8 characters)', confirmPasswordPh: 'Confirm your new password',
      submit: 'Save and log in', loginLink: 'Go to login',
      errPasswordLength: 'The password must be at least 8 characters.',
      errPasswordMismatch: "Passwords don't match.",
      successMsg: 'Your password was updated. You can now log in with the new one.',
      readyMsg: 'Enter your new password.',
      tokenError: "This link is no longer valid — it may have expired or already been used. Request a new one from the login screen."
    }
  };
  let lang = localStorage.getItem('nar_lang') || 'es';
  function t(key){ return STRINGS[lang][key] || key; }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const titleEl = document.getElementById('title');
  const subEl = document.getElementById('sub');
  const errorEl = document.getElementById('error');
  const formEl = document.getElementById('form');
  const successEl = document.getElementById('success');
  let tokenValid = false;

  function applyLang(){
    document.documentElement.lang = lang;
    document.getElementById('lang-toggle').textContent = lang === 'es' ? 'EN' : 'ES';
    titleEl.textContent = t('title');
    document.getElementById('password').placeholder = t('passwordPh');
    document.getElementById('password2').placeholder = t('confirmPasswordPh');
    document.getElementById('submit').textContent = t('submit');
    document.getElementById('login-link').textContent = t('loginLink');
    document.getElementById('success-msg').textContent = t('successMsg');
    if(!token){ subEl.textContent = ''; errorEl.textContent = t('missingToken'); }
    else if(tokenValid){ subEl.textContent = t('readyMsg'); }
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
    if(!res.ok){
      const err = new Error((body && body.error) || `Error ${res.status}`);
      err.code = body && body.code;
      throw err;
    }
    return body;
  }

  // El texto crudo del servidor siempre viene en español — para no romper
  // el toggle de idioma de esta página, los códigos conocidos (token
  // inválido/usado/expirado) se traducen del lado del cliente; solo un
  // error inesperado cae de vuelta al texto del servidor.
  function tokenErrorMessage(e){
    if(e.code === 'invalid' || e.code === 'used' || e.code === 'expired') return t('tokenError');
    return e.message;
  }

  async function init(){
    if (!token) { subEl.textContent = ''; errorEl.textContent = t('missingToken'); return; }
    try {
      await apiFetch('/api/auth/reset-password/' + token);
      tokenValid = true;
      subEl.textContent = t('readyMsg');
      formEl.style.display = 'block';
    } catch(e) {
      subEl.textContent = '';
      errorEl.textContent = tokenErrorMessage(e);
    }
  }

  document.getElementById('submit').onclick = async () => {
    errorEl.textContent = '';
    const password = document.getElementById('password').value;
    const password2 = document.getElementById('password2').value;
    if (password.length < 8) { errorEl.textContent = t('errPasswordLength'); return; }
    if (password !== password2) { errorEl.textContent = t('errPasswordMismatch'); return; }
    try {
      await apiFetch('/api/auth/reset-password/' + token, { method:'POST', body: JSON.stringify({ password }) });
      formEl.style.display = 'none';
      subEl.style.display = 'none';
      successEl.style.display = 'block';
    } catch(e) {
      errorEl.textContent = tokenErrorMessage(e);
    }
  };

  applyLang();
  init();
