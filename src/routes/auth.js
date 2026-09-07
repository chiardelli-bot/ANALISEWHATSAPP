const express = require('express');
const router = express.Router();

router.post('/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (usuario === process.env.ADMIN_USER && senha === process.env.ADMIN_PASS) {
    req.session.autenticado = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, erro: 'Usuário ou senha inválidos' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json({ autenticado: !!(req.session && req.session.autenticado) });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.autenticado) return next();
  return res.status(401).json({ ok: false, erro: 'Não autenticado' });
}

module.exports = { router, requireAuth };
