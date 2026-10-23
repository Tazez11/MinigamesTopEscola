const modal = document.getElementById('auth-modal');
const form = document.getElementById('auth-form');
const msg = document.getElementById('auth-msg');
const submitBtn = document.getElementById('auth-submit');
const tabs = document.querySelectorAll('.tab');
const btnEntrar = document.getElementById('btn-entrar');
const userChip = document.getElementById('user-chip');
const userName = document.getElementById('user-name');

let mode = 'login';

function setMode(newMode) {
  mode = newMode;
  tabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
  });
  submitBtn.textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  form.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  msg.textContent = '';
  msg.className = 'form-msg';
}

function showMessage(text, type) {
  msg.textContent = (type === 'error' ? '✕ ' : '✓ ') + text;
  msg.className = 'form-msg ' + type;
}

function renderUser(user) {
  btnEntrar.hidden = Boolean(user);
  userChip.hidden = !user;
  if (user) {
    userName.textContent = user.username;
    setAvatar(document.getElementById('btn-perfil'), user);
  }
}

async function api(path, body) {
  const res = await fetch('/api/auth/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro inesperado.');
  return data;
}

btnEntrar.addEventListener('click', () => {
  setMode('login');
  modal.showModal();
});
document.getElementById('auth-cancel').addEventListener('click', () => modal.close());
tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  const data = Object.fromEntries(new FormData(form));

  try {
    if (mode === 'register') await api('register', data);
    const user = await api('login', data);
    renderUser(user);
    form.reset();
    modal.close();
  } catch (err) {
    const text = err instanceof TypeError ? 'Sem conexão com o servidor.' : err.message;
    showMessage(text, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('btn-sair').addEventListener('click', async () => {
  try {
    await api('logout');
  } catch (err) {
    console.error(err);
  }
  renderUser(null);
});

fetch('/api/auth/me')
  .then((res) => (res.ok ? res.json() : null))
  .then(renderUser)
  .catch(() => renderUser(null));