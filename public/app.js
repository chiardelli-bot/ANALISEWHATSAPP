(function () {
  const estado = {
    executivos: [],
    executivoAtivoId: null,
    chats: [],
    chatAtivoId: null,
    socket: null,
  };

  const el = (id) => document.getElementById(id);

  // ---------- utilidades ----------
  function formatarHora(iso) {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function statusTexto(status) {
    return {
      conectado: 'Conectado',
      aguardando_qr: 'Aguardando QR code',
      desconectado: 'Desconectado',
      conectando: 'Conectando…',
    }[status] || status;
  }

  async function api(url, opts) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      mostrarLogin();
      throw new Error('não autenticado');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.erro || 'Erro na requisição');
    }
    return res.json();
  }

  // ---------- login ----------
  function mostrarLogin() {
    el('tela-login').classList.remove('oculto');
    el('app').classList.add('oculto');
  }

  function mostrarApp() {
    el('tela-login').classList.add('oculto');
    el('app').classList.remove('oculto');
    iniciarSocket();
    carregarExecutivos();
  }

  el('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-erro').textContent = '';
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          usuario: el('login-usuario').value,
          senha: el('login-senha').value,
        }),
      });
      mostrarApp();
    } catch (err) {
      el('login-erro').textContent = 'Usuário ou senha inválidos';
    }
  });

  el('btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    if (estado.socket) estado.socket.disconnect();
    mostrarLogin();
  });

  // ---------- socket.io ----------
  function iniciarSocket() {
    if (estado.socket) return;
    estado.socket = io();

    estado.socket.on('status_executivo', (payload) => {
      const exec = estado.executivos.find((e) => e.id === payload.executivoId);
      if (exec) {
        exec.status = payload.status;
        if ('wa_number' in payload) exec.wa_number = payload.wa_number;
      }
      renderExecutivos();
      if (payload.executivoId === estado.executivoAtivoId) {
        atualizarTituloExecutivo();
      }
      if (payload.last_qr && el('modal-qr').dataset.execId == payload.executivoId) {
        exibirQr(payload.last_qr, payload.status);
      }
      if (payload.status === 'conectado' && el('modal-qr').dataset.execId == payload.executivoId) {
        fecharModalQr();
      }
    });

    estado.socket.on('nova_mensagem', (payload) => {
      // Atualiza a lista de chats se for do executivo ativo
      if (payload.executivoId === estado.executivoAtivoId) {
        atualizarChatNaLista(payload);
        if (payload.chatId === estado.chatAtivoId) {
          renderMensagem(payload.message);
          rolarParaFinal();
        }
      }
    });
  }

  function atualizarChatNaLista(payload) {
    let chat = estado.chats.find((c) => c.id === payload.chatId);
    if (!chat) {
      chat = {
        id: payload.chatId,
        wa_chat_id: payload.waChatId,
        nome: payload.chatName,
        is_group: payload.isGroup,
        last_message_at: payload.message.wa_timestamp,
        last_message_preview: payload.message.texto || `[${payload.message.tipo}]`,
      };
      estado.chats.unshift(chat);
    } else {
      chat.last_message_at = payload.message.wa_timestamp;
      chat.last_message_preview = payload.message.texto || `[${payload.message.tipo}]`;
      estado.chats = [chat, ...estado.chats.filter((c) => c.id !== chat.id)];
    }
    renderChats();
  }

  // ---------- executivos ----------
  async function carregarExecutivos() {
    estado.executivos = await api('/api/executivos');
    renderExecutivos();
  }

  function renderExecutivos() {
    const lista = el('lista-executivos');
    lista.innerHTML = '';
    estado.executivos.forEach((exec) => {
      const div = document.createElement('div');
      div.className = 'item-executivo' + (exec.id === estado.executivoAtivoId ? ' ativo' : '');
      div.innerHTML = `
        <span class="status-dot status-${exec.status}"></span>
        <div class="info">
          <span class="nome">${escapeHtml(exec.nome)}</span>
          <span class="status-texto">${statusTexto(exec.status)}${exec.wa_number ? ' · ' + exec.wa_number : ''}</span>
        </div>
      `;
      div.addEventListener('click', () => selecionarExecutivo(exec));
      lista.appendChild(div);
    });
  }

  async function selecionarExecutivo(exec) {
    if (exec.status !== 'conectado') {
      abrirModalQr(exec);
      return;
    }
    estado.executivoAtivoId = exec.id;
    estado.chatAtivoId = null;
    renderExecutivos();
    atualizarTituloExecutivo();
    el('titulo-chat').textContent = 'Selecione uma conversa';
    el('lista-mensagens').innerHTML = '';
    await carregarChats(exec.id);
  }

  function atualizarTituloExecutivo() {
    const exec = estado.executivos.find((e) => e.id === estado.executivoAtivoId);
    el('titulo-executivo').textContent = exec ? `${exec.nome} — conversas` : 'Selecione um executivo';
  }

  // ---------- adicionar executivo ----------
  el('btn-add-executivo').addEventListener('click', () => {
    el('novo-executivo-nome').value = '';
    el('modal-novo-executivo').classList.remove('oculto');
  });
  el('novo-executivo-cancelar').addEventListener('click', () => {
    el('modal-novo-executivo').classList.add('oculto');
  });
  el('novo-executivo-salvar').addEventListener('click', async () => {
    const nome = el('novo-executivo-nome').value.trim();
    if (!nome) return;
    const exec = await api('/api/executivos', { method: 'POST', body: JSON.stringify({ nome }) });
    estado.executivos.push(exec);
    renderExecutivos();
    el('modal-novo-executivo').classList.add('oculto');
    abrirModalQr(exec);
  });

  // ---------- QR code ----------
  async function abrirModalQr(exec) {
    el('modal-qr').dataset.execId = exec.id;
    el('modal-qr-titulo').textContent = `Conectar WhatsApp — ${exec.nome}`;
    el('modal-qr-corpo').innerHTML = '<p>Gerando QR code…</p>';
    el('modal-qr').classList.remove('oculto');
    await api(`/api/executivos/${exec.id}/conectar`, { method: 'POST' });
    // Busca o QR mais recente (caso o evento em tempo real já tenha passado)
    const info = await api(`/api/executivos/${exec.id}/qrcode`);
    if (info.last_qr) exibirQr(info.last_qr, info.status);
  }

  function exibirQr(dataUrl, status) {
    if (status === 'conectado') return;
    el('modal-qr-corpo').innerHTML = `
      <img src="${dataUrl}" alt="QR code" />
      <p>No celular corporativo: WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
    `;
  }

  function fecharModalQr() {
    el('modal-qr').classList.add('oculto');
    carregarExecutivos();
  }
  el('modal-qr-fechar').addEventListener('click', fecharModalQr);

  // ---------- chats ----------
  async function carregarChats(executivoId) {
    estado.chats = await api(`/api/chats/executivo/${executivoId}`);
    renderChats();
  }

  function renderChats() {
    const lista = el('lista-chats');
    lista.innerHTML = '';
    if (estado.chats.length === 0) {
      lista.innerHTML = '<div class="vazio">Nenhuma conversa ainda</div>';
      return;
    }
    estado.chats.forEach((chat) => {
      const div = document.createElement('div');
      div.className = 'item-chat' + (chat.id === estado.chatAtivoId ? ' ativo' : '');
      div.innerHTML = `
        <div class="nome-chat">${escapeHtml(chat.nome || chat.wa_chat_id.split('@')[0])}</div>
        <span class="hora">${chat.last_message_at ? formatarHora(chat.last_message_at) : ''}</span>
        <div class="preview">${escapeHtml(chat.last_message_preview || '')}</div>
      `;
      div.addEventListener('click', () => selecionarChat(chat));
      lista.appendChild(div);
    });
  }

  async function selecionarChat(chat) {
    estado.chatAtivoId = chat.id;
    renderChats();
    el('titulo-chat').textContent = chat.nome || chat.wa_chat_id.split('@')[0];
    const mensagens = await api(`/api/chats/${chat.id}/mensagens?limit=200`);
    const lista = el('lista-mensagens');
    lista.innerHTML = '';
    mensagens.forEach(renderMensagem);
    rolarParaFinal();
  }

  function renderMensagem(msg) {
    const lista = el('lista-mensagens');
    const div = document.createElement('div');
    div.className = 'bolha ' + (msg.from_me ? 'enviada' : 'recebida');

    let corpo = '';
    if (!msg.from_me) {
      corpo += `<div class="remetente">${escapeHtml(msg.sender_name || msg.sender_number || '')}</div>`;
    }
    corpo += renderConteudo(msg);
    corpo += `<div class="hora-msg">${formatarHora(msg.wa_timestamp)}</div>`;
    div.innerHTML = corpo;
    lista.appendChild(div);
  }

  function renderConteudo(msg) {
    const urlMedia = msg.media_path ? `/media/${msg.media_path}` : null;
    switch (msg.tipo) {
      case 'image':
        return `${urlMedia ? `<img src="${urlMedia}" />` : ''}${msg.texto ? `<div>${escapeHtml(msg.texto)}</div>` : ''}`;
      case 'video':
        return `${urlMedia ? `<video src="${urlMedia}" controls></video>` : ''}${msg.texto ? `<div>${escapeHtml(msg.texto)}</div>` : ''}`;
      case 'audio':
        return urlMedia ? `<audio src="${urlMedia}" controls></audio>` : '<em>Áudio indisponível</em>';
      case 'sticker':
        return urlMedia ? `<img src="${urlMedia}" style="max-width:120px" />` : '<em>Figurinha</em>';
      case 'document':
        return urlMedia
          ? `<a class="documento" href="${urlMedia}" target="_blank" rel="noopener">📄 ${escapeHtml(msg.texto || 'Documento')}</a>`
          : `<em>${escapeHtml(msg.texto || 'Documento indisponível')}</em>`;
      default:
        return `<div>${escapeHtml(msg.texto || '')}</div>`;
    }
  }

  function rolarParaFinal() {
    const lista = el('lista-mensagens');
    lista.scrollTop = lista.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- inicialização ----------
  (async function init() {
    try {
      const { autenticado } = await api('/api/auth/me');
      if (autenticado) mostrarApp();
      else mostrarLogin();
    } catch (_) {
      mostrarLogin();
    }
  })();
})();
