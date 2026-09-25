/**
 * GUARDIAO ESTRUTURAL PERMANENTE — o golden master da remocao do provedor
 * apagado (onda 1, tarefa B: «apagar COMPLETAMENTE o codigo do Discord; golden
 * master grep=0 fora da historia»).
 *
 * PORQUE ISTO VIVE EM CODIGO DE TESTE E NAO NUM `grep` MANUAL: um grep manual
 * so corre quando alguem se lembra dele. A remocao completa de um provedor e a
 * mudanca que mais facilmente regride por via de um comentario, uma string de
 * ajuda ou uma entrada de manifesto — e o unico guardian ate agora era uma
 * verificacao manual. Este ficheiro torna-a PERMANENTE: corre em `pnpm test`.
 *
 * O CONTRATO (FOCO 1a): NENHUM ficheiro atual de producao/worker/src/test (nem
 * de config, docs atuais ou skills) menciona o provedor removido FORA das
 * classes NOMEADAS na promessa do `.changeset/remocao-provedor-discord.md` —
 * e as classes deste guarda sao EXATAMENTE as que a promessa nomeia (caso
 * «lockstep» abaixo), nem mais nem menos:
 *   (a) REGISTOS da remocao — `.changeset/**` e `CHANGELOG.md` (a decisao e o
 *       seu historico nomeiam o removido de proposito);
 *   (b) GUARD-STRINGS anti-regressao — os 3 paths exatos que citam o nome para
 *       o PROIBIR (`package.json`, `scripts/check-tarball.mjs`,
 *       `test/unit/scripts/release-artefacts.test.ts`);
 *   (c) ARQUIVO HISTORICO de planeamento (nunca foi doc atual) — `docs/plano/**`
 *       (inclui `manifesto.md`), `docs/spikes/**`, `docs/manual-runs/**`,
 *       `docs/RELATORIO*`, `docs/mutantes.md`;
 *   (d) O FICHEIRO DO PROPRIO GUARDA (este) — precisa do termo para o procurar
 *       e dos paths das classes para as nomear; o CONTEUDO dele e auto-isento
 *       e o CAMINHO entra na varredura (prova de que o walker chegou aqui).
 * Fora do recorte (nao sao ficheiros de repo): `.deep-orchestrator/**` (logs
 * do orquestrador, gitignored). Os emitidos `dist/`/`lib/` da raiz — RASTREADOS
 * pelo git desde o fix da instalacao (6b416fa), 457 artefactos commitados —
 * estao DENTRO da varredura desde esta versao: o texto compilado nao pode
 * trazer a literal de volta (o fonte nao a tem; se um artefato a trouxer, isso
 * e um ACHADO a reportar, nunca uma isencao).
 *
 * ESTADO ATUAL: o residuo que reprovava o contrato (um comentario de producao
 * em `worker/providers/telegram/parse.ts:389`) foi CORRIGIDO e o caso do
 * contrato esta ATIVO — o `skip` que nomeava o bug ficou STALE e foi
 * desmarcado. A assercao alinha-se com as classes NOMEADAS acima (sem elas, o
 * `deepEqual(linhas, [])` puro reprovaria as guard-strings legitimas). O
 * ratchet tolera ZERO residuos conhecidos: a entrada `RESIDUO_CONHECIDO`
 * (`parse.ts:389`) morreu com o residuo — tolerar um residuo inexistente era
 * estado morto (uma isencao viva so serviria para esconder o proximo residuo
 * naquela linha).
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url))
const EU = resolve(fileURLToPath(import.meta.url))

/**
 * Diretorios que NAO sao ficheiro-atual-de-repo: controlo de versao,
 * dependencias instaladas e estado local do orquestrador. Os emitidos de build
 * (`dist/`/`lib/` da RAIZ) ja NAO estao aqui: sao RASTREADOS pelo git desde o
 * fix da instalacao e passaram a ser varridos como qualquer ficheiro atual
 * (`worker/lib/` e FONTE e sempre foi varrido; `lib/` da raiz e o emitido do
 * client).
 */
