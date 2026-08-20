/**
 * O TEXTO do onboarding (registo de T4.1, TG-070): as quatro mensagens que a
 * pessoa le em cada estado, os titulos, os avisos obrigatorios e o comando CLI.
 *
 * Extraido de `src/telegram/onboarding.ts` pela COSTURA da Onda 5 (item 6): o
 * detector (`detectarEstado`/`proximoPasso`) continua em `onboarding.ts`; o
 * TEXTO — artefacto revisavel, nao improviso de quem implementa — vive aqui.
 *
 * REGRAS (herdadas): portugues sem jargao; sem stack trace nem simbolo
 * interno; sem caminho absoluto que identifique o utilizador; sem segredo. O
 * codigo de pareamento aparece EXATAMENTE num sitio (o texto de
 * `TOKEN_OK_SEM_DONO`) e a funcao que o compoe exige-o como parametro
 * explicito (PAIR-010).
 */

import { COMANDO_DE_PAREAMENTO, DIGITOS_DO_CODIGO } from './pairing.ts'
import type { MotivoDeFormato, RetratoDoAmbiente } from './onboarding.ts'

/** Comando publicado no `PATH` pelo pacote. Aparece em todas as instrucoes. */
export const COMANDO_CLI = 'dsh-guard-setup'

/**
 * Os CINCO AVISOS OBRIGATORIOS (TG-072), exibidos ANTES do primeiro tunel.
 *
 * Nao sao decoracao nem letra pequena: sao as cinco coisas que mudam no
 * instante em que o tunel sobe e que, se a pessoa so descobrir depois, ja
 * descobriu tarde. Cada um tem fonte no plano:
 *   1. `trustedRemotes` inerte -- `01-ARQUITETURA.md` 4 e `src/index.ts`;
 *   2. o tunel e uma ligacao de DENTRO para FORA, logo nao ha regra de entrada
 *      que o pare -- `docs/spikes/cloudflared.md`;
 *   3. TLS termina na borda da Cloudflare -- `01-ARQUITETURA.md` 4;
 *   4. amostragem publica (urlscan.io) devolveu dezenas de hostnames vivos;
 *   5. reputacao de malware do dominio -- `07-COMUNIDADE.md` 9.7.
 */
export const AVISOS_ANTES_DO_TUNEL = `Antes de abrir o túnel pela primeira vez, cinco coisas mudam — leia-as uma vez:

  1. A sua lista de endereços de confiança (trustedRemotes) fica INERTE.
     Sob túnel, todo o tráfego chega de 127.0.0.1, porque quem o entrega é o
     cliente do túnel a correr nesta mesma máquina. A senha passa a ser a única
     barreira que resta.

  2. O túnel fura a firewall da sua rede. Ele não abre porta nenhuma para
     dentro: sai de dentro para fora e mantém a ligação aberta. Nenhuma regra
     de entrada o bloqueia — é assim que ele foi feito para funcionar.

  3. A Cloudflare vê o seu tráfego em texto claro na borda. O TLS termina lá,
     não aqui, e não há cifra ponta a ponta. É exatamente isso que permite o
     WAF, o Access e a cache; e também quer dizer que o que aparece no ecrã
     passa legível por um terceiro.

  4. O endereço do túnel NÃO é segredo. Uma amostragem pública devolveu dezenas
     de endereços *.trycloudflare.com vivos naquele momento. Conte com a senha,
     nunca com o facto de o nome do endereço ser estranho.

  5. trycloudflare.com tem reputação de malware em alguns filtros. Desde 2024
     há campanhas a distribuir malware por túneis descartáveis; por isso muitas
     redes de empresa bloqueiam o domínio e alguns antivírus assinalam o
     programa do túnel. Em máquina de trabalho, fale antes com quem cuida da
     segurança.`

export const TITULO_SEM_TOKEN = 'Falta criar o bot no Telegram.'
export const TITULO_TOKEN_INVALIDO = 'A chave do bot não foi aceite pelo Telegram.'
export const TITULO_SEM_DONO = 'O bot já responde. Falta dizer-lhe quem é o dono.'
export const TITULO_PRONTO = 'Está tudo ligado.'

export interface OpcoesDePasso {
  /**
   * Caminho do `secrets.env`, JA tornado apresentavel. Ver
   * {@link caminhoApresentavel} — o texto nunca leva `/home/<nome>`.
   */
  readonly caminhoSecretsEnv: string
  /**
   * O codigo de pareamento, para `TOKEN_OK_SEM_DONO`.
   *
   * PARAMETRO EXPLICITO, e nao lido de dentro: quem compoe este texto tem de
   * ter ido buscar o codigo de proposito, com um `revelarCodigo()` no meio.
   * Nenhum chamador o recebe por acaso (PAIR-010).
   */
  readonly codigo?: string | undefined
  /** Minutos de validade do codigo, para o texto nao ter numero magico. */
  readonly minutosDoCodigo?: number | undefined
}

