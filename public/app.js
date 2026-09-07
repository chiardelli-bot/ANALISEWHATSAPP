(function () {
  const estado = {
    executivos: [],
    executivoAtivoId: null,
    chats: [],
    chatAtivoId: null,
    socket: null,
    mensagemMaisAntigaTs: null, // wa_timestamp da mensagem mais antiga já carregada (para "carregar anteriores")
    podeTerMaisAntigas: false,
    ultimoGrupoRemetente: null, // controla agrupamento visual de mensagens seguidas do mesmo remetente
    termoBusca: '', // termo atual da busca de conversas (vazio = lista normal)
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
        atualizarBotaoSincronizarHistorico();
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

    // Disparado uma vez, logo após um executivo parear o QR: o WhatsApp entregou
    // o histórico de conversas do celular. Recarrega a lista/conversa na tela.
    estado.socket.on('historico_sincronizado', async (payload) => {
      if (payload.executivoId !== estado.executivoAtivoId) return;
      const chatAberto = estado.chatAtivoId;
      await carregarChats(estado.executivoAtivoId);
      if (chatAberto) {
        const chat = estado.chats.find((c) => c.id === chatAberto);
        if (chat) await selecionarChat(chat);
      }
    });

    // O nome salvo do contato (ou de um grupo) pode chegar depois da conversa já
    // aparecer na lista só com o número — quando isso acontece, só atualiza a
    // lista e o título (sem recarregar as mensagens, que não mudaram).
    estado.socket.on('nome_contato_atualizado', async (payload) => {
      if (payload.executivoId !== estado.executivoAtivoId) return;
      await carregarChats(estado.executivoAtivoId);
      if (estado.chatAtivoId) {
        const chat = estado.chats.find((c) => c.id === estado.chatAtivoId);
        if (chat) el('titulo-chat').textContent = chat.nome || chat.wa_chat_id.split('@')[0];
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
    atualizarBotaoSincronizarHistorico();
    atualizarBotoesComentarios();
    el('titulo-chat').textContent = 'Selecione uma conversa';
    el('lista-mensagens').innerHTML = '';
    estado.termoBusca = '';
    el('busca-chats-input').value = '';
    el('busca-chats-limpar').classList.add('oculto');
    await carregarChats(exec.id);
  }

  function atualizarTituloExecutivo() {
    const exec = estado.executivos.find((e) => e.id === estado.executivoAtivoId);
    el('titulo-executivo').textContent = exec ? `${exec.nome} — conversas` : 'Selecione um executivo';
  }

  // ---------- sincronizar histórico sob demanda ----------
  // Pede ao WhatsApp mensagens mais antigas das conversas já conhecidas, sem
  // precisar desconectar/reconectar o executivo. As mensagens novas chegam
  // depois, de forma assíncrona, pelo mesmo evento 'historico_sincronizado'
  // que já recarrega a lista de chats e a conversa aberta.
  function atualizarBotaoSincronizarHistorico() {
    const btn = el('btn-sincronizar-historico');
    const exec = estado.executivos.find((e) => e.id === estado.executivoAtivoId);
    btn.classList.toggle('oculto', !exec || exec.status !== 'conectado');
  }

  el('btn-sincronizar-historico').addEventListener('click', async () => {
    if (!estado.executivoAtivoId) return;
    const btn = el('btn-sincronizar-historico');
    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = 'Sincronizando…';
    try {
      await api(`/api/executivos/${estado.executivoAtivoId}/ressincronizar`, { method: 'POST' });
      btn.textContent = 'Solicitado — aguarde';
    } catch (err) {
      btn.textContent = 'Erro ao sincronizar';
    } finally {
      setTimeout(() => {
        btn.textContent = textoOriginal;
        btn.disabled = false;
      }, 4000);
    }
  });

  // ---------- comentários ----------
  // Comentários são anotações internas do gestor sobre uma conversa (não são
  // enviadas ao WhatsApp). Ficam guardadas para consulta depois, na hora de dar
  // um feedback pro executivo — por isso também dá pra ver todos os comentários
  // de todas as conversas dele de uma vez ("modo executivo").
  let modoComentarios = 'chat'; // 'chat' (conversa aberta) | 'executivo' (todas as conversas)

  function atualizarBotoesComentarios() {
    const exec = estado.executivos.find((e) => e.id === estado.executivoAtivoId);
    el('btn-comentarios-executivo').classList.toggle('oculto', !exec);
    el('btn-comentarios-chat').classList.toggle('oculto', !estado.chatAtivoId);
  }

  el('btn-comentarios-chat').addEventListener('click', () => abrirModalComentarios('chat'));
  el('btn-comentarios-executivo').addEventListener('click', () => abrirModalComentarios('executivo'));
  el('modal-comentarios-fechar').addEventListener('click', () => {
    el('modal-comentarios').classList.add('oculto');
  });

  async function abrirModalComentarios(modo) {
    modoComentarios = modo;
    el('form-comentario').classList.toggle('oculto', modo !== 'chat');
    el('lista-comentarios').innerHTML = '<div class="vazio">Carregando…</div>';
    el('modal-comentarios').classList.remove('oculto');

    if (modo === 'chat') {
      const chat = estado.chats.find((c) => c.id === estado.chatAtivoId);
      el('modal-comentarios-titulo').textContent =
        `Comentários — ${chat ? (chat.nome || chat.wa_chat_id.split('@')[0]) : 'conversa'}`;
      const comentarios = await api(`/api/comentarios/chat/${estado.chatAtivoId}`);
      renderComentarios(comentarios, false);
    } else {
      const exec = estado.executivos.find((e) => e.id === estado.executivoAtivoId);
      el('modal-comentarios-titulo').textContent =
        `Feedback — ${exec ? exec.nome : 'executivo'} (todos os comentários)`;
      const comentarios = await api(`/api/comentarios/executivo/${estado.executivoAtivoId}`);
      renderComentarios(comentarios, true);
    }
  }

  function renderComentarios(comentarios, mostrarConversa) {
    const lista = el('lista-comentarios');
    lista.innerHTML = '';
    if (comentarios.length === 0) {
      lista.innerHTML = '<div class="vazio">Nenhum comentário ainda</div>';
      return;
    }
    comentarios.forEach((c) => lista.appendChild(criarItemComentario(c, mostrarConversa)));
    if (modoComentarios === 'chat') lista.scrollTop = lista.scrollHeight;
  }

  function criarItemComentario(c, mostrarConversa) {
    const div = document.createElement('div');
    div.className = 'item-comentario';
    div.dataset.id = c.id;
    const meta = mostrarConversa
      ? `${escapeHtml(c.chat_nome || c.wa_chat_id.split('@')[0])} · ${formatarHora(c.created_at)}`
      : formatarHora(c.created_at);
    div.innerHTML = `
      <div class="comentario-cabecalho">
        <span class="comentario-meta">${meta}</span>
        <button type="button" class="comentario-excluir" title="Excluir comentário">✕</button>
      </div>
      <div class="comentario-texto">${escapeHtml(c.texto)}</div>
    `;
    return div;
  }

  el('lista-comentarios').addEventListener('click', async (e) => {
    const btn = e.target.closest('.comentario-excluir');
    if (!btn) return;
    const item = btn.closest('.item-comentario');
    if (!confirm('Excluir este comentário?')) return;
    await api(`/api/comentarios/${item.dataset.id}`, { method: 'DELETE' });
    item.remove();
    if (!el('lista-comentarios').children.length) {
      el('lista-comentarios').innerHTML = '<div class="vazio">Nenhum comentário ainda</div>';
    }
  });

  el('form-comentario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const textarea = el('novo-comentario-texto');
    const texto = textarea.value.trim();
    if (!texto || !estado.chatAtivoId) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const comentario = await api(`/api/comentarios/chat/${estado.chatAtivoId}`, {
        method: 'POST',
        body: JSON.stringify({ texto }),
      });
      textarea.value = '';
      const lista = el('lista-comentarios');
      if (lista.querySelector('.vazio')) lista.innerHTML = '';
      lista.appendChild(criarItemComentario(comentario, false));
      lista.scrollTop = lista.scrollHeight;
    } finally {
      btn.disabled = false;
    }
  });

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

  function renderChats(chatsParaExibir) {
    const chats = chatsParaExibir || estado.chats;
    const lista = el('lista-chats');
    lista.innerHTML = '';
    if (chats.length === 0) {
      lista.innerHTML = `<div class="vazio">${estado.termoBusca ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}</div>`;
      return;
    }
    chats.forEach((chat) => {
      const div = document.createElement('div');
      div.className = 'item-chat' + (chat.id === estado.chatAtivoId ? ' ativo' : '');
      const previewTexto = chat.trecho || chat.last_message_preview || '';
      div.innerHTML = `
        <div class="nome-chat">${destacarTermo(escapeHtml(chat.nome || chat.wa_chat_id.split('@')[0]))}</div>
        <span class="hora">${chat.last_message_at ? formatarHora(chat.last_message_at) : ''}</span>
        <div class="preview">${destacarTermo(escapeHtml(previewTexto))}</div>
      `;
      div.addEventListener('click', () => selecionarChat(chat));
      lista.appendChild(div);
    });
  }

  // ---------- busca de conversas ----------
  // Busca por palavra (no texto das mensagens ou no nome do contato) ou por
  // telefone (no wa_chat_id), num endpoint do backend — a lista carregada na
  // tela só tem a prévia da última mensagem, então pesquisar mensagens antigas
  // precisa consultar o banco.
  let buscaChatsTimeout = null;
  el('busca-chats-input').addEventListener('input', (e) => {
    clearTimeout(buscaChatsTimeout);
    const termo = e.target.value.trim();
    el('busca-chats-limpar').classList.toggle('oculto', !termo);
    buscaChatsTimeout = setTimeout(() => executarBuscaChats(termo), 300);
  });
  el('busca-chats-limpar').addEventListener('click', () => {
    el('busca-chats-input').value = '';
    el('busca-chats-limpar').classList.add('oculto');
    executarBuscaChats('');
  });

  async function executarBuscaChats(termo) {
    if (!estado.executivoAtivoId) return;
    estado.termoBusca = termo;
    if (!termo) {
      renderChats(estado.chats);
      return;
    }
    try {
      const resultados = await api(`/api/chats/buscar/${estado.executivoAtivoId}?q=${encodeURIComponent(termo)}`);
      renderChats(resultados);
    } catch (_) {
      // busca silenciosa — se falhar, mantém o que já estava na tela
    }
  }

  function destacarTermo(textoEscapado) {
    if (!estado.termoBusca) return textoEscapado;
    const termo = estado.termoBusca.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!termo) return textoEscapado;
    return textoEscapado.replace(new RegExp(`(${termo})`, 'ig'), '<mark>$1</mark>');
  }

  const LIMITE_MENSAGENS = 100;

  async function selecionarChat(chat) {
    estado.chatAtivoId = chat.id;
    // Ao abrir uma conversa (mesmo vindo de um resultado de busca), volta a lista
    // do meio pro estado normal — evita o resultado da busca "grudar" na tela.
    estado.termoBusca = '';
    el('busca-chats-input').value = '';
    el('busca-chats-limpar').classList.add('oculto');
    renderChats();
    el('titulo-chat').textContent = chat.nome || chat.wa_chat_id.split('@')[0];
    atualizarBotoesComentarios();
    estado.ultimoGrupoRemetente = null;
    const mensagens = await api(`/api/chats/${chat.id}/mensagens?limit=${LIMITE_MENSAGENS}`);
    const lista = el('lista-mensagens');
    lista.innerHTML = '';
    mensagens.forEach((m) => renderMensagem(m));
    estado.mensagemMaisAntigaTs = mensagens[0]?.wa_timestamp || null;
    estado.podeTerMaisAntigas = mensagens.length === LIMITE_MENSAGENS;
    atualizarBotaoCarregarAnteriores();
    rolarParaFinal();
  }

  el('btn-carregar-anteriores').addEventListener('click', carregarMensagensAnteriores);

  async function carregarMensagensAnteriores() {
    if (!estado.chatAtivoId || !estado.mensagemMaisAntigaTs) return;
    const btn = el('btn-carregar-anteriores');
    btn.disabled = true;
    btn.textContent = 'Carregando…';
    try {
      const mensagens = await api(
        `/api/chats/${estado.chatAtivoId}/mensagens?limit=${LIMITE_MENSAGENS}&before=${encodeURIComponent(estado.mensagemMaisAntigaTs)}`
      );
      const lista = el('lista-mensagens');
      const alturaAntes = lista.scrollHeight;
      // Insere no topo, mais antiga primeiro. A referência fica fixa no que hoje é a
      // primeira mensagem da tela — cada nova é colocada antes dela, na ordem certa.
      const referencia = lista.firstChild;
      estado.ultimoGrupoRemetente = null;
      mensagens.forEach((m, i) => renderMensagem(m, { antes: referencia, forcarCabecalho: i === mensagens.length - 1 }));
      if (mensagens.length > 0) {
        estado.mensagemMaisAntigaTs = mensagens[0].wa_timestamp;
      }
      estado.podeTerMaisAntigas = mensagens.length === LIMITE_MENSAGENS;
      // mantém a posição de leitura em vez de pular para o topo/fundo
      lista.scrollTop = lista.scrollHeight - alturaAntes;
    } finally {
      btn.disabled = false;
      atualizarBotaoCarregarAnteriores();
    }
  }

  function atualizarBotaoCarregarAnteriores() {
    const btn = el('btn-carregar-anteriores');
    btn.textContent = 'Carregar mensagens anteriores';
    btn.classList.toggle('oculto', !estado.podeTerMaisAntigas);
  }

  function renderMensagem(msg, opts = {}) {
    const lista = el('lista-mensagens');
    const chaveGrupo = msg.from_me ? 'me' : (msg.sender_number || msg.sender_name || 'outro');
    const mesmoGrupo = !opts.forcarCabecalho && estado.ultimoGrupoRemetente === chaveGrupo;
    estado.ultimoGrupoRemetente = chaveGrupo;

    const div = document.createElement('div');
    div.className = 'bolha ' + (msg.from_me ? 'enviada' : 'recebida') + (mesmoGrupo ? ' seguida' : ' nova-origem');

    let corpo = '';
    if (!msg.from_me && !mesmoGrupo) {
      corpo += `<div class="remetente">${escapeHtml(msg.sender_name || msg.sender_number || '')}</div>`;
    }
    corpo += renderConteudo(msg);
    corpo += `<div class="hora-msg">${formatarHora(msg.wa_timestamp)}</div>`;
    div.innerHTML = corpo;

    if (opts.antes) {
      lista.insertBefore(div, opts.antes);
    } else {
      lista.appendChild(div);
    }

    // Imagens/vídeos só ganham altura real depois de carregar — sem isso, a rolagem
    // para o final acontece cedo demais e mensagens mais novas ficam escondidas
    // abaixo da mídia. Reancora no fundo quando a mídia carrega, mas só se o usuário
    // já estava lendo o final (senão atrapalharia quem rolou pra cima pra ler antigas).
    if (!opts.antes) {
      div.querySelectorAll('img, video').forEach((media) => {
        const evento = media.tagName === 'VIDEO' ? 'loadedmetadata' : 'load';
        const aoCarregar = () => {
          if (estaPertoDoFinal(lista)) rolarParaFinal();
        };
        media.addEventListener(evento, aoCarregar, { once: true });
        media.addEventListener('error', aoCarregar, { once: true });
      });
    }
  }

  function estaPertoDoFinal(lista) {
    return lista.scrollHeight - lista.scrollTop - lista.clientHeight < 150;
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
