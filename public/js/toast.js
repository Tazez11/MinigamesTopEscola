function showToast(text, type) {
  const el = document.getElementById('toast');
  el.textContent = (type === 'error' ? '✕ ' : '✓ ') + text;
  el.className = 'toast show ' + type;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}