/**
 * TG-060 — o passo do BotFather COM O TEXTO EXACTO A DIGITAR.
 *
 * "Sem jargao" e uma exigencia com consequencia: nao se escreve "envie o
 * comando `/newbot` ao BotFather", escreve-se o que aparece no ecra e o que a
 * pessoa escreve, por ordem, com um exemplo de cada resposta. As regras do
 * username (5-32, `[A-Za-z0-9_]`, sufixo `bot`, IMUTAVEL) estao citadas de
 * `bots/features` e sao a causa numero um de a pessoa ficar presa neste passo.
 */
export function textoSemToken(opcoes: OpcoesDePasso): string {
  return `Ainda não há nenhum bot do Telegram ligado a esta máquina. Criar um leva um
minuto e faz-se todo dentro da aplicação do Telegram:

  1. Abra o Telegram e procure por  @BotFather
     É a conta oficial da Telegram para criar bots.

  2. Escreva-lhe exatamente isto e envie:

         /newbot

  3. Ele pergunta o nome do bot. É o nome que aparece no topo da conversa e
     pode ser mudado mais tarde. Escreva o que quiser, por exemplo:

         Meu painel

  4. Ele pergunta o nome de utilizador do bot. Este tem regras: entre 5 e 32
     caracteres, só letras sem acento, algarismos e "_", e tem de TERMINAR
     em bot. Por exemplo:

         meu_painel_bot

     Este nome não pode ser mudado depois. Escolha-o com calma.

  5. Ele responde com uma linha parecida com esta:

         123456789:AA… (e mais uns trinta caracteres)

     Essa linha é a chave do seu bot: quem a tiver comanda o bot inteiro.
     Não a cole em conversa nenhuma, nem sequer na conversa com o próprio bot.

  6. Volte a este terminal e escreva:

         ${COMANDO_CLI} --pedir-token

     A chave é pedida aqui, não aparece no ecrã enquanto a escreve, e fica
     guardada em ${opcoes.caminhoSecretsEnv}, que só a sua conta consegue ler.
     Nunca a passe na própria linha de comando: o que se escreve na linha de
     comando fica à vista de qualquer programa desta máquina.`
}

/**
 * TG-062 — o texto do token recusado, com o `/token` do BotFather.
 *
 * O plano dizia "mostra o erro cru da API". NAO se mostra o erro cru: o erro
 * cru e `Unauthorized: invalid token specified`, em ingles, e nao diz a
 * ninguem que a cura e pedir uma chave nova ao BotFather. O que se mostra e o
 * DIAGNOSTICO em portugues e o passo seguinte; a `description` original fica na
 * mesma acessivel a quem chama, dentro de {@link FalhaDoGetMe}.
 */
export function textoTokenInvalido(retrato: RetratoDoAmbiente): string {
  return `${diagnostico(retrato)}

O que fazer:

  1. Abra o Telegram e escreva ao  @BotFather :

         /token

  2. Ele pergunta de que bot se trata. Escolha o seu na lista.

  3. Ele responde com uma chave nova. A antiga deixa de funcionar nesse
     instante — é isso que a torna segura de substituir.

  4. Volte a este terminal e escreva:

         ${COMANDO_CLI} --pedir-token

Enquanto a chave não for aceite, o bot não recebe nem envia nada.`
}

/**
 * A linha que explica PORQUE nao foi aceite, uma por causa.
 *
 * Sem esta separacao, todas as falhas dariam a mesma frase e a pessoa cuja
 * internet caiu iria pedir uma chave nova ao BotFather sem precisar.
 */
function diagnostico(retrato: RetratoDoAmbiente): string {
  const formato = retrato.token?.formato
  if (formato !== undefined && !formato.valido) {
    return `A chave nem chegou a ser enviada ao Telegram: ${explicarFormato(formato.motivo)}
Nada saiu desta máquina.`
  }

  const falha = retrato.getMe?.ok === false ? retrato.getMe.falha : undefined
  if (falha === undefined) {
    return `A chave existe, mas ainda não foi confirmada com o Telegram nesta execução.`
  }

  switch (falha.causa) {
    case 'recusado':
      return `O Telegram respondeu que esta chave não vale. Isso costuma ser uma de duas
coisas: ou a chave foi substituída (pedir uma nova ao BotFather revoga a
anterior no mesmo instante), ou ficou mal copiada — falta um pedaço no fim,
ou veio um espaço junto.`
    case 'rota-inexistente':
      return `O Telegram não reconheceu o endereço formado com esta chave, o que acontece
quando ela vem partida ao meio ou lhe falta o pedaço antes dos dois pontos.`
    case 'conflito':
      return `Já existe outra ligação a usar este mesmo bot. Duas ligações não podem
escutar o mesmo bot ao mesmo tempo: o Telegram desliga a mais antiga. Pare o
harness (ou o plugin) e volte a executar este comando.`
    case 'limite-de-taxa':
      return `O Telegram está a pedir para abrandar${falha.retryAfter === undefined ? '' : ` (${String(falha.retryAfter)} segundos)`}. Espere um pouco e repita — não é
preciso mudar nada.`
    case 'rede':
      return `Não foi possível falar com o Telegram a partir desta máquina. Verifique a
ligação à internet, e se usa proxy verifique-o também. A chave em si não foi
posta em causa.`
    case 'resposta-ininteligivel':
      return `O Telegram respondeu de uma forma que não foi possível interpretar${falha.httpStatus === 0 ? '' : ` (HTTP ${String(falha.httpStatus)})`}.
Repita daqui a um minuto; se continuar, é do lado do Telegram.`
  }
}

