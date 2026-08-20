# Política de Segurança

Este plugin é, por construção, o **controlo de acesso de um agente que executa código na sua
máquina**. Se ele falhar, quem entra ganha o que o agente tem: shell, `~/.ssh`, ficheiros `.env`,
chaves de API e o código-fonte do que estiver aberto. Tratamos relatos com essa gravidade.

---

## 1. O que este plugin faz — e o que não faz

**Faz:** exige credencial no plano de controlo HTTP do DSH (rotas `/api`, o fallback da SPA e o
handshake de WebSocket), recusa endereços de *bind* fora do loopback no carregamento, recusa
permissões proibidas (`danger-full-access`) e mantém subprocessos de longa duração sob um ciclo
de vida reversível.

**Não faz:** ele **não corrige** as vulnerabilidades do DSH a montante — nomeadamente a execução
de código remota não autenticada do plano de controlo descrita na discussão
[#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853). O que ele faz é impedir
que essas superfícies sejam **alcançáveis sem credencial**. Enquanto essas discussões estiverem
abertas, o sandbox do DSH **não** deve ser tratado como fronteira de segurança.

---

## 2. Versões suportadas

O pacote **ainda não foi publicado** com código funcional. Esta secção descreve a política que
passa a valer a partir da primeira versão publicada.

| Versão do plugin | Linha do DSH testada | Suporte de segurança |
| --- | --- | --- |
| a versão `minor` mais recente | `0.1.0-rc.7` (faixa verificada `rc.7`–`rc.9`) | Sim |
| versões `minor` anteriores | — | Não. Atualize. |

Sendo um projeto de um mantenedor só, **não** há backport para linhas antigas: a correção sai na
versão corrente. A versão exata de `@deepseek-ai/*` contra a qual cada release foi testada é
declarada no `README.md` e em `docs/COMPATIBILITY.md` quando esse ficheiro existir.

> Atenção à armadilha do registry: a tag `latest` dos subpacotes `@deepseek-ai/dsh-*` aponta para
> a publicação **mais antiga**, não para a mais recente. Fixe a versão explicitamente.

---

## 3. Como reportar uma vulnerabilidade

**Não abra uma issue pública. Não publique em Discussions. Não envie por Telegram.**

O canal preferido é o **Private Vulnerability Reporting (PVR) do GitHub**, que cria um advisory
privado e um canal de conversa fechado entre si e o mantenedor:

1. abra a página do repositório no GitHub;
2. clique no separador **Security**;
3. clique em **Report a vulnerability**;
4. preencha o formulário (título e descrição são o mínimo) e submeta.

Ligação direta:
<https://github.com/frederico-kluser/deepseek-harness-mobile/security/advisories/new>

**Se o botão «Report a vulnerability» não aparecer**, o PVR ainda não foi ativado neste
repositório (é uma opção que o dono liga em *Settings → Advanced Security*, e que exige o
repositório público). Nesse caso use o e-mail do mantenedor: **kluserhuu@gmail.com**.
O e-mail é sempre um canal válido, mesmo com o PVR ligado.

### O que incluir

- versão do plugin e versão `rc` do DSH;
- versão do Node e sistema operativo;
- o caminho exato do pedido e o código de estado obtido *versus* o esperado;
- prova de conceito mínima, de preferência um `curl`;
- se houver log, **redija antes de colar**: token do bot do Telegram, cabeçalho `Authorization`,
  cookies, senha e a URL do túnel.

### Prazos que assumimos

Projeto de uma pessoa; prometemos o que conseguimos cumprir:

| Evento | Prazo declarado |
| --- | --- |
| Primeira resposta a um relato de segurança | 24 horas |
| Primeira resposta a issues normais | até 1 semana |
| Correção publicada, ou plano público de correção | até 90 dias |

Se passarem **30 dias** sem qualquer resposta do mantenedor, considere o projeto sem manutenção e
faça *fork* — a licença MIT permite-o explicitamente.

---

## 4. Escopo

**Dentro do escopo** (queremos muito saber):

- qualquer caminho que devolva `200` numa superfície guardada **sem** credencial válida;
- contorno do portão por rota, por *fallback* da SPA, por *upgrade* de WebSocket, por
  normalização de caminho (`..`, codificação percentual, barras duplicadas) ou por cabeçalho;
- vazamento de credencial, do digest da credencial, de identificador de sessão ou do token do bot
  — em log, em `argv`, em mensagem de erro ou em resposta HTTP;
- escape do supervisor de subprocessos: processo que sobrevive ao *dispose*, órfão reparentado,
  ou sinal que não alcança o grupo;
- elevação de privilégio pelo manifesto de configuração (`cordis.patch.yml`), incluindo qualquer
  caminho que reintroduza `danger-full-access`;
- comparação de segredo em tempo não constante em caminho de autenticação;
- qualquer coisa que faça o plugin arrancar **degradado e em silêncio** onde deveria falhar
  ruidosamente no carregamento.

**Fora do escopo** (reporte a quem é dono, e avise-nos por cortesia):

- vulnerabilidades do próprio DSH — reporte a `deepseek-ai/deepseek-harness`;
- vulnerabilidades do `cloudflared` ou da rede da Cloudflare — reporte à Cloudflare;
- vulnerabilidades da API de Bot da Telegram — reporte à Telegram;
- vulnerabilidades de dependências de terceiros sem caminho de exploração **através** deste
  plugin (reporte na origem; abra aqui uma issue normal a pedir o bump).

---

## 5. Não-vulnerabilidades — decisões conhecidas e documentadas

Estes pontos são **do desenho**, estão escritos, e um relato sobre eles será fechado como
«conhecido». Se discordar do desenho, abra uma issue de discussão — não um advisory.

- **A URL do túnel não é segredo.** Hostnames `*.trycloudflare.com` são descobríveis por
  amostragem pública, e uma amostragem real devolveu dezenas de hostnames vivos. A URL é um
  endereço, não uma credencial; quem protege é a barreira de autenticação, não a obscuridade do
  nome.
- **O TLS termina na borda da Cloudflare.** Arquitetonicamente o texto claro passa por lá — é o
  que permite WAF, Access e cache. Isto não é ponta-a-ponta e nunca foi apresentado como tal.
- **A senha nunca é enviada pelo Telegram.** Conversa com bot é *cloud chat*: não é
  ponta-a-ponta, o histórico fica nos servidores da Telegram e **não existe autodestruição para
  bots**. Qualquer proposta de «mandar a senha no chat para ser mais prático» é recusada por
  princípio.
- **Prompt injection contra o agente é risco aceite, não resolvido.** Quem tem credencial válida
  conduz o agente; o plugin controla *quem entra*, não *o que é pedido* depois de entrar.
- **O *quick tunnel* não tem SLA e o hostname muda a cada reinício.** É comportamento
  documentado do produto, não um defeito deste plugin.
- **Um patch de camada superior sobrepõe-se a este.** Um `cordis.patch.yml` em `$DSH_HOME`
  (Camada 3) ou um `--patch` na linha de comandos (Camada 4) vencem o que este pacote entrega,
  inclusive o *bind* de loopback. Auditar as camadas superiores é parte da instalação segura.
- **A ordem de carregamento dos plugins é responsabilidade de quem instala.** A superfície tipada
  do host não permite ao plugin enumerar rotas já registadas, logo ele não consegue *detetar* que
  carregou tarde. O `README.md` explica como verificar (um `curl` sem credencial tem de devolver
  `401`).

---

## 6. Porto seguro (*safe harbor*)

Pesquisa de boa-fé contra **a sua própria instalação** não será alvo de ação legal da nossa parte,
e agradecemos o relato. Em troca pedimos:

- não testar contra instalações de terceiros;
- não aceder, modificar nem exfiltrar dados que não sejam seus;
- não degradar o serviço de ninguém (nada de força bruta em escala ou negação de serviço);
- dar-nos uma janela razoável antes de tornar público — os prazos da §3 são o nosso compromisso
  do outro lado.

Crédito público no advisory e no `CHANGELOG.md` a quem reportar, salvo pedido em contrário.