const DIRS_FORA = new Set(['.git', 'node_modules', '.deep-orchestrator'])

/** Extensoes nao-texto (logos, tarballs, fontes) + artefactos de build. */
const EXTS_FORA = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.tgz', '.gz', '.zip',
  '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.lock', '.tsbuildinfo',
])

/**
 * As isencoes por PREFIXO de caminho — as classes (a) e (c) da promessa:
 * os REGISTOS da remocao (`.changeset/**`) e o ARQUIVO HISTORICO de
 * planeamento (`docs/plano/**` inclui `manifesto.md`, `docs/spikes/**`,
 * `docs/manual-runs/**`, `docs/RELATORIO*`). Casam por comeco de caminho
 * (`docs/RELATORIO*` e um globs).
 */
const PREFIXOS_HISTORIA: readonly string[] = [
  'docs/plano/',
  'docs/spikes/',
  'docs/manual-runs/',
  'docs/RELATORIO',
  '.changeset/',
]
/** As isencoes por path EXATO (nada de `CHANGELOG.md.old`): o `CHANGELOG.md` (classe (a)) e `docs/mutantes.md` (classe (c)). */
const EXACTOS_HISTORIA: readonly string[] = ['docs/mutantes.md', 'CHANGELOG.md']

/** `true` se o caminho (relativo, posix) e uma isencao nomeada (a)/(c). */
function eHistoria(relPosix: string): boolean {
  return (
    PREFIXOS_HISTORIA.some((prefixo) => relPosix.startsWith(prefixo)) ||
    EXACTOS_HISTORIA.includes(relPosix)
  )
}

interface Mencoes {
  /** Varredura nao-vazia (ficheiros realmente percorridos) — guarda anti-vazio. */
  readonly ficheiros: string[]
  /** `caminho:linha` de cada linha que casa o termo. */
  readonly linhas: string[]
}

/**
 * O TERMO procurado, montado em tempo de execucao: o nome do provedor removido
 * (e variantes coladas simples, ex. `dis-cord`), em qualquer caixa. Montado
 * por partes para este ficheiro nao se citar a si mesmo no `grep` futuro. As
 * variantes coladas sao limitadas a UM separador: com `\S*` aberto, o cruzamento
 * entre duas ocorrencias de `cordis` (lockfiles, espelhos `types/`) casava
 * falso. A varredura e de CONTEUDO INTEIRO (a regex e aplicada ao ficheiro
 * todo; `[-_.]?` nunca casa uma quebra de linha, por aqui o resultado e o mesmo
 * da antiga varredura por linha) — a linha do relato vem do offset do match.
 */
const TERMOS = new RegExp(`${'dis'}[-_.]?${'cord'}`, 'giu')

/**
 * A variante ESPACADA/ESCAPADA — o obfuscador barato que passava pelos DOIS
 * guardioes: nao casa o `git grep -il discord` (a contagem) nem o TERMOS
 * colado. Casa `dis` + uma CORRIDA de (whitespace | escape `\n`/`\t`/`\r`
 * literal de minificado) + `cord`, sobre o CONTEUDO INTEIRO: uma mencao
 * dividida por quebra de linha (`dis` no fim de uma linha, `cord` no inicio da
 * seguinte) e apanhada, e tambem a forma escapada que vive dentro de strings
 * minificadas. A UNICA protecao de cruzamento e `(?<!cor)`: `cordis` termina em
 * `dis` e a ocorrencia seguinte comeca em `cord`, por isso sem ela o par
 * `cordis\ncordis` dos espelhos `types/` casava falso (medido: continua
 * bloqueado com whitespace e com escapes). NAO ha ancoras de palavra — e uma
 * correcao deliberada face a `(?<![a-z])`/`(?![a-z])`: o repro obrigatorio da
 * revisao (`xxdis\ncordxx`, embebido em letras) passava com as ancoras de
 * palavra (medido), e a mencao embebida e exatamente a forma de minificado que
 * esta aqui para apanhar (repro: `printf 'xxdis\ncordxx\n' >> dist/index.js`
 * tem de reprovar o `pnpm test`).
 */
