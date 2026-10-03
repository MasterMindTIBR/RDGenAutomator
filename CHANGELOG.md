# Changelog

This project does not use version numbers. Entries are grouped by date.

## 2026-10-03

Primeira versão pública.

- Painel web multiusuário para gerar, acompanhar e distribuir clientes RustDesk personalizados através do RDGen.
- Autenticação por sessão e autorização sempre validada no servidor; solicitações nascem privadas e podem ser publicadas.
- Presets de comportamento/permissões desacoplados de identidade visual (nome, ícone, logo, tela de privacidade).
- Plataformas livres por solicitação, versão única do RustDesk, senha permanente opcional com override por perfil (Full/QS).
- Jobs duráveis por combinação perfil × plataforma, com máquina de estados e reconciliação manual quando a resposta do RDGen se perde.
- Validação e retenção automática dos artefatos baixados.
- Templates de deploy prontos para PM2 e Docker Compose.
- Interface do operador em TanStack Start, consumindo a API real através de um proxy same-origin.
