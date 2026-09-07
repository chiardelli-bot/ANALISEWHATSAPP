const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const sessionManager = require('../baileys/sessionManager');

// Lista todos os executivos com status atual
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, wa_number, status, created_at FROM executivos ORDER BY nome ASC`
  );
  res.json(rows);
});

// Cadastra um novo executivo (ainda sem WhatsApp conectado)
router.post('/', async (req, res) => {
  const { nome } = req.body || {};
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
  const { rows } = await pool.query(
    `INSERT INTO executivos (nome) VALUES ($1) RETURNING *`,
    [nome.trim()]
  );
  res.json(rows[0]);
});

// Remove um executivo (encerra sessão e apaga histórico em cascata)
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await sessionManager.logoutSession(id);
  await pool.query(`DELETE FROM executivos WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// Inicia (ou reinicia) a sessão do WhatsApp para gerar o QR code
router.post('/:id/conectar', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(`SELECT * FROM executivos WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ erro: 'Executivo não encontrado' });
  await sessionManager.startSession(id);
  res.json({ ok: true });
});

// Consulta o QR atual (caso o front tenha perdido o evento em tempo real)
router.get('/:id/qrcode', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(`SELECT status, last_qr FROM executivos WHERE id = $1`, [id]);
  if (!rows[0]) return res.status(404).json({ erro: 'Executivo não encontrado' });
  res.json(rows[0]);
});

// Desconecta (logout) o WhatsApp desse executivo, permitindo novo QR depois
router.post('/:id/desconectar', async (req, res) => {
  const id = Number(req.params.id);
  await sessionManager.logoutSession(id);
  res.json({ ok: true });
});

module.exports = router;
