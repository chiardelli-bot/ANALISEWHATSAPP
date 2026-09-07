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

// Busca conversas de um executivo por palavra (no texto das mensagens ou no nome
// do contato) ou por telefone (no wa_chat_id). Retorna a conversa e, quando o
// termo bateu numa mensagem, o trecho mais recente que deu match (pra mostrar
// como prévia no resultado da busca).
router.get('/buscar/:executivoId', async (req, res) => {
  const executivoId = Number(req.params.executivoId);
  const termo = (req.query.q || '').trim();
  if (!termo) return res.json([]);
  const like = `%${termo}%`;

  const [porChat, porMensagem] = await Promise.all([
    pool.query(
      `SELECT id, wa_chat_id, nome, is_group, last_message_at, last_message_preview
       FROM chats
       WHERE executivo_id = $1 AND (wa_chat_id ILIKE $2 OR nome ILIKE $2)`,
      [executivoId, like]
    ),
    pool.query(
      `SELECT DISTINCT ON (c.id)
         c.id, c.wa_chat_id, c.nome, c.is_group, c.last_message_at, c.last_message_preview,
         m.texto AS trecho, m.wa_timestamp AS trecho_ts
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE c.executivo_id = $1 AND m.texto ILIKE $2
       ORDER BY c.id, m.wa_timestamp DESC`,
      [executivoId, like]
    ),
  ]);

  const porId = new Map();
  porChat.rows.forEach((c) => porId.set(c.id, { ...c, trecho: null, trecho_ts: null }));
  porMensagem.rows.forEach((c) => porId.set(c.id, { ...(porId.get(c.id) || {}), ...c }));

  const resultado = [...porId.values()].sort(
    (a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
  );
  res.json(resultado);
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
