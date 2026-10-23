const profileModal = document.getElementById('profile-modal');
const profileForm = document.getElementById('profile-form');
const profileUrl = document.getElementById('profile-url');
const profilePreview = document.getElementById('profile-preview');
const profileMsg = document.getElementById('profile-msg');
const profileSave = document.getElementById('profile-save');

let profileUser = null;
let timer;

function profileMessage(text, type) {
  const icon = type === 'error' ? '✕ ' : type === 'success' ? '✓ ' : '';
  profileMsg.textContent = text ? icon + text : '';
  profileMsg.className = 'form-msg ' + (type || '');
}

function checkUrl() {
  const url = profileUrl.value.trim();

  if (!url) {
    setAvatar(profilePreview, { username: profileUser.username });
    profileMessage('', '');
    profileSave.disabled = false;
    return;
  }
  if (!url.startsWith('https://')) {
    profileMessage('O link precisa começar com https://', 'error');
    profileSave.disabled = true;
    return;
  }

  profileSave.disabled = true;
  profileMessage('Verificando imagem...', '');
  const img = new Image();
  img.onload = () => {
    if (profileUrl.value.trim() !== url) return;
    setAvatar(profilePreview, { username: profileUser.username, avatarUrl: url });
    profileMessage('A imagem carregou.', 'success');
    profileSave.disabled = false;
  };
  img.onerror = () => {
    if (profileUrl.value.trim() !== url) return;
    profileMessage('Não foi possível carregar. O link deve apontar direto para um arquivo de imagem, e alguns sites bloqueiam o uso em outros sites.', 'error');
    profileSave.disabled = true;
  };
    img.referrerPolicy = 'no-referrer';
  img.src = url;
}

document.getElementById('btn-perfil').addEventListener('click', async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) return;
  profileUser = await res.json();

  document.getElementById('profile-name').textContent = profileUser.username;
  const date = new Date(profileUser.createdAt.replace(' ', 'T') + 'Z');
  document.getElementById('profile-info').textContent = 'Conta criada em ' + date.toLocaleDateString('pt-BR');
  profileUrl.value = profileUser.avatarUrl || '';
  setAvatar(profilePreview, profileUser);
  profileMessage('', '');
  profileSave.disabled = false;
  profileModal.showModal();
});

profileUrl.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(checkUrl, 500);
});

document.getElementById('profile-cancel').addEventListener('click', () => profileModal.close());

profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  profileSave.disabled = true;
  try {
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: profileUrl.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    profileUser.avatarUrl = data.avatarUrl;
    setAvatar(document.getElementById('btn-perfil'), profileUser);
    profileModal.close();
  } catch (err) {
    profileMessage(err instanceof TypeError ? 'Sem conexão com o servidor.' : err.message, 'error');
    profileSave.disabled = false;
  }
});