const TERMOS_ESPACADO = new RegExp(String.raw`(?<!cor)${'dis'}(?:\s|\\[nrt])+${'cord'}`, 'giu')

/** Os dois matchers, aplicados ao CONTEUDO INTEIRO de cada ficheiro varrido. */
const TERMOS_TODOS: readonly RegExp[] = [TERMOS, TERMOS_ESPACADO]

/** A linha (1-based) de um offset num conteudo — para o relato `caminho:linha`. */
function linhaDe(texto: string, offset: number): number {
  let linha = 1
  for (let i = 0; i < offset; i += 1) if (texto.charAt(i) === '\n') linha += 1
  return linha
}

function varrer(dir: string, acc: Mencoes): void {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    const rel = relative(RAIZ, caminho).split(sep).join('/')
    if (entrada.isDirectory()) {
      if (DIRS_FORA.has(entrada.name)) continue
      if (eHistoria(rel + '/')) continue
      varrer(caminho, acc)
      continue
    }
    if (!entrada.isFile()) continue
    if (eHistoria(rel)) continue
    if (EXTS_FORA.has(extname(caminho))) continue
    // Classe (d), auto-isencao NOMEADA na promessa: este ficheiro entra na
    // lista (prova de que o walker chegou aqui) mas o CONTEUDO dele e isento —
    // precisa do termo para o procurar e dos paths para os nomear.
    const euSouEu = caminho === EU
    acc.ficheiros.push(rel)
    if (euSouEu) continue
    const texto = readFileSync(caminho, 'utf8')
    const vistas = new Set<string>()
    for (const termo of TERMOS_TODOS) {
      for (const achado of texto.matchAll(termo)) {
        const marcador = `${rel}:${String(linhaDe(texto, achado.index))}`
        if (vistas.has(marcador)) continue
        vistas.add(marcador)
        acc.linhas.push(marcador)
      }
    }
  }
}

function mencoesForaDaHistoria(): Mencoes {
  const acc: Mencoes = { ficheiros: [], linhas: [] }
  varrer(RAIZ, acc)
  return acc
}

/**
 * As strings de guarda anti-regressao — classe (b) da PROMESSA VERIFICAVEL do
 * `.changeset/remocao-provedor-discord.md` ("strings de guarda anti-regressao
 * que nomeiam o que proibem"): estes 3 ficheiros precisam de citar o nome do
 * provedor removido para O PROIBIR — o FORBIDDEN_PREFIXES e o cabecalho do
 * gate do tarball (`scripts/check-tarball.mjs`), a anotacao `"//scripts"` do
 * `package.json` e o craft do teste do artefacto de release
 * (`test/unit/scripts/release-artefacts.test.ts`). Isencao por PATH EXACTO
 * (nunca prefixo de arvore), para os DOIS casos abaixo: sem ela, as guard-
 * strings legitimas reprovariam o grep=0 com residuos que sao, na verdade, a
 * PROVA de que as guardas existem.
 */
const GUARDAS_ANTIREGRESSION: readonly string[] = [
  'package.json',
  'scripts/check-tarball.mjs',
  'test/unit/scripts/release-artefacts.test.ts',
]

/**
 * O VEREDITO DO CONTRATO: as mencoes que ficam FORA das classes NOMEADAS na
 * promessa. Os registos e a historia (a)/(c) ja estao fora da varredura e o
 * CONTEUDO deste ficheiro e auto-isencao (d); resta a classe (b) — as
 * GUARDAS_ANTIREGRESSION — que citam o nome para O PROIBIR. Partilhado pelo
 * contrato ativo e pelo ratchet: a regra das classes vive NUM sitio so.
 */
function mencoesForaDasClassesNomeadas(): string[] {
  const { linhas } = mencoesForaDaHistoria()
  return linhas.filter((m) => !GUARDAS_ANTIREGRESSION.includes(m.slice(0, m.lastIndexOf(':'))))
}

