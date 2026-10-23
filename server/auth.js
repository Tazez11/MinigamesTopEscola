const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Usuário: 3 a 20 caracteres, só letras, números e _.' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'A senha deve ter de 8 a 72 caracteres.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const info = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hash);
    res.status(201).json({ id: info.lastInsertRowid, username });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Esse nome de usuário já está em uso.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Informe usuário e senha.' });
  }

  const user = db
    .prepare('SELECT id, username, password_hash, avatar_url FROM users WHERE username = ?')
    .get(username);
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;

  if (!ok) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
    req.session.userId = user.id;
    res.json({ id: user.id, username: user.username, avatarUrl: user.avatar_url });
  });
});

router.get('/me', (req, res) => {
  const user = req.session.userId && db
    .prepare('SELECT id, username, avatar_url, created_at FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  res.json({ id: user.id, username: user.username, avatarUrl: user.avatar_url, createdAt: user.created_at });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.post('/avatar', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado.' });

  const raw = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  let avatarUrl = null;

  if (raw !== '') {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' || raw.length > 500) throw new Error();
      avatarUrl = parsed.href;
    } catch {
      return res.status(400).json({ error: 'Link inválido. Use um endereço que comece com https://' });
    }
  }

  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.session.userId);
  res.json({ avatarUrl });
});

module.exports = router;