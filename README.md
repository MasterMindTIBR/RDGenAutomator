# RDGen Automator

Painel web multiusuário para gerar, acompanhar e distribuir clientes RustDesk personalizados através do [RDGen](https://github.com/bryangerlach/rdgen).

O RDGen tem sua própria interface web, mas ela é pensada para um build manual por vez: sem histórico, sem reuso de configuração entre clientes, sem controle de quem pode baixar o quê. O RDGen Automator existe para cobrir exatamente essa lacuna operacional — um operador define servidor RustDesk, preset de comportamento, identidade visual, senha e plataformas uma vez, e o sistema cuida do resto: expande a solicitação em jobs duráveis, conduz o RDGen pelo seu próprio fluxo, baixa e valida os artefatos, e preserva tudo com controle de acesso e retenção.

## Recursos

- **Multiusuário com controle de acesso real** — sessões de servidor, sem troca de persona no cliente. Solicitações nascem privadas e podem ser publicadas para os demais usuários autenticados.
- **Presets e identidade visual desacoplados** — um preset define comportamento e permissões (teclado, área de transferência, modo de aprovação...); uma identidade visual define marca (nome, ícone, logo, tela de privacidade). Combine como quiser por solicitação.
- **Senha permanente opcional**, com possibilidade de senha diferente por perfil (Full/QS).
- **Plataformas e versão livres** — sem lista fixa de combinações permitidas; marque as plataformas desejadas e escolha a versão do RustDesk entre as releases conhecidas do RDGen.
- **Jobs duráveis com máquina de estados** — cada combinação perfil × plataforma vira um job rastreável, com histórico de tentativas e reconciliação manual quando a resposta do RDGen se perde.
- **Artefatos com validação e retenção** — os binários baixados são validados antes de ficarem disponíveis, e expiram segundo uma política configurável.
- **Deploy pronto** — templates de PM2 e Docker Compose inclusos, sem necessidade de infraestrutura adicional além de PostgreSQL e Redis.

## Componentes

- `apps/web`: TanStack Start. Interface e proxy same-origin para a API.
- `apps/api`: NestJS. Autenticação, administração, solicitações, autorização e downloads.
- `apps/worker`: BullMQ. Jobs RDGen, polling, retries, reconciliação, artefatos e retenção.
- `packages/domain`: schemas, criptografia, máquina de estados e demais tipos compartilhados, sem dependência de framework.
- PostgreSQL: estado, auditoria, configurações criptografadas e outbox.
- Redis: fila BullMQ e limitação de login.
- `storage/`: logos e artefatos protegidos no volume local.

## Controle de acesso

O administrador cadastra usuários, configurações de servidor RustDesk, presets Full/QS, identidades visuais e política de retenção.

Cada solicitação seleciona um servidor RustDesk cadastrado. Você pode reutilizar uma configuração em várias solicitações ou selecionar outra para cada cliente. O sistema armazena a configuração do servidor criptografada e vincula a escolha à solicitação. Os parâmetros de conexão do servidor (host, porta, chave pública etc.) não são tratados como segredo na interface: o mesmo conteúdo já vai embarcado em todo cliente RustDesk distribuído, então administradores veem e editam esses valores em texto claro. A criptografia em repouso protege o banco de dados, não esconde esses dados de quem administra.

Solicitações começam privadas. O autor e administradores podem acessá-las. Ao publicar uma solicitação, todos os usuários autenticados podem consultar seus jobs e downloads locais.

## Desenvolvimento local

Requisitos: Node.js 22, Corepack/pnpm 9, Docker e Docker Compose.

```bash
cp .env.example .env
pnpm env:generate
docker compose up -d postgres redis
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

`pnpm env:generate` cria chaves e credenciais de desenvolvimento em `.env`. Não use esse comando em produção: mantenha `APP_ENCRYPTION_KEY` e `APP_ENCRYPTION_KEY_ID` estáveis. A perda da chave impede a leitura dos segredos já armazenados.

Verificação local completa:

```bash
pnpm typecheck
pnpm dev:smoke
pnpm test:authorization
pnpm test:requests
pnpm test:worker
pnpm test:artifacts
pnpm test:web
```

Veja `AGENTS.md` para o mapa completo do modelo de dados, dos fluxos internos e de todos os comandos de teste disponíveis.

## RDGen e segredos

O worker usa um adaptador HTTP para o RDGen público. Um build produtivo envia senha permanente, chave RustDesk e identidade visual ao RDGen. Confirme essa exposição antes de criar solicitações produtivas.

A aplicação protege cópias locais e downloads autorizados. URLs externas do RDGen e GitHub Actions podem ser capacidades públicas; o painel as limita ao autor e administradores, com aviso explícito. Ocultar uma solicitação remove acesso pelo painel, mas não invalida uma URL externa já compartilhada.

## Jobs

Um job representa um perfil e uma plataforma. Estados principais:

`rascunho → enfileirado → iniciando → aguardando_rdgen → baixando → validando → concluído`

Se a resposta do RDGen se perde após o envio, o job entra em `início_indeterminado`. O sistema não reenvia automaticamente. O autor ou administrador reconcilia a tentativa ou confirma o risco de um novo build externo.

## Operação

- Use `pnpm encryption:rotate` para rotacionar a chave de criptografia.
- Execute migrações antes de atualizar API ou worker.
- Não exponha `storage/`, `.env` ou PostgreSQL diretamente pela web.
- O endpoint `/health` verifica PostgreSQL, Redis, armazenamento, criptografia e heartbeat do worker.

## Deploy com PM2

Use PM2 quando PostgreSQL e Redis forem serviços gerenciados separadamente e os três processos da aplicação forem executados no host. Instale as dependências de produção no monorepo, forneça as variáveis de runtime (ou um `.env` de produção no diretório raiz) e execute as migrações antes de iniciar os serviços:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pm2 start ecosystem.config.cjs --env production
pm2 save
```

O template cria os processos estáveis `rdgen-web`, `rdgen-api` e `rdgen-worker`. Ele usa os scripts existentes dos workspaces e mantém os serviços em `127.0.0.1`; publique apenas o web por um proxy reverso. Forneça `DATABASE_URL`, `REDIS_URL`, `APP_STORAGE_PATH`, `APP_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY_ID` e `API_BASE_URL`. Nunca execute `pnpm env:generate` em produção e mantenha a chave de criptografia estável.

## Deploy com Docker Compose

`compose.production.yaml` é uma pilha completa: web, API, worker, PostgreSQL, Redis e um volume protegido compartilhado por API e worker. O arquivo `compose.yaml` continua sendo somente o ambiente local de PostgreSQL/Redis.

Crie um arquivo de ambiente de produção fora do repositório (ou em um gerenciador de segredos) com valores reais, por exemplo:

```dotenv
POSTGRES_DB=rdgen_automator
POSTGRES_USER=rdgen
POSTGRES_PASSWORD=use-uma-senha-forte
APP_ENCRYPTION_KEY=base64-canonico-de-32-bytes
APP_ENCRYPTION_KEY_ID=production-2026-01
APP_PUBLIC_URL=https://painel.example.com
WEB_HOST_PORT=3000
```

Suba a pilha informando esse arquivo. A migração é executada uma vez e deve terminar com sucesso antes de API e worker iniciarem:

```bash
docker compose --env-file /caminho/seguro/rdgen.production.env -f compose.production.yaml up -d --build
docker compose --env-file /caminho/seguro/rdgen.production.env -f compose.production.yaml ps
```

Somente a porta web é publicada por padrão. PostgreSQL e Redis permanecem acessíveis apenas na rede interna do Compose. API e worker compartilham `/var/lib/rdgen/storage` no volume `protected-storage`; não monte nem publique esse volume por um servidor web. Coloque um proxy TLS em frente à porta web e defina `APP_PUBLIC_URL` como a URL HTTPS pública para que os cookies de sessão sejam marcados como seguros.

## Licença

AGPLv3 — veja [`LICENSE`](./LICENSE). Resumo prático: você pode usar, estudar, modificar e redistribuir livremente. Se você rodar uma versão modificada deste painel como serviço acessível pela rede, a AGPL exige que o código-fonte dessa versão modificada seja disponibilizado aos usuários do serviço (seção 13 da licença) — isso vale mesmo sem redistribuir o binário, diferente da GPL comum.

## Créditos

RDGen Automator foi criado por [Jung](https://github.com/junglivre). O projeto é hospedado na organização [MasterMindTI](https://github.com/MasterMindTIBR) no GitHub.

Integra-se ao [RDGen](https://github.com/bryangerlach/rdgen) e referencia o protocolo documentado pelo [rdgen-cli](https://github.com/AlekseyLapunov/rdgen-cli) para automatizar o que, de outra forma, seria feito manualmente pela interface web do RDGen. Não há afiliação com o RustDesk nem com os mantenedores do RDGen.