function explicarFormato(motivo: MotivoDeFormato): string {
  switch (motivo) {
    case 'vazio':
      return 'ela está vazia.'
    case 'sem-dois-pontos':
      return `falta-lhe os dois pontos. Uma chave tem sempre a forma
número:letras, e é preciso copiar a linha toda, do primeiro algarismo ao
último caractere.`
    case 'id-comeca-por-zero':
      return `a parte antes dos dois pontos começa por zero, e o número de um
bot nunca começa por zero. Provavelmente sobrou um caractere na cópia.`
    case 'id-nao-numerico':
      return `a parte antes dos dois pontos devia ser só algarismos.`
    case 'segredo-curto':
      return `a parte depois dos dois pontos é curta demais: ficou cortada.`
    case 'caracteres-invalidos':
      return `há caracteres que não pertencem a uma chave — talvez tenha vindo
uma aspa, um espaço ou uma quebra de linha junto na cópia.`
    case 'comprimento-excessivo':
      return `ela é longa demais para ser uma chave: parece que veio mais coisa
colada junto.`
  }
}

/**
 * TG-063 — o codigo de pareamento, e a instrucao de mandar `/parear <codigo>`.
 *
 * TRES coisas que este texto tem de fazer:
 *   1. NAO instruir a mandar `/start`, e dizer com todas as letras que nenhum
 *      `/start` pareia ninguem (D8);
 *   2. Explicar que um bot NAO CONSEGUE COMECAR UMA CONVERSA (limitacao da
 *      plataforma — sem esta frase, quem nunca escreveu ao bot fica a olhar
 *      para um terminal que "nao faz nada");
 *   3. Dizer PORQUE existe o codigo: a posse do terminal e a prova.
 */
export function textoSemDono(bot: string, opcoes: OpcoesDePasso): string {
  const codigo = opcoes.codigo ?? '·'.repeat(DIGITOS_DO_CODIGO)
  const minutos = opcoes.minutosDoCodigo ?? 5
  return `O bot ${bot} está a funcionar. Falta ligá-lo a si — e só a si.

    O seu código de pareamento:   ${codigo}

Ele vale ${String(minutos)} minutos, serve uma única vez, e existe apenas aqui, neste
terminal. Não o reencaminhe a ninguém.

  1. Abra o Telegram e abra a conversa com ${bot}.
     Se a conversa ainda não existir, toque em Iniciar: um bot nunca consegue
     começar uma conversa consigo, quem tem de falar primeiro é sempre você.

  2. Envie ao bot exatamente isto:

         ${COMANDO_DE_PAREAMENTO} ${codigo}

  3. Volte a este terminal. Assim que a mensagem chegar, fica gravado que o
     dono é você, e esta janela fecha-se de vez.

Porquê um código, e não simplesmente a primeira pessoa que escrever ao bot:
o nome de um bot é fácil de adivinhar, e quem escrevesse primeiro ficaria dono
do seu computador sem nunca ter visto a sua senha. O código só existe neste
terminal, e ter este terminal é a prova de que a máquina é sua.

Uma mensagem /start não pareia ninguém. Se alguém escrever ao bot antes de si,
a mensagem é ignorada e contada, e nada lhe é revelado.

Se os ${String(minutos)} minutos passarem, não fica nada trancado: peça outro código com

         ${COMANDO_CLI} --parear`
}

/**
 * TG-067 — "pronto", e a promessa de IDEMPOTENCIA escrita no proprio texto.
 *
 * A frase "executar outra vez nao gera codigo novo, nao troca a senha e nao
 * reabre o pareamento" nao e conforto: e o contrato que o teste assere e a
 * razao pela qual a execucao por omissao desta ferramenta NAO ESCREVE NADA.
 */
export function textoPronto(bot: string, opcoes: OpcoesDePasso): string {
  return `  bot     ${bot}
  dono    pareado
  chave   guardada em ${opcoes.caminhoSecretsEnv} (só a sua conta lê)

Não há nada a fazer aqui. Executar este comando outra vez não gera código novo,
não troca a senha e não reabre o pareamento.

Para trocar de dono é preciso estar nesta máquina e escrever:

         ${COMANDO_CLI} --reset-pairing

${AVISOS_ANTES_DO_TUNEL}`
}