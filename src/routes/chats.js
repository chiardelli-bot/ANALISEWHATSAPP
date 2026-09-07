const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Lista as conversas de um executivo, mais recentes primeiro
router.get('/executivo/:executivoId', async (req, res) => {
  const executivoId = Number(req.params.executivoId);
  const { rows } = await pool.query(
    `SELECT id, wa_chat_id, nome, is_group, last_message_at, last_message_preview
     FROM chats
     WHERE executivo_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [executivoId]
  );
  res.json(rows);
});

// Mensagens de uma conversa específica (paginado, mais recentes por último)
router.get('/:chatId/mensagens', async (req, res) => {
  const chatId = Number(req.params.chatId);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const before = req.query.before; // ISO timestamp opcional, para paginar "carregar mais antigas"

  const params = [chatId];
  let where = 'chat_id = $1';
  if (before) {
    params.push(before);
    where += ` AND wa_timestamp < $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT * FROM messages WHERE ${where} ORDER BY wa_timestamp DESC LIMIT $${params.length}
     ) sub ORDER BY wa_timestamp ASC`,
    params
  );
  res.json(rows);
});

module.exports = router;
