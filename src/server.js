require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');

const { initDb } = require('./db');
const sessionManager = require('./baileys/sessionManager');
const { router: authRouter, requireAuth } = require('./routes/auth');
const executivosRouter = require('./routes/executivos');
const chatsRouter = require('./routes/chats');

const PORT = process.env.PORT || 3000;

async function main() {
  await initDb();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  sessionManager.attachIo(io);

  app.use(express.json());

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'troque-este-segredo',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 },
  });
  app.use(sessionMiddleware);

  // Compartilha a sessão HTTP com o Socket.IO, para só liberar eventos a quem está logado
  io.engine.use(sessionMiddleware);
  io.use((socket, next) => {
    const req = socket.request;
    if (req.session && req.session.autenticado) return next();
    next(new Error('não autenticado'));
  });

  // Rotas de autenticação (login/logout/me) — sem exigir login
  app.use('/api/auth', authRouter);

  // A partir daqui, tudo exige login
  app.use('/api/executivos', requireAuth, executivosRouter);
  app.use('/api/chats', requireAuth, chatsRouter);

  // Serve arquivos de mídia baixados do WhatsApp, só para quem está logado
  app.get('/media/:executivoDir/:filename', requireAuth, (req, res) => {
    const { executivoDir, filename } = req.params;
    if (executivoDir.includes('..') || filename.includes('..')) return res.status(400).end();
    const fullPath = path.join(sessionManager.MEDIA_DIR, executivoDir, filename);
    if (!fs.existsSync(fullPath)) return res.status(404).end();
    res.sendFile(path.resolve(fullPath));
  });

  // Front-end estático
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Qualquer rota não-API cai no index (SPA simples)
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  server.listen(PORT, () => {
    console.log(`Painel rodando em http://localhost:${PORT}`);
  });

  // Restaura sessões do WhatsApp que já estavam conectadas antes do restart
  sessionManager.restoreAllSessions();
}

main().catch((err) => {
  console.error('Falha ao iniciar aplicação:', err);
  process.exit(1);
});
