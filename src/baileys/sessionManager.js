const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { pool } = require('../db');

const AUTH_DIR = process.env.AUTH_DIR || './storage/auth';
const MEDIA_DIR = process.env.MEDIA_DIR || './storage/media';

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// executivoId -> { sock, status, qr }
const sessions = new Map();

let ioRef = null;
function attachIo(io) {
  ioRef = io;
}
function emit(event, payload) {
  if (ioRef) ioRef.emit(event, payload);
}

function extMimetype(mimetype) {
  if (!mimetype) return 'bin';
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  };
  return map[mimetype] || mimetype.split('/')[1]?.split(';')[0] || 'bin';
}

// WhatsApp embrulha o conteúdo real dentro de "wrappers" em vários casos comuns:
// mensagens temporárias (disappearing messages), "ver uma vez", documento com legenda
// e mensagens editadas. Sem desembrulhar, o conteúdo real fica invisível e a mensagem
// cai sempre em "other"/texto nulo — foi o que causou as conversas aparecerem vazias.
function unwrapMessage(message) {
  if (!message) return message;
  const wrapperKeys = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
  ];
  for (const key of wrapperKeys) {
    if (message[key]?.message) {
      return unwrapMessage(message[key].message);
    }
  }
  return message;
}

function getMessageTypeAndText(msg) {
  const m = unwrapMessage(msg.message);
  if (!m) return { tipo: 'other', texto: null };
  if (m.conversation) return { tipo: 'text', texto: m.conversation };
  if (m.extendedTextMessage) return { tipo: 'text', texto: m.extendedTextMessage.text };
  if (m.imageMessage) return { tipo: 'image', texto: m.imageMessage.caption || null };
  if (m.videoMessage) return { tipo: 'video', texto: m.videoMessage.caption || null };
  if (m.audioMessage) return { tipo: 'audio', texto: null };
  if (m.documentMessage) return { tipo: 'document', texto: m.documentMessage.caption || m.documentMessage.fileName || null };
  if (m.stickerMessage) return { tipo: 'sticker', texto: null };
  if (m.locationMessage) {
    const { degreesLatitude, degreesLongitude } = m.locationMessage;
    return { tipo: 'location', texto: `Localização: ${degreesLatitude}, ${degreesLongitude}` };
  }
  if (m.contactMessage) return { tipo: 'other', texto: `Contato: ${m.contactMessage.displayName || ''}` };
  if (m.contactsArrayMessage) return { tipo: 'other', texto: 'Contatos compartilhados' };
  if (m.buttonsResponseMessage) return { tipo: 'text', texto: m.buttonsResponseMessage.selectedDisplayText || null };
  if (m.listResponseMessage) return { tipo: 'text', texto: m.listResponseMessage.title || null };
  if (m.templateButtonReplyMessage) return { tipo: 'text', texto: m.templateButtonReplyMessage.selectedDisplayText || null };
  if (m.reactionMessage) return { tipo: 'other', texto: m.reactionMessage.text ? `Reagiu: ${m.reactionMessage.text}` : null };
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
    return { tipo: 'other', texto: `Enquete: ${poll.name || ''}` };
  }
  return { tipo: 'other', texto: null };
}

// Mensagens puramente de protocolo (revogação, sincronização, ajuste de tempo de
// mensagem temporária, chaves de grupo) não são conversas reais — não devem ser
// salvas nem exibidas.
function isProtocolOnlyMessage(msg) {
  const m = msg.message;
  if (!m) return true;
  const contentKeys = Object.keys(m).filter((k) => k !== 'messageContextInfo');
  if (contentKeys.length === 0) return true;
  const onlyProtocolKeys = contentKeys.every((k) => [
    'protocolMessage',
    'senderKeyDistributionMessage',
  ].includes(k));
  return onlyProtocolKeys;
}

function hasDownloadableMedia(msg) {
  const m = unwrapMessage(msg.message);
  return !!(m && (m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage));
}

async function upsertChat(executivoId, waChatId, nome, isGroup, lastMessageAt, preview) {
  const { rows } = await pool.query(
    `INSERT INTO chats (executivo_id, wa_chat_id, nome, is_group, last_message_at, last_message_preview)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (executivo_id, wa_chat_id) DO UPDATE SET
       nome = COALESCE(EXCLUDED.nome, chats.nome),
       last_message_at = GREATEST(chats.last_message_at, EXCLUDED.last_message_at),
       last_message_preview = CASE
         WHEN chats.last_message_at IS NULL OR EXCLUDED.last_message_at >= chats.last_message_at
           THEN EXCLUDED.last_message_preview
         ELSE chats.last_message_preview
       END
     RETURNING id`,
    [executivoId, waChatId, nome, isGroup, lastMessageAt, preview]
  );
  return rows[0].id;
}

