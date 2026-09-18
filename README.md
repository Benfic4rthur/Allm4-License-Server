# Allm4 License Server

Servidor responsável por pagamentos, licenças e ativações do Allm4.

## Stack

- Node.js
- Express
- PostgreSQL / Neon
- Vercel
- Mercado Pago (fase futura)

## Desenvolvimento local

```bash
npm install
npm run dev
```

Servidor local: `http://127.0.0.1:3000`

Health checks:

- `GET /api/health`
- `GET /api/health/db`

## Variáveis de ambiente

Copie `.env.example` para `.env` apenas no ambiente local. Nunca envie segredos reais para o GitHub.

Variáveis usadas pela camada de licenciamento:

- `DATABASE_URL`: conexão PostgreSQL
- `ADMIN_SECRET`: protege rotas administrativas
- `LICENSE_HASH_SECRET`: segredo usado em HMAC-SHA-256 para licenças, dispositivos e IPs de auditoria

`ADMIN_SECRET` e `LICENSE_HASH_SECRET` devem usar valores aleatórios independentes com pelo menos 32 caracteres.

`LICENSE_PRIVATE_KEY` e `LICENSE_PUBLIC_KEY` estão reservadas para a próxima fase, assinatura de licença offline.

## API de licenças

### Criar licença de desenvolvimento

`POST /api/admin/licenses`

Proteção: header `X-Admin-Secret` ou `Authorization: Bearer <secret>`.

Body opcional:

```json
{
  "max_devices": 3
}
```

A chave completa é retornada apenas na criação. O banco armazena somente o HMAC da chave.

### Ativar dispositivo

`POST /api/licenses/activate`

```json
{
  "license_key": "ALLM4-....",
  "device_id": "uuid-persistente-da-instalacao",
  "device_name": "MacBook",
  "platform": "darwin-arm64"
}
```

A ativação respeita `licenses.max_devices`. Ativações concorrentes da mesma licença são serializadas no banco para impedir ultrapassar o limite.

### Validar dispositivo

`POST /api/licenses/validate`

Usa o mesmo formato de body da ativação. Atualiza `last_seen_at` e registra auditoria.

### Desativar dispositivo

`POST /api/licenses/deactivate`

```json
{
  "license_key": "ALLM4-....",
  "device_id": "uuid-persistente-da-instalacao"
}
```

A desativação libera uma vaga da licença e é idempotente.

### Revogar licença

`POST /api/admin/licenses/:licenseId/revoke`

Proteção administrativa obrigatória.

Body opcional:

```json
{
  "reason": "motivo da revogacao"
}
```

## Auditoria

As operações relevantes gravam eventos na tabela `activations` com os tipos já previstos no schema: `activated`, `validated`, `deactivated`, `rejected` e `revoked`.

Nunca são gravados em texto puro:

- chave de licença
- `device_id`
- IP de auditoria

## Segurança atual

- Cabeçalho `X-Powered-By` desabilitado
- Helmet habilitado
- Corpo JSON limitado a 32 KB
- Queries parametrizadas
- Rotas administrativas protegidas por segredo
- Chaves e identificadores persistidos como HMAC-SHA-256
- Limite de dispositivos aplicado dentro de transação PostgreSQL
- Segredos mantidos fora do repositório

## Validação

```bash
npm run check
npm test
```

O GitHub Actions executa as duas validações em pull requests e na branch `main`.


## API de bugs

O servidor também recebe relatórios técnicos do aplicativo e mantém a linha do tempo de atendimento.

Rotas públicas:

- POST /api/bugs: cria um relatório e devolve um tracking_token de uso único para aquela instalação
- GET /api/bugs/:bugId?tracking_token=...: consulta apenas o estado público do relatório

Rotas do Mac mantenedor:

- GET /api/admin/bugs/queue
- POST /api/admin/bugs/:bugId/claim
- PATCH /api/admin/bugs/:bugId

Essas rotas exigem BUG_MAINTAINER_SECRET.

Segredos adicionais:

- BUG_REPORT_SECRET: HMAC dos tokens privados de acompanhamento. Se ausente, usa LICENSE_HASH_SECRET.
- BUG_MAINTAINER_SECRET: autenticação do serviço interno que roda somente no Mac do mantenedor. Se ausente, usa ADMIN_SECRET.

Os relatórios removem padrões comuns de token/senha antes de persistir os diagnósticos. O tracking_token completo não é armazenado no banco.
