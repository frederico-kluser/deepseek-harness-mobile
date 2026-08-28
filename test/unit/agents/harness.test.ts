/**
 * `src/agents/harness.ts` — o ESPELHO ESTRUTURAL do harness (Onda 4).
 *
 * Este ficheiro e o UNICO ponto que descreve a API do harness que a Onda 4
 * consome (`packages/subagent`, `packages/core/agent`, `packages/skill` do
 * harness real — SOMENTE LEITURA, pinado por ficheiro no cabecalho do modulo).
 * Nao importa nenhum pacote `@deepseek-ai/*` (zero deps novas — regra da onda).
 *
 * O que este teste prende — as DUAS coisas que podem divergir do fonte real:
 *
 *   1. O RENDERIZADOR `renderHarnessSkill` produz o bloco `<skill_content>`
 *      CANONICO — o MESMO formato de `renderSkillContent` do harness — com o
 *      nome escapado como atributo (`&`, `"`, `<`) e o corpo embutido VERBATIM
 *      (skills sao conteudo local confiavel; o texto do dono fica FORA do
 *      bloco, depois dele);
 *   2. A FORMA dos tipos (o espelho minimo): objetos com a forma dos
 *      contratos reais (`SubagentStartRequest`, `SubagentRun`, `SubagentResult`,
 *      `SubagentStopReason`, `Agent`, `AgentRegistry`, `SkillRegistry`)
 *      compilam como os tipos consumidos. Se o fonte do harness mudar a forma
 *      (ex.: `result` deixar de existir, `cwd` mudar de sitio), o `tsc` recusa
 *      AQUI — que e exatamente o objetivo do espelho minimo: quem o alterar
 *      tem de voltar ao fonte e medir, nunca adivinhar.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  renderHarnessSkill,
  type HarnessAgent,
  type HarnessAgentRegistry,
  type HarnessSkillDefinition,
  type HarnessSkillRegistry,
  type HarnessSkillViewOptions,
  type HarnessStopReason,
  type HarnessSubagentResult,
  type HarnessSubagentRun,
  type HarnessSubagentRuntime,
  type HarnessSubagentStartRequest,
  type HarnessTextBlock,
} from '../../../src/agents/harness.ts'

const SKILL: HarnessSkillDefinition = {
  name: 'deep-orchestrator-agent-skill',
  description: 'orquestrador',
  content: 'Instrucoes da skill.',
}

/* ========================================================================== */
/* O renderizador canonico (espelho de renderSkillContent do harness)          */
/* ========================================================================== */

describe('renderHarnessSkill — o bloco <skill_content> CANONICO', () => {
  it('produz a estrutura canonica em UMA string: nome, recursos, instrucoes', () => {
    const bloco = renderHarnessSkill(SKILL)

    const linhas = bloco.split('\n')
    assert.equal(linhas[0], '<skill_content name="deep-orchestrator-agent-skill">')
    assert.equal(linhas[1], '<skill_resources>')
    assert.equal(linhas[2], 'Resources for this skill are managed by the harness.')
    assert.equal(linhas[3], '</skill_resources>')
    assert.equal(linhas[4], '', 'a linha em branco antes das instrucoes faz parte da forma')
    assert.equal(linhas[5], '<skill_instructions>')
    assert.equal(linhas[6], 'Instrucoes da skill.')
    assert.equal(linhas[7], '</skill_instructions>')
    assert.equal(linhas[8], '</skill_content>')
    assert.equal(linhas.length, 9, 'nada alem do bloco')
  })

  it('o nome e escapado como ATRIBUTO — o MESMO escape do harness (&, " e <)', () => {
    const bloco = renderHarnessSkill({ ...SKILL, name: 'skill-com-&aspas-"e-<menor' })

    assert.equal(
      bloco.startsWith('<skill_content name="skill-com-&amp;aspas-&quot;e-&lt;menor">'),
      true,
      'a ordem do escape e a mesma de escapeAttr do harness: & primeiro, depois " e <',
    )
  })

  it('o corpo da skill e embutido VERBATIM: multilinha e markup nao sao transformados', () => {
    const conteudo = 'Passo 1: use "aspas" & <tags>.\nPasso 2: continue.\n</skill_instructions>'
    const bloco = renderHarnessSkill({ ...SKILL, content: conteudo })

    assert.ok(bloco.includes(conteudo), 'o corpo chega INTACTO ao prompt do filho')
    assert.equal(
      (bloco.match(/<skill_instructions>/gu) ?? []).length,
      1,
      'o fecho no corpo nao abre uma segunda tag — o markup do corpo nao e interpretado',
    )
  })

  it('uma skill com corpo vazio produz o bloco com as instrucoes vazias (nao omitidas)', () => {
    const bloco = renderHarnessSkill({ ...SKILL, content: '' })

    assert.ok(bloco.includes('<skill_instructions>'), 'a tag de abertura nao e omitida')
    assert.ok(bloco.includes('</skill_instructions>'), 'a tag de fecho nao e omitida')
    // Com corpo vazio, o que fica entre as tags sao as DUAS quebras do join
    // (`<skill_instructions>\n` + a linha vazia do conteudo + `\n</skill_instructions>`)
    // — a FORMA das tags e que nao depende do conteudo.
    const entre = bloco.split('<skill_instructions>')[1]?.split('</skill_instructions>')[0]
    assert.equal(entre, '\n\n', 'entre as tags so ha a linha vazia do conteudo')
  })
})