// opts.silent: usado na sincronização de histórico (muitas mensagens de uma vez) —
// evita disparar um evento em tempo real por mensagem antiga.
async function handleIncomingMessage(executivoId, sock, msg, opts = {}) {
  try {
    if (!msg.message) return;
    if (isProtocolOnlyMessage(msg)) return;
    const waChatId = msg.key.remoteJid;
    if (!waChatId || waChatId === 'status@broadcast') return;
    const isGroup = waChatId.endsWith('@g.us');
    const fromMe = !!msg.key.fromMe;
    const tsMs = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

    let chatName = null;
    try {
      chatName = isGroup
        ? (sock.chatMetadataCache?.get?.(waChatId)?.subject) || null
        : null;
    } catch (_) { /* ignore */ }

    const { tipo, texto } = getMessageTypeAndText(msg);
    const senderNumber = (fromMe ? sock.user?.id : (msg.key.participant || waChatId) || '').split('@')[0].split(':')[0];
    const senderName = fromMe ? 'Você (executivo)' : (msg.pushName || senderNumber);

    const preview = texto || `[${tipo}]`;
    const chatId = await upsertChat(executivoId, waChatId, chatName, isGroup, new Date(tsMs), preview);

    // Evita duplicar (e reprocessar mídia à toa) quando a mesma mensagem chega de novo,
    // por exemplo durante a sincronização de histórico do WhatsApp.
    if (msg.key.id) {
      const { rows: existentes } = await pool.query(
        `SELECT 1 FROM messages WHERE chat_id = $1 AND wa_message_id = $2 LIMIT 1`,
        [chatId, msg.key.id]
      );
      if (existentes.length > 0) return;
    }

    let mediaPath = null;
    let mediaMimetype = null;
    if (hasDownloadableMedia(msg)) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
        const unwrapped = unwrapMessage(msg.message);
        const mm = unwrapped.imageMessage?.mimetype
          || unwrapped.videoMessage?.mimetype
          || unwrapped.audioMessage?.mimetype
          || unwrapped.documentMessage?.mimetype
          || unwrapped.stickerMessage?.mimetype
          || 'application/octet-stream';
        mediaMimetype = mm;
        const dir = path.join(MEDIA_DIR, `exec_${executivoId}`);
        fs.mkdirSync(dir, { recursive: true });
        const filename = `${Date.now()}_${crypto.randomUUID()}.${extMimetype(mm)}`;
        const fullPath = path.join(dir, filename);
        fs.writeFileSync(fullPath, buffer);
        mediaPath = path.join(`exec_${executivoId}`, filename);
      } catch (err) {
        console.error(`[exec ${executivoId}] falha ao baixar mídia:`, err.message);
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO messages (chat_id, wa_message_id, from_me, sender_name, sender_number, tipo, texto, media_path, media_mimetype, wa_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (chat_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [chatId, msg.key.id, fromMe, senderName, senderNumber, tipo, texto, mediaPath, mediaMimetype, new Date(tsMs)]
    );
    if (rows.length === 0) return; // outra chamada concorrente já inseriu essa mensagem

    if (!opts.silent) {
      emit('nova_mensagem', {
        executivoId,
        chatId,
        waChatId,
        chatName,
        isGroup,
        message: rows[0],
      });
    }
  } catch (err) {
    console.error(`[exec ${executivoId}] erro processando mensagem:`, err);
  }
}

async function setExecutivoStatus(executivoId, status, extra = {}) {
  const fields = ['status = $2'];
  const values = [executivoId, status];
  let idx = 3;
  if ('last_qr' in extra) {
    fields.push(`last_qr = $${idx++}`);
    values.push(extra.last_qr);
  }
  if ('wa_number' in extra) {
    fields.push(`wa_number = $${idx++}`);
    values.push(extra.wa_number);
  }
  await pool.query(`UPDATE executivos SET ${fields.join(', ')} WHERE id = $1`, values);
  emit('status_executivo', { executivoId, status, ...extra });
}

async function startSession(executivoId) {
  if (sessions.has(executivoId)) {
    const existing = sessions.get(executivoId);
    if (existing.status === 'conectado' || existing.status === 'aguardando_qr') return existing;
  }

  const authDir = path.join(AUTH_DIR, `exec_${executivoId}`);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    // Pede ao WhatsApp para sincronizar o histórico de conversas ao parear —
    // sem isso, a ferramenta só vê mensagens a partir do momento da conexão.
    // Só chega dado nessa sincronização logo após escanear o QR (pareamento novo);
    // uma sessão já conectada não recebe histórico de novo sem desconectar e reconectar.
    syncFullHistory: true,
    markOnlineOnConnect: false, // não altera o "online" do executivo
  });

  const entry = { sock, status: 'conectando', qr: null };
  sessions.set(executivoId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      entry.status = 'aguardando_qr';
      entry.qr = qrDataUrl;
      await setExecutivoStatus(executivoId, 'aguardando_qr', { last_qr: qrDataUrl });
    }

    if (connection === 'open') {
      entry.status = 'conectado';
      entry.qr = null;
      const waNumber = sock.user?.id?.split(':')[0] || null;
      await setExecutivoStatus(executivoId, 'conectado', { last_qr: null, wa_number: waNumber });
      console.log(`[exec ${executivoId}] conectado (${waNumber})`);
    }

    if (connection === 'close') {
      entry.status = 'desconectado';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      await setExecutivoStatus(executivoId, 'desconectado');
      sessions.delete(executivoId);
      if (shouldReconnect) {
        setTimeout(() => startSession(executivoId).catch((e) => console.error(e)), 3000);
      } else {
        // logout definitivo: limpa credenciais salvas para permitir novo QR
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (_) { /* ignore */ }
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      await handleIncomingMessage(executivoId, sock, msg);
    }
  });

  // Chega uma vez, logo após o pareamento (escaneou o QR), com o histórico que o
  // WhatsApp decidiu compartilhar daquele celular. Processa em silêncio (sem
  // notificar em tempo real mensagem por mensagem) e avisa o painel no final.
  sock.ev.on('messaging-history.set', async ({ messages: historyMessages }) => {
    if (!historyMessages || historyMessages.length === 0) return;
    console.log(`[exec ${executivoId}] sincronizando histórico: ${historyMessages.length} mensagens`);
    for (const msg of historyMessages) {
      await handleIncomingMessage(executivoId, sock, msg, { silent: true });
    }
    emit('historico_sincronizado', { executivoId });
  });

  return entry;
}

