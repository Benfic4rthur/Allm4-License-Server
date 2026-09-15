# Allm4 License Server

Servidor responsavel por pagamentos, licencas e ativacoes do Allm4.

## Stack

- Node.js
- Express
- PostgreSQL / Neon
- Vercel
- Mercado Pago (etapa futura)

## Desenvolvimento local

```bash
npm install
npm run dev
```

Servidor local: `http://127.0.0.1:3000`

Health checks:

- `GET /api/health`
- `GET /api/health/db`

## Licenciamento atual

A camada central de licencas ja suporta:

- geracao de chave aleatoria forte no formato `ALLM4-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
- armazenamento somente do SHA-256 normalizado da chave
- hash SHA-256 do identificador de instalacao antes de persistir
- ativacao com limite de dispositivos por licenca
- validacao de dispositivo ja ativado
- desativacao e reativacao de dispositivo
- revogacao administrativa de licenca
- auditoria em `activations`
- serializacao de ativacoes por licenca para impedir ultrapassar o limite em requisicoes concorrentes

### Rotas publicas

- `POST /api/licenses/activate`
- `POST /api/licenses/validate`
- `POST /api/licenses/deactivate`

Corpo de ativacao:

```json
{
  "license_key": "ALLM4-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "device_id": "installation-uuid",
  "device_name": "MacBook",
  "platform": "darwin-arm64"
}
```

Validacao e desativacao usam `license_key` e `device_id`.

### Rotas administrativas

As rotas administrativas exigem `ADMIN_SECRET` via cabecalho `X-Admin-Secret` ou `Authorization: Bearer`.

- `POST /api/admin/licenses`
- `POST /api/admin/licenses/:licenseId/revoke`

Criacao de licenca aceita opcionalmente:

```json
{
  "max_devices": 3
}
```

A chave completa e retornada somente na criacao. O banco armazena apenas o hash.

## Variaveis de ambiente

Copie `.env.example` para `.env` apenas no ambiente local. Nunca envie segredos reais para o GitHub.

Obrigatorias para a fase atual:

- `DATABASE_URL`
- `ADMIN_SECRET` para usar rotas administrativas

Reservadas para as proximas fases:

- `MERCADO_PAGO_ACCESS_TOKEN`
- `MERCADO_PAGO_WEBHOOK_SECRET`
- `LICENSE_PRIVATE_KEY`
- `LICENSE_PUBLIC_KEY`

## Validacao

```bash
npm run check
npm test
```

## Seguranca inicial

- `X-Powered-By` desabilitado
- Helmet habilitado
- corpo JSON limitado a 32 KB
- respostas `/api` com `Cache-Control: no-store`
- queries parametrizadas
- segredo administrativo fora do repositorio
- comparacao do segredo administrativo em tempo constante
- chaves de licenca e device IDs nunca persistidos em texto puro
