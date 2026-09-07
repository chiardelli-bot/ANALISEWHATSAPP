# Monitor de Conversas WhatsApp (somente leitura)

Painel para acompanhar, em tempo real, as conversas de WhatsApp de vários executivos — cada um usando o próprio número no celular corporativo, pareado via QR code. **A ferramenta nunca envia mensagens**, apenas lê e guarda o histórico (texto, imagens, áudios, vídeos e documentos).

## Como funciona

- Cada executivo é uma "sessão" independente (biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys), a mesma usada pelo WhatsApp Web).
- Você adiciona um executivo no painel, aparece um QR code, e alguém escaneia esse QR no **celular corporativo** dele (WhatsApp → Aparelhos conectados → Conectar um aparelho) — igual a logar no WhatsApp Web.
- A partir daí, toda mensagem que passa por aquele número (enviada ou recebida) é salva no banco e aparece no painel em tempo real.
- No painel você troca de executivo pela barra lateral, escolhe a conversa e lê o histórico.

## Por que precisa de um servidor de verdade (não roda "na nuvem do chat")

Para continuar recebendo mensagens, cada uma das 12 sessões precisa ficar **conectada 24 horas por dia**. Isso exige:
1. Um processo Node.js rodando continuamente (não uma execução pontual).
2. Um **volume de disco persistente** para guardar as credenciais de login do WhatsApp (`AUTH_DIR`) e a mídia baixada (`MEDIA_DIR`) — se esses arquivos se perderem, é preciso escanear o QR de novo.
3. Um banco Postgres para o histórico de conversas.

## Deploy recomendado: Railway

1. Crie uma conta em [railway.app](https://railway.app) e um novo projeto.
2. Suba este código para um repositório no GitHub e conecte o repositório ao projeto Railway (ou use `railway up` pela CLI a partir desta pasta).
3. Adicione um serviço **PostgreSQL** pelo botão "New" → "Database" → "PostgreSQL". O Railway cria automaticamente a variável `DATABASE_URL` — no serviço da aplicação, referencie-a (`${{Postgres.DATABASE_URL}}`) ou copie o valor.
4. No serviço da aplicação, adicione um **Volume** (aba "Volumes") montado em `/data`.
5. Configure as variáveis de ambiente do serviço (aba "Variables"):
   ```
   DATABASE_URL=<a do serviço Postgres>
   SESSION_SECRET=<gere uma string aleatória longa>
   ADMIN_USER=lucas
   ADMIN_PASS=<escolha uma senha forte>
   AUTH_DIR=/data/auth
   MEDIA_DIR=/data/media
   ```
   (`PORT` o Railway define sozinho.)
6. Deploy. O Railway detecta o `package.json` e roda `npm install && npm start` automaticamente.
7. Gere um domínio público (aba "Settings" → "Networking" → "Generate Domain") e acesse.

Render funciona de forma equivalente (Web Service + PostgreSQL + Persistent Disk montado em `/data`), caso prefira.

## Primeiro uso

1. Acesse a URL pública, faça login com `ADMIN_USER` / `ADMIN_PASS`.
2. Clique em "+" na barra lateral, dê o nome do executivo, e um QR code aparece na hora.
3. Peça para o executivo escanear o QR **no celular corporativo dele** (WhatsApp → Aparelhos conectados → Conectar um aparelho). Assim que conectar, o status vira "Conectado" e as conversas começam a aparecer.
4. Repita para os outros 11 executivos.
5. Para trocar de executivo, basta clicar em outro nome na barra lateral — cada um guarda seu próprio histórico de conversas.

Se um executivo trocar de celular ou fizer logout do WhatsApp, o status muda para "Desconectado" e basta clicar nele de novo para gerar um novo QR.

## Rodando localmente para testar

```bash
cp .env.example .env      # edite com um Postgres local
npm install
npm start
```
Acesse `http://localhost:3000`.

## Um ponto de atenção (não é conselho jurídico)

Isso está usando a API não-oficial do WhatsApp (Baileys), o que tecnicamente viola os Termos de Serviço do WhatsApp — existe risco de o número corporativo ser banido, mesmo sendo um uso legítimo de monitoramento interno. Também vale avisar formalmente os executivos de que as conversas feitas no aparelho corporativo são monitoradas, por transparência e para se resguardar em relação à LGPD.

## Estrutura do projeto

```
src/
  server.js              # servidor Express + Socket.IO + autenticação
  db.js                  # schema e conexão Postgres
  baileys/sessionManager.js  # abre/mantém as sessões do WhatsApp, salva mensagens
  routes/                # endpoints REST (auth, executivos, chats/mensagens)
public/                  # painel (HTML/CSS/JS puro, sem build step)
```

## Limitações desta primeira versão

- Histórico anterior à conexão do QR não é importado (o WhatsApp só entrega mensagens novas a partir do pareamento).
- Sem busca textual dentro das conversas (fácil de adicionar depois).
- Login único de gestor (sem múltiplos usuários) — como pedido.
