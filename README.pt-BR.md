# CostTracer

🇧🇷 Português (este arquivo) | 🇺🇸 [Read in English](README.md)

> Ferramenta local-first de visibilidade de custos AWS. Rastreia recursos ociosos ao longo do tempo para confirmar desperdício real — somente leitura, nenhuma credencial sai da sua máquina.

🚧 **Status:** Em desenvolvimento ativo — **Fase 0**. Dois escopos estão fechados e com tag:

- **`v0.1.0-scope1` — Fluxo de conexão com a AWS.** Conexão via configuração AWS local detectada automaticamente, entrada manual de access key, ou autorização por dispositivo do IAM Identity Center (SSO). Toda identidade é verificada quanto a permissões excessivas antes do uso; credenciais ficam no cofre nativo do sistema, nunca em texto plano.
- **`v0.2.0-scope2` — Detectores de recursos ociosos.** Volumes EBS não anexados, Elastic IPs ociosos e snapshots órfãos, com histórico local de scans (SQLite) e uma escala de confiança de quatro níveis (Observado → Persistindo → Provável → Confirmado) que sobe quanto mais tempo um recurso permanece ocioso ao longo dos scans. Todo recurso sinalizado traz uma explicação em linguagem clara; qualquer recurso pode ser marcado como *intencional* — um marcador puramente local, a ferramenta nunca escreve na AWS.

Essas tags marcam escopos fechados, não downloads empacotados — ainda não há instalador. Rode a partir do código: `npm install` e depois `npm run tauri:dev`. A estimativa de custo e o restante da Fase 0 continuam em aberto (ver Roadmap).

---

## O Problema

Em ambientes de nuvem, o desperdício financeiro é silencioso e cumulativo. Desenvolvedores e times de infraestrutura frequentemente criam recursos para testes ou demandas temporárias — discos não anexados, endereços de IP estáticos, gateways de rede, retenção de logs — e esquecem de desativá-los. O resultado são centenas ou milhares de dólares queimados todo mês antes que alguém perceba o impacto na fatura.

A maioria das ferramentas existentes exige colar credenciais AWS numa plataforma web de terceiros (SaaS), algo que muitas empresas proíbem expressamente por questões de compliance e governança. Isso é um bloqueio real de adoção, não só uma preferência.

## A Solução

O CostTracer é uma aplicação desktop que audita sua conta AWS em busca de recursos ociosos e desperdício, rodando **100% localmente** na sua máquina. Ele inspeciona sua conta, sinaliza possíveis desperdícios e — o mais importante — **confirma esse desperdício ao longo do tempo** antes de você agir sobre ele. Estimar o custo acumulado de cada achado é a próxima peça da Fase 0. Nenhuma credencial, dado de conta ou telemetria sai do seu computador.

### Os três pilares

1. **Coletor** — fala com a AWS, somente leitura, coleta o estado atual dos recursos.
2. **Histórico** — persiste o que foi observado ao longo do tempo, transformando uma "suspeita" pontual em um padrão confirmado.
3. **Confiança** — mostra o quão certa a ferramenta está de que algo é desperdício, com base no histórico acumulado, em linguagem clara para o usuário confiar.

A maioria das ferramentas do mercado cobre só o item 1. O CostTracer é desenhado em torno dos três pilares desde o início — no build atual, os três já estão no lugar: o coletor (três detectores), o histórico (um log SQLite local de cada observação) e a camada de confiança (uma escala de quatro níveis calculada a partir desse histórico).

## Por que local-first

- Sem cadastro, sem conta externa, sem servidor guardando seus dados.
- Usa credenciais que você fornece ou já tem configuradas — você escolhe como: detecção automática de configuração AWS local, entrada manual de Access Key, ou SSO. Nada precisa estar pré-instalado na sua máquina.
- Toda credencial é verificada quanto a permissões excessivas antes do uso, com uma policy IAM mínima recomendada pronta pra copiar — veja [`docs/iam-policy-minimal.json`](docs/iam-policy-minimal.json).
- A v1 é inteiramente **somente leitura**. Nenhuma ação de escrita ou exclusão existe nesta fase.

## Stack Técnica

- **Core:** Rust + Tauri v2 — performance nativa, baixo consumo de memória, sem navegador embutido.
- **Interface:** Angular + TypeScript — dashboards e tabelas interativas, tipadas e estruturadas.
- **Armazenamento:** local, sem backend na nuvem — SQLite embutido para o histórico de scans, cofre nativo do sistema para as credenciais.

## Roadmap

- **Fase 0 — Visibilidade honesta** *(atual)*: scan somente leitura, custo estimado e confirmação temporal (um recurso precisa permanecer ocioso em múltiplos scans antes de contar como desperdício confirmado). Sem ações de escrita.
  - ✅ Fluxo de conexão com a AWS + auditoria de permissões + cofre nativo — `v0.1.0-scope1`
  - ✅ Detectores de recursos ociosos (EBS, Elastic IP, snapshot) + histórico de scans + escala de confiança de quatro níveis — `v0.2.0-scope2`
  - ☐ Custo estimado por recurso sinalizado e total acumulado
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