/* ========================================================================== */
/* O espelho estrutural dos tipos — compilar e a verificacao                  */
/* ========================================================================== */

describe('o espelho ESTRUTURAL dos tipos do harness (compilar = forma certa)', () => {
  it('HarnessTextBlock: o dispatch so emite TEXTO (os outros blocos nao sao consumidos)', () => {
    const bloco: HarnessTextBlock = { type: 'text', text: 'saida do modelo' }
    assert.equal(bloco.text, 'saida do modelo')
  })

  it('HarnessStopReason: os CINCO stop reasons do harness (SubagentStopReason)', () => {
    const razoes: readonly HarnessStopReason[] = ['completed', 'aborted', 'error', 'max-tokens', 'refusal']
    assert.equal(razoes.length, 5)
    assert.deepEqual([...razoes].toSorted(), ['aborted', 'completed', 'error', 'max-tokens', 'refusal'])
  })

  it('HarnessSubagentResult: output + diagnostic opcional + stopReason (SubagentResult)', () => {
    const comDiagnostico: HarnessSubagentResult = {
      output: [{ type: 'text', text: 'feito' }],
      diagnostic: 'rastro do modelo',
      stopReason: 'completed',
    }
    const semDiagnostico: HarnessSubagentResult = { output: [], stopReason: 'error' }
    assert.equal(comDiagnostico.diagnostic, 'rastro do modelo')
    assert.equal(semDiagnostico.diagnostic, undefined)
  })

  it('HarnessSubagentRun: `result` + `dispose` — o contrato "always dispose"', async () => {
    let disposicoes = 0
    const run: HarnessSubagentRun = {
      id: 'run-1',
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: async (): Promise<void> => {
        disposicoes += 1
      },
    }
    const resultado = await run.result
    assert.equal(resultado.stopReason, 'completed')
    await run.dispose()
    assert.equal(disposicoes, 1)
  })

  it('HarnessSubagentStartRequest: label OPCIONAL; parent e signal OBRIGATORIOS; prompt so texto', () => {
    const parent: HarnessAgent = { id: 'agente-1', session: { header: { cwd: '/workspace' } } }
    const request: HarnessSubagentStartRequest = {
      prompt: [{ type: 'text', text: 'faz isto' }],
      parent,
      signal: new AbortController().signal,
    }
    assert.equal(request.parent.session.header.cwd, '/workspace', 'o cwd do pai e o workspace do filho')
    assert.equal(request.label, undefined, 'o label e opcional')
    assert.equal(request.prompt[0]?.type, 'text')
  })

  it('HarnessSubagentRuntime.start: valida capacidades e despacha pelo NOME do provedor', async () => {
    const run: HarnessSubagentRun = {
      id: 'r',
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: async (): Promise<void> => {},
    }
    const runtime: HarnessSubagentRuntime = {
      start: async (name: string, request: HarnessSubagentStartRequest): Promise<HarnessSubagentRun> => {
        assert.equal(name, 'spawn', 'o provedor in-process e o `spawn`')
        assert.equal(request.prompt[0]?.type, 'text')
        return run
      },
    }
    const handle = await runtime.start('spawn', {
      prompt: [{ type: 'text', text: 'x' }],
      parent: { id: 'p', session: { header: { cwd: '/w' } } },
      signal: new AbortController().signal,
    })
    assert.equal(handle.id, 'r')
  })

  it('HarnessAgentRegistry.roots: todos os agentes de topo vivos, em ordem de registo', () => {
    const raiz: HarnessAgent = { id: 'raiz', session: { header: { cwd: '/w' } } }
    const registry: HarnessAgentRegistry = { roots: (): readonly HarnessAgent[] => [raiz] }
    assert.equal(registry.roots()[0]?.id, 'raiz')
    assert.equal(registry.roots().length, 1)
  })

  it('HarnessSkillRegistry.get: cwd/signal/scope OPCIONAIS na vista; devolve a definicao ou undefined', async () => {
    const vistos: Array<HarnessSkillViewOptions> = []
    const skills: HarnessSkillRegistry = {
      get: async (name: string, options: HarnessSkillViewOptions): Promise<HarnessSkillDefinition | undefined> => {
        vistos.push(options)
        return name === 'minha-skill' ? SKILL : undefined
      },
    }
    const carregada = await skills.get('minha-skill', {
      cwd: '/w',
      signal: new AbortController().signal,
      scope: { id: 'p', session: { header: { cwd: '/w' } } },
    })
    assert.equal(carregada?.name, SKILL.name)
    assert.equal(vistos[0]?.cwd, '/w', 'a vista com opcoes transporta o cwd')
    assert.equal(vistos[0]?.signal instanceof AbortSignal, true)
    assert.equal(vistos[0]?.scope?.id, 'p')
    assert.equal(await skills.get('outra', {}), undefined, 'a vista SEM opcoes e valida (tudo opcional)')
    assert.deepEqual(vistos[1], {}, 'a segunda chamada nao transporta opcoes nenhumas')
  })

  it('HarnessSkillDefinition: a grammar kebab-case e o corpo markdown', () => {
    const definicao: HarnessSkillDefinition = {
      name: '3d-exemplo',
      description: 'faz modelos 3d',
      content: '# Como usar\n1. Passo.',
    }
    assert.match(definicao.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'a grammar PUBLICA de nomes do harness')
    assert.ok(definicao.content.includes('# Como usar'))
  })
})