async function restoreAllSessions() {
  const { rows } = await pool.query(`SELECT id FROM executivos WHERE status <> 'desconectado' OR wa_number IS NOT NULL`);
  for (const row of rows) {
    startSession(row.id).catch((e) => console.error('erro ao restaurar sessão', row.id, e));
  }
}

function getSessionInfo(executivoId) {
  return sessions.get(executivoId) || null;
}

async function logoutSession(executivoId) {
  const entry = sessions.get(executivoId);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch (_) { /* ignore */ }
  }
  sessions.delete(executivoId);
  const authDir = path.join(AUTH_DIR, `exec_${executivoId}`);
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  await setExecutivoStatus(executivoId, 'desconectado', { last_qr: null });
}

// Pede ao WhatsApp mensagens mais antigas para cada conversa já conhecida desse
// executivo (sincronização de histórico "sob demanda" do Baileys). Diferente do
// syncFullHistory (que só acontece uma vez, ao escanear o QR), isso funciona com
// a sessão já conectada — sem precisar desconectar e reconectar o WhatsApp.
// As mensagens retornadas chegam de forma assíncrona pelo mesmo evento
// 'messaging-history.set' já tratado em startSession, então a deduplicação e o
// aviso ao painel (evento 'historico_sincronizado') acontecem automaticamente.
async function solicitarHistoricoAdicional(executivoId) {
  const entry = sessions.get(executivoId);
  if (!entry?.sock || entry.status !== 'conectado') {
    throw new Error('Executivo não está conectado');
  }
  const sock = entry.sock;

  // Mensagem mais antiga já conhecida em cada conversa desse executivo — é a
  // partir dela que o WhatsApp busca o que veio antes.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (m.chat_id)
       m.chat_id, c.wa_chat_id, m.wa_message_id, m.from_me, m.wa_timestamp
     FROM messages m
     JOIN chats c ON c.id = m.chat_id
     WHERE c.executivo_id = $1 AND m.wa_message_id IS NOT NULL
     ORDER BY m.chat_id, m.wa_timestamp ASC`,
    [executivoId]
  );

  console.log(`[exec ${executivoId}] solicitando històico adicional de ${rows.length} conversa(s)`);

  for (const row of rows) {
    try {
      await sock.fetchMessageHistory(
        50,
        { remoteJid: row.wa_chat_id, fromMe: row.from_me, id: row.wa_message_id },
        new Date(row.wa_timestamp).getTime()
      );
    } catch (err) {
      console.error(`[exec ${executivoId}] falha ao pedir histórico de ${row.wa_chat_id}:`, err.message);
    }
    // Evita disparar muitas requisições de uma vez (o WhatsApp limita a taxa desses pedidos).
    await new Promise((r) => setTimeout(r, 1200));
  }
}

module.exports = {
  attachIo,
  startSession,
  restoreAllSessions,
  getSessionInfo,
  logoutSession,
  solicitarHistoricoAdicional,
  MEDIA_DIR,
};
