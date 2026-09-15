# Allm4 License Server

Servidor responsável por pagamentos, licenças e ativações do Allm4.

## Stack inicial

- Node.js
- Express
- Vercel
- Mercado Pago (próxima etapa)
- Banco de dados (próxima etapa)

## Desenvolvimento local

```bash
npm install
npm run dev
```

Servidor local: `http://127.0.0.1:3000`

Health check: `GET /api/health`

## Variáveis de ambiente

Copie `.env.example` para `.env` apenas no ambiente local. Nunca envie segredos reais para o GitHub.

## Segurança inicial

- Cabeçalho `X-Powered-By` desabilitado
- Helmet habilitado
- Corpo JSON limitado a 32 KB
- Segredos mantidos fora do repositório
