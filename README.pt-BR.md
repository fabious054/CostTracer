# CostTracer

🇧🇷 Português (este arquivo) | 🇺🇸 [Read in English](README.md)

> Ferramenta local-first de visibilidade de custos AWS. Rastreia recursos ociosos ao longo do tempo para confirmar desperdício real — somente leitura, nenhuma credencial sai da sua máquina.

🚧 **Status:** Em desenvolvimento inicial — trabalhando atualmente no **Escopo 1: fluxo de conexão com a AWS**. Ainda sem release funcional.

---

## O Problema

Em ambientes de nuvem, o desperdício financeiro é silencioso e cumulativo. Desenvolvedores e times de infraestrutura frequentemente criam recursos para testes ou demandas temporárias — discos não anexados, endereços de IP estáticos, gateways de rede, retenção de logs — e esquecem de desativá-los. O resultado são centenas ou milhares de dólares queimados todo mês antes que alguém perceba o impacto na fatura.

A maioria das ferramentas existentes exige colar credenciais AWS numa plataforma web de terceiros (SaaS), algo que muitas empresas proíbem expressamente por questões de compliance e governança. Isso é um bloqueio real de adoção, não só uma preferência.

## A Solução

O CostTracer é uma aplicação desktop que audita sua conta AWS em busca de recursos ociosos e desperdício, rodando **100% localmente** na sua máquina. Ele inspeciona sua conta, sinaliza possíveis desperdícios, estima o custo acumulado e — o mais importante — **confirma esse desperdício ao longo do tempo** antes de você agir sobre ele. Nenhuma credencial, dado de conta ou telemetria sai do seu computador.

### Os três pilares

1. **Coletor** — fala com a AWS, somente leitura, coleta o estado atual dos recursos.
2. **Histórico** — persiste o que foi observado ao longo do tempo, transformando uma "suspeita" pontual em um padrão confirmado.
3. **Confiança** — mostra o quão certa a ferramenta está de que algo é desperdício, com base no histórico acumulado, em linguagem clara para o usuário confiar.

A maioria das ferramentas do mercado cobre só o item 1. O CostTracer é desenhado em torno dos três pilares desde o início.

## Por que local-first

- Sem cadastro, sem conta externa, sem servidor guardando seus dados.
- Usa credenciais que você fornece ou já tem configuradas — você escolhe como: detecção automática de configuração AWS local, entrada manual de Access Key, ou SSO. Nada precisa estar pré-instalado na sua máquina.
- Toda credencial é verificada quanto a permissões excessivas antes do uso, com uma policy IAM mínima recomendada pronta pra copiar — veja [`docs/iam-policy-minimal.json`](docs/iam-policy-minimal.json).
- A v1 é inteiramente **somente leitura**. Nenhuma ação de escrita ou exclusão existe nesta fase.

## Stack Técnica

- **Core:** Rust + Tauri v2 — performance nativa, baixo consumo de memória, sem navegador embutido.
- **Interface:** Angular + TypeScript — dashboards e tabelas interativas, tipadas e estruturadas.
- **Armazenamento:** local, sem backend na nuvem.

## Roadmap

- **Fase 0 — Visibilidade honesta** *(atual)*: scan somente leitura, custo estimado, mecanismo de confirmação temporal (um recurso precisa aparecer como ocioso em múltiplos scans antes de ser marcado como desperdício confirmado). Sem ações de escrita.
- **Fase 1 — Confiabilidade e abrangência**: mais tipos de recurso, suporte multi-região, sistema de exceções/allowlist (ex: exclusões baseadas em tag) para reduzir falsos positivos.
- **Fase 2 — Ação assistida**: simulação dry-run opcional e, eventualmente, execução controlada — começando apenas pelos tipos de recurso em que a camada de confiança mais confia.
- **Fase 3 — Multi-conta**: relevante para organizações que usam AWS Organizations; não é prioridade no curto prazo.

## Modelo de Segurança

O CostTracer segue uma abordagem zero-trust por design:

- Nunca exige permissões de escrita na Fase 0.
- Valida a identidade conectada via `sts:GetCallerIdentity`.
- Verifica credenciais com permissões excessivas e alerta o usuário, oferecendo uma policy IAM mínima pronta pra copiar e aplicar.
- Armazena qualquer credencial no cofre nativo e seguro do sistema operacional (Keychain / Credential Manager / Secret Service) — nunca em texto plano.

## Licença

MIT — veja [LICENSE](LICENSE) para detalhes.
