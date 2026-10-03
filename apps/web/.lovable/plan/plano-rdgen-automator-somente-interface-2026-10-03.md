# Plano — RDGen Automator (somente interface)

## Objetivo
Construir um painel privado demonstrável para criação, acompanhamento e administração de builds RustDesk, com todas as operações simuladas localmente. Não haverá autenticação real, chamadas ao RDGen, API, banco de dados nem persistência após recarregar o navegador.

## Experiência e navegação
- Aplicar um único tema escuro profundo, com acento principal e cores/ícones distintos para sucesso, falha, aviso e andamento. Layout denso e legível, sidebar fixa à esquerda no desktop e navegação adaptada para telas menores.
- Implementar login visual com troca entre persona administradora e comum; qualquer credencial preenchida entra na demonstração. O papel selecionado determina quais telas e controles aparecem, sem representar proteção real.
- Criar páginas próprias para Dashboard, Nova solicitação, Detalhe da solicitação e, na seção Administração, Usuários, Servidores RustDesk, Presets, Metas de build, Retenção e armazenamento e Saúde do sistema. Usuários comuns veem apenas Dashboard e Nova solicitação.
- Usar transições rápidas entre páginas, entradas sutis em listas e microinterações consistentes, com respeito à preferência por movimento reduzido.

## Fluxos principais
1. **Dashboard:** busca por nome, filtros de autor, status, visibilidade e período; lista compacta com identidade, perfis, plataformas, estado agregado, autor, visibilidade e atualização; loading e estado vazio.
2. **Nova solicitação:** fluxo bem seccionado para identidade e servidor; seleção clara de Full/QS e respectivos presets com prévia legível; checkboxes livres de plataforma×versão; uploads PNG separados para ícone, logo obrigatório no mock e tela de privacidade; senha permanente mascarada; revisão da matriz perfil×alvo, nomes resultantes e diferenças entre presets. Antes de confirmar, explicar que senha e identidade visual seriam enviadas ao RDGen no uso real. Depois de criar, não exibir a senha em nenhum detalhe ou fixture persistida no store.
3. **Detalhe:** uma linha por job da matriz, distinguindo visualmente todos os **12 estados listados** no documento (a lista nominal prevalece sobre a contagem de 11 no checklist); progresso, horários, tentativa atual e histórico expansível. Downloads simulados por arquivos locais; múltiplos artefatos e resultado parcial. Publicar/ocultar somente como autor/admin; links externos de status/Actions só para autor/admin, identificados como externos e abertos em nova aba sem referrer mediante aviso claro. Reconciliar início indeterminado, retry com confirmação de risco de duplicação e cancelar apenas nos estados aplicáveis.
4. **Administração:** usuários com criação/desativação confirmada; servidores com dados operacionais visíveis, edição e bloqueio de exclusão quando em uso; presets Full/QS com versão, formulário seccionado completo e grade de permissões, incluindo três imagens padrão que podem ser herdadas ou substituídas; metas de build com inclusão/remoção; retenção editável; saúde com indicadores e última verificação.

## Dados e comportamento simulado
- Isolar fixtures e implementações de operações em `src/mock/`; expor uma interface estável de acesso por um provider/hook separado, sem importação de fixture por telas. Inicializar o estado em memória a partir de dados exemplares que mostrem solicitações privadas/publicadas, estados de jobs variados, tentativas e artefatos.
- Simular 200–500 ms de latência por operação para loading/skeleton e feedback visual; criar, editar, publicar, ocultar, reconciliar, tentar novamente, cancelar, desativar, excluir e baixar devem atualizar a experiência de forma coerente durante a sessão.
- Validar campos do formulário e uploads PNG no navegador. Os downloads da demo serão gerados localmente, sem buscar URLs externas. Links externos de acompanhamento, quando presentes na fixture, só serão abertos por ação explícita do operador; nenhum fluxo fará requisição automática.

## Implementação técnica
- Aproveitar a estrutura React/TanStack Start já presente, com páginas em rotas próprias, componentes de interface reutilizáveis e tokens semânticos de cor no tema global. Adicionar Motion para React (Framer Motion) para as animações pedidas.
- Manter a camada de mock substituível no futuro, sem criar serviços de servidor nesta rodada. Adicionar metadados próprios às páginas de conteúdo e preservar o funcionamento da raiz como entrada real do painel.
- Verificar o fluxo de ponta a ponta em ambas as personas: login, criação com dois perfis e múltiplas plataformas, visualização da matriz e dos downloads, ações por estado e operações administrativas. Conferir ausência de requisições de dados externas e renderização em desktop e mobile.
