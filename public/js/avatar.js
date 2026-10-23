function setAvatar(el, user) {
  el.textContent = user.username[0].toUpperCase();
  el.dataset.src = user.avatarUrl || '';
  if (!user.avatarUrl) return;

  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    if (el.dataset.src !== user.avatarUrl) return;
    el.textContent = '';
    el.appendChild(img);
  };
  img.src = user.avatarUrl;
}