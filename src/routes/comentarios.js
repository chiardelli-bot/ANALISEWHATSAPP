const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Comentários de uma conversa específica, em ordem cronológica (mais antigo primeiro),
// como um histórico de anotações feitas durante o monitoramento.
router.get('/chat/:chatId', async (req, res) => {
  const chatId = Number(req.params.chatId);
  const { rows } = await pool.query(
    `SELECT id, chat_id, executivo_id, texto, created_at
     FROM comentarios
     WHERE chat_id = $1
     ORDER BY created_at ASC`,
    [chatId]
  );
  res.json(rows);
});

// Adiciona um comentário a uma conversa (não é enviado ao WhatsApp — fica só no painel)
router.post('/chat/:chatId', async (req, res) => {
  const chatId = Number(req.params.chatId);
  const { texto } = req.body || {};
  if (!texto || !texto.trim()) {
    return res.status(400).json({ erro: 'Texto do comentário é obrigatório' });
  }

  const { rows: chatRows } = await pool.query('SELECT executivo_id FROM chats WHERE id = $1', [chatId]);
  if (!chatRows[0]) return res.status(404).json({ erro: 'Conversa não encontrada' });

  const { rows } = await pool.query(
    `INSERT INTO comentarios (executivo_id, chat_id, texto) VALUES ($1, $2, $3) RETURNING *`,
    [chatRows[0].executivo_id, chatId, texto.trim()]
  );
  res.json(rows[0]);
});

// Todos os comentários de um executivo, juntando as conversas de origem — é o
// "banco de comentários" usado na hora de dar feedback pra ele.
router.get('/executivo/:executivoId', async (req, res) => {
  const executivoId = Number(req.params.executivoId);
  const { rows } = await pool.query(
    `SELECT co.id, co.chat_id, co.executivo_id, co.texto, co.created_at,
            c.wa_chat_id, c.nome AS chat_nome
     FROM comentarios co
     JOIN chats c ON c.id = co.chat_id
     WHERE co.executivo_id = $1
     ORDER BY co.created_at DESC`,
    [executivoId]
  );
  res.json(rows);
});

// Remove um comentário (ex.: corrigir um engano de digitação)
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM comentarios WHERE id = $1', [id]);
  res.json({ ok: true });
});

module.exports = router;