/**
 * Os LITERAIS que a promessa tem de nomear por isencao deste guarda —
 * DERIVADOS das constantes do guarda, nunca uma lista manual (era assim que
 * isencoes REAIS escapavam ao lockstep: root `lib`, `dist` em qualquer
 * profundidade, `node_modules`, `.git` e as EXTS_FORA nao estavam na lista e
 * apagar `dist`/`lib` da promessa mantinha o caso verde). Regra de traducao
 * constante -> literal nomeado na promessa:
 *   - prefixo `x/` vira `x/**`; prefixo de globs `x` vira `x*`;
 *   - path exato vira o proprio path;
 *   - dir nao-varrido vira `x/**`; extensao nao-varrida vira a propria extensao;
 *   - o ficheiro do guarda vira o proprio path.
 */
function literaisDasIsencoes(): string[] {
  return [
    // (a) registos + (c) historia — prefixos e paths exatos
    ...PREFIXOS_HISTORIA.map((prefixo) => (prefixo.endsWith('/') ? `${prefixo}**` : `${prefixo}*`)),
    ...EXACTOS_HISTORIA,
    // (b) guard-strings — os 3 paths exatos
    ...GUARDAS_ANTIREGRESSION,
    // FORA DO RECORTE — dirs nao-varridos (nome, qualquer profundidade). Os
    // emitidos `dist/`/`lib/` da raiz deixaram de ser isencao: sao rastreados
    // e estao DENTRO da varredura.
    ...Array.from(DIRS_FORA).map((dir) => `${dir}/**`),
    // FORA DO RECORTE — extensoes nao-varridas (a lista de formatos tem de
    // estar NOMEADA na promessa: `.svg`/`.lock` sao textuais e ficam de fora)
    ...EXTS_FORA,
    // (d) o ficheiro do proprio guarda
    'test/unit/estrutural/golden-master.test.ts',
  ]
}

/**
 * Extrai os code-spans (`...`) de uma lista NOMEADA na promessa, entre duas
 * ancoras literais do proprio texto. As ancoras fazem parte do contrato: se a
 * promessa as perder, o caso cai com a mensagem em vez de passar em silencio
 * sobre uma lista que deixou de ser verificavel.
 */
