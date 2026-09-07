const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/Render costumam exigir SSL em produção; em dev local (sem sslmode) isso é ignorado.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executivos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  wa_number TEXT,
  status TEXT NOT NULL DEFAULT 'desconectado', -- desconectado | aguardando_qr | conectado
  last_qr TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id SERIAL PRIMARY KEY,
  executivo_id INTEGER NOT NULL REFERENCES executivos(id) ON DELETE CASCADE,
  wa_chat_id TEXT NOT NULL,
  nome TEXT,
  is_group BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (executivo_id, wa_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_chats_executivo ON chats(executivo_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  wa_message_id TEXT,
  from_me BOOLEAN NOT NULL DEFAULT false,
  sender_name TEXT,
  sender_number TEXT,
  tipo TEXT NOT NULL DEFAULT 'text', -- text | image | audio | video | document | sticker | location | other
  texto TEXT,
  media_path TEXT,
  media_mimetype TEXT,
  wa_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, wa_timestamp DESC);

-- Evita duplicar mensagens quando o histórico do WhatsApp é sincronizado
-- (a mesma mensagem pode chegar de novo via "messaging-history.set").
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_waid
  ON messages(chat_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
`;

async function initDb() {
  await pool.query(SCHEMA);
}

module.exports = { pool, initDb };