function extrairLista(texto: string, de: string, ate: string): string[] {
  const i = texto.indexOf(de)
  const j = texto.indexOf(ate, i + de.length)
  assert.ok(i >= 0 && j > i, `a promessa perdeu a lista '${de} ... ${ate}'`)
  return [...texto.slice(i, j).matchAll(/`([^`]+)`/gu)].map((m) => m[1] ?? '')
}

/**
 * Os globos `x/**`/`x/y/**` citados em QUALQUER sitio do texto da promessa —
 * uma classe inventada como `foo/**` (ou `docs/foo/**`) nao passa por aqui,
 * mesmo colada fora das listas.
 */
function globosCitados(texto: string): string[] {
  return [...texto.matchAll(/`([^`]+)`/gu)]
    .map((m) => m[1] ?? '')
    .filter((span) => span.endsWith('/**') && span.split('/').length <= 3)
}

/**
 * O SENTIDO INVERSO do lockstep (promessa -> guarda): toda a classe que a
 * promessa nomeia tem de ter uma isencao VIVA no guarda — o mecanismo realmente
 * isenta, e nao so consta na constante. As provas sao comportamentais sobre a
 * propria varredura: nenhum ficheiro varrido vive sob um dir nao-varrido nem
 * numa extensao nao-varrida; as guard-strings TEM mencoes e estao filtradas; a
 * historia e o proprio guarda casam.
 */
function provasDeIsencaoViva(): Array<{ literal: string; prova: () => void }> {
  const { ficheiros, linhas } = mencoesForaDaHistoria()
  const fora = mencoesForaDasClassesNomeadas()
  const caminhoDe = (m: string): string => m.slice(0, m.lastIndexOf(':'))
  return [
    ...PREFIXOS_HISTORIA.map((prefixo) => ({
      literal: prefixo.endsWith('/') ? `${prefixo}**` : `${prefixo}*`,
      prova: () => assert.ok(eHistoria(`${prefixo}ficheiro.md`), `o prefixo ${prefixo} ja nao isenta`),
    })),
    ...EXACTOS_HISTORIA.map((exacto) => ({
      literal: exacto,
      prova: () => assert.ok(eHistoria(exacto), `o path exato ${exacto} ja nao isenta`),
    })),
    ...GUARDAS_ANTIREGRESSION.map((guarda) => ({
      literal: guarda,
      prova: () => {
        assert.ok(linhas.some((m) => caminhoDe(m) === guarda), `a guard-string de ${guarda} desapareceu`)
        assert.ok(!fora.some((m) => caminhoDe(m) === guarda), `${guarda} deixou de estar isenta`)
      },
    })),
    ...Array.from(DIRS_FORA).map((dir) => ({
      literal: `${dir}/**`,
      prova: () =>
        assert.ok(
          !ficheiros.some((f) => f.split('/').slice(0, -1).includes(dir)),
          `a varredura entrou em ${dir}/ — o dir ja nao e isento`,
        ),
    })),
    ...Array.from(EXTS_FORA).map((ext) => ({
      literal: ext,
      prova: () =>
        assert.ok(!ficheiros.some((f) => extname(f) === ext), `a extensao ${ext} passou a ser varrida — ou a promessa muda de ideia`),
    })),
    {
      literal: 'test/unit/estrutural/golden-master.test.ts',
      prova: () => assert.ok(ficheiros.includes('test/unit/estrutural/golden-master.test.ts'), 'o walker ja nao chega ao proprio guarda'),
    },
  ]
}

/** As notas da promessa que verificam estas classes (o changeset e o espelho do CHANGELOG). */
function promessasExistentes(): Array<{ nome: string; texto: string }> {
  const candidatos = [
    { nome: '.changeset/remocao-provedor-discord.md', caminho: join(RAIZ, '.changeset/remocao-provedor-discord.md') },
    { nome: 'CHANGELOG.md', caminho: join(RAIZ, 'CHANGELOG.md') },
  ]
  const vivas = candidatos.filter((c) => existsSync(c.caminho))
  assert.ok(vivas.length > 0, 'a promessa desapareceu de ambos os registos (changeset e CHANGELOG)')
  return vivas.map((c) => ({ nome: c.nome, texto: readFileSync(c.caminho, 'utf8') }))
}

/**
 * O FACTO ESTAVEL, o UNICO numero da promessa: `git grep -il discord` na
 * arvore versionada devolve 10 ficheiros, exactamente as classes (a)-(d).
 * Pinned aqui porque um numero sem assercao e prosa: se a arvore mudar, o
 * lockstep exige atualizar promessa E guarda juntos.
 */
const ARVORE_VERSIONADA_ESPERADA: readonly string[] = [
  '.changeset/remocao-provedor-discord.md', // (a) registro da remocao
  'CHANGELOG.md', // (a) registro da remocao
  'docs/plano/02-SEGURANCA.md', // (c) arquivo historico
  'docs/plano/07-COMUNIDADE.md', // (c)
  'docs/plano/08-PESQUISA-E-FONTES.md', // (c)
  'docs/plano/manifesto.md', // (c)
  'package.json', // (b) guard-string
  'scripts/check-tarball.mjs', // (b) guard-string
  'test/unit/estrutural/golden-master.test.ts', // (d) o proprio guarda
  'test/unit/scripts/release-artefacts.test.ts', // (b) guard-string
]

/** Motivo do SALTO sem git/repo (vermelho de ambiente, nao de comportamento). */
function motivoDeSaltoGit(): string | undefined {
  try {
    execFileSync('git', ['-C', RAIZ, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
    return undefined
  } catch {
    return 'sem git ou sem repo em ' + RAIZ + ' — o facto estavel da promessa mede `git grep` na arvore versionada'
  }
}

describe('golden master da limpeza — nenhuma mencao ao provedor removido fora das classes nomeadas', () => {
  it('a varredura cobre MESMO a arvore inteira (guarda anti-vazio)', () => {
    const { ficheiros } = mencoesForaDaHistoria()
    // Sem esta checagem, um bug no walker tornaria todos os casos verdes por
    // varrer zero ficheiros — o classico guarda vazio. Os emitidos `dist/` e
    // `lib/` tambem sao obrigatorios: sao RASTREADOS desde o fix da instalacao
    // e a promessa cobre-os (457 artefatos, varridos desde a escolha (a)).
    for (const obrigatorio of [
      'worker/providers/registry.ts',
      'worker/providers/telegram/parse.ts',
      'src/proc/env.ts',
      'package.json',
      'cordis.patch.yml',
      'dist/index.js',
      'dist/worker/telegram-bot.js',
      'lib/client.js',
      'lib/client.d.ts',
      'test/unit/estrutural/golden-master.test.ts',
    ]) {
      assert.ok(
        ficheiros.includes(obrigatorio),
        `a varredura nao chegou a ${obrigatorio} — o walker regrediu`,
      )
    }
    assert.ok(ficheiros.length > 400, `a varredura leu poucos ficheiros (${String(ficheiros.length)}) — os emitidos estao de fora?`)
  })

  it('as isencoes sao EXATAMENTE as classes nomeadas (nada escapa por typo)', () => {
    // (c) arquivo historico + (a) registos:
    assert.ok(eHistoria('docs/plano/06-REPO-E-CI.md'))
    assert.ok(eHistoria('docs/plano/manifesto.md'))
    assert.ok(eHistoria('docs/spikes/telegram.md'))
    assert.ok(eHistoria('docs/manual-runs/M1-onboarding-telegram.md'))
    assert.ok(eHistoria('docs/RELATORIO-FINAL.md'))
    assert.ok(eHistoria('docs/RELATORIO-FECHAMENTO.md'))
    assert.ok(eHistoria('docs/mutantes.md'))
    assert.ok(eHistoria('CHANGELOG.md'))
    assert.ok(eHistoria('.changeset/remocao-provedor.md'))
    // O que NAO e classe nomeada nao escapa (prefixos e exactos nao se confundem):
    assert.ok(!eHistoria('docs/INSTALL.md'))
    assert.ok(!eHistoria('docs/PROVIDERS.md'))
    assert.ok(!eHistoria('docs/mutantes.md.bak'))
    assert.ok(!eHistoria('README.md'))
    assert.ok(!eHistoria('src/index.ts'))
    assert.ok(!eHistoria('test/unit/index.test.ts'))
    assert.ok(!eHistoria('CHANGELOG.md.old'))
    assert.ok(!eHistoria('plano/06-REPO-E-CI.md'))
    assert.ok(!eHistoria('.changeset-velho/x.md'))
    // (b) so os 3 paths exatos, e (d) so o ficheiro do guarda:
    for (const guarda of GUARDAS_ANTIREGRESSION) assert.ok(!eHistoria(guarda), guarda)
    assert.deepEqual(
      GUARDAS_ANTIREGRESSION,
      ['package.json', 'scripts/check-tarball.mjs', 'test/unit/scripts/release-artefacts.test.ts'],
      'a classe (b) sao estes 3 paths exatos — crescer aqui exige crescer a promessa',
    )
  })

  it('lockstep BIDIRECIONAL: toda a isencao do guarda esta nomeada na promessa E toda a classe nomeada tem isencao viva', () => {
    // A promessa (`.changeset/remocao-provedor-discord.md` + espelho do
    // `CHANGELOG.md`) e a FONTE destas classes; o lockstep cos os DOIS lados.
    //
    // SENTIDO 1 (guarda -> promessa): os literais sao DERIVADOS das constantes
    // do guarda — uma isencao nova sem nome na promessa reprova aqui (e uma
    // promessa que deixe de nomear uma isencao existente tambem).
    for (const promessa of promessasExistentes()) {
      for (const literal of literaisDasIsencoes()) {
        assert.ok(
          promessa.texto.includes(literal),
          `a promessa em ${promessa.nome} nao nomeia a isencao '${literal}' — promessa e isencoes divergem`,
        )
      }
    }
    // SENTIDO 2 (promessa -> guarda): as classes NOMEADAS NA PROMESSA — e nao
    // so as derivadas das constantes — tem de ter isencao VIVA no guarda. As
    // listas sao EXTRAIDAS do texto da promessa (code-spans entre ancoras) e
    // comparadas com as constantes nos DOIS sentidos: uma classe citada a mais
    // (inventada) ou a menos reprova aqui.
    const foraDeRecorte = Array.from(DIRS_FORA).map((dir) => `${dir}/**`).toSorted()
    const formatosNaoVarridos = Array.from(EXTS_FORA).toSorted()
    for (const promessa of promessasExistentes()) {
      // (i) a lista «fora do recorte» e EXATAMENTE as categorias nao-varridas do guarda
      assert.deepEqual(
        extrairLista(promessa.texto, 'Fora do recorte', 'Facto estável').toSorted(),
        foraDeRecorte,
        `as categorias «fora do recorte» em ${promessa.nome} divergem do guarda`,
      )
      // (ii) a lista de formatos e EXATAMENTE a EXTS_FORA (nos dois sentidos)
      assert.deepEqual(
        extrairLista(promessa.texto, 'formatos que o guarda não varre', '(logos, tarballs').toSorted(),
        formatosNaoVarridos,
        `os formatos nao-varridos em ${promessa.nome} divergem de EXTS_FORA`,
      )
      // (iii) qualquer OUTRO glob de 1-2 segmentos citado NA PROMESSA (o
      // paragrafo da bitola — a prosa do CHANGELOG fala de `worker/surface/**`
      // em entrada alheia e nao e classe nenhuma) tem de ser isencao derivada.
      const ini = promessa.texto.indexOf('Promessa verificável')
      const fim = promessa.texto.indexOf('Pendências transitórias', ini)
      assert.ok(ini >= 0 && fim > ini, `a promessa em ${promessa.nome} perdeu o paragrafo da bitola`)
      for (const span of globosCitados(promessa.texto.slice(ini, fim))) {
        assert.ok(
          literaisDasIsencoes().includes(span),
          `a promessa em ${promessa.nome} nomeia a classe '${span}' que o guarda NAO isenta`,
        )
      }
    }
    // (iv) e as isencoes do guarda estao VIVAS (provas comportamentais sobre a varredura).
    for (const { literal, prova } of provasDeIsencaoViva()) {
      try {
        prova()
      } catch (error) {
        assert.fail(
          `a classe nomeada '${literal}' nao tem isencao viva no guarda: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  })

  it('o contrato grep=0 FORA das classes nomeadas da promessa — zero mencoes alem delas', () => {
    // ATIVO (antes era o `it.skip` que nomeava o bug `parse.ts:389`; o fix
    // entrou e o skip ficou STALE). A assercao pura (`linhas === []`) foi
    // alinhada com as classes NOMEADAS: as guard-strings dos 3 paths exatos
    // (classe (b)) sao legitimas e reprovariam o caso puro; fora das classes
    // nomeadas o contrato continua grep=0.
    const fora = mencoesForaDasClassesNomeadas()
    assert.deepEqual(
      fora,
      [],
      `o contrato e grep=0 fora das classes nomeadas; residuos encontrados: ${fora.join(', ')}`,
    )
  })

  it('ratchet: tolera ZERO residuos conhecidos — so as classes NOMEADAS ficam isentas', () => {
    // A entrada `RESIDUO_CONHECIDO` (`parse.ts:389`) foi REMOVIDA: o residuo ja
    // nao existe e tolera-lo era estado morto — uma tolerancia viva que so
    // servia para esconder o proximo residuo exatamente naquela linha. O
    // ratchet passa a tolerar ZERO residuos conhecidos: a superficie limpa
    // continua limpa e so as classes nomeadas da promessa ficam isentas.
    const fora = mencoesForaDasClassesNomeadas()
    assert.deepEqual(fora, [], `residuos NOVOS fora das classes nomeadas: ${fora.join(', ')}`)

    // A classe (b) nao pode tornar-se uma isencao VAZIA: cada guard-string TEM
    // de existir e citar o nome (sem ela, a guarda deixa de nomear o que proibe
    // e a isencao passava tudo).
    const { linhas } = mencoesForaDaHistoria()
    for (const guarda of GUARDAS_ANTIREGRESSION) {
      assert.ok(
        linhas.some((m) => m.slice(0, m.lastIndexOf(':')) === guarda),
        `a guard-string de ${guarda} desapareceu — a isencao da classe (b) ficou vazia`,
      )
    }
  })

  it('os emitidos de build (dist/ e lib/) estao DENTRO da varredura — 457 artefactos, zero isencao', () => {
    // Escolha (a) do gap da revisao integrada da onda 3: `dist/**` e `lib/**`
    // eram saltados (DIRS_FORA + skip root-lib) por serem gitignorados — desde
    // o fix da instalacao (6b416fa) os 457 artefactos estao RASTREADOS e a
    // promessa declara "qualquer mencao nova fora das classes reprova". O
    // texto compilado nao pode trazer a literal de volta: se algum artefato a
    // trouxer, isso e um ACHADO a reportar, nunca uma isencao.
    const { ficheiros } = mencoesForaDaHistoria()
    const emitidos = ficheiros.filter((f) => f.startsWith('dist/') || f.startsWith('lib/'))
    assert.ok(
      emitidos.length >= 450,
      `a varredura so levou ${String(emitidos.length)} emitidos — os artefactos commitados estao de fora`,
    )
    // NENHUM emitido volta a entrar na lista de nao-varridos: a isencao morreu
    // com a escolha (a) e o lockstep deriva as constantes — se `dist` voltar a
    // DIRS_FORA ou o skip root-lib renascer, o anti-vazio acima reprova.
    assert.ok(
      !emitidos.some((f) => eHistoria(f)),
      'um emitido caiu numa isencao de historia — a varredura dos artefactos foi furada',
    )
  })

  it('o FACTO ESTAVEL da promessa: `git grep -il discord` devolve 10 ficheiros, exactamente as classes (a)-(d)', (t) => {
    // O UNICO numero da promessa ganha assercao: um numero sem assercao e
    // prosa. Medido com o PROPRIO comando nomeado na promessa, sobre a arvore
    // versionada (o que o clone/codeload entrega). Cada ficheiro encontrado
    // tem de ser classe nomeada — (a) registos, (b) guard-strings, (c)
    // historico, (d) o proprio guarda.
    const salto = motivoDeSaltoGit()
    if (salto !== undefined) return t.skip(salto)
    let encontrados: string[]
    try {
      encontrados = execFileSync('git', ['-C', RAIZ, 'grep', '-il', 'discord'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } catch (error) {
      // `git grep` sai em 1 sem matches — zero mencoes tambem reprova: a
      // promessa declara 10, nao 0.
      const e = error as { stdout?: string }
      encontrados = (e.stdout ?? '').split('\n').filter(Boolean)
    }
    assert.deepEqual(
      encontrados.toSorted(),
      [...ARVORE_VERSIONADA_ESPERADA].toSorted(),
      'o facto estavel (10 ficheiros da arvore versionada) mudou — atualizar a promessa E este guarda em lockstep',
    )
    const euRel = relative(RAIZ, EU).split(sep).join('/')
    for (const encontrado of encontrados) {
      assert.ok(
        eHistoria(encontrado) || GUARDAS_ANTIREGRESSION.includes(encontrado) || encontrado === euRel,
        `${encontrado} contem a literal mas NAO e classe nomeada (a)-(d)`,
      )
    }
  })
})
