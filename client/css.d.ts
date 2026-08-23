/**
 * Declaração de módulo para o import de CSS processado pelo esbuild como
 * `text` (ver `scripts/build-client.mjs` — loader `{ '.css': 'text' }`).
 *
 * O guard-panel.css é embebido no bundle como uma STRING e injetado no DOM
 * pelo `apply` num `<style id="dsh-guard-panel-css">`. Este `.d.ts` é o que
 * permite importar `./guard-panel.css` sem o TypeScript a rejeitar o
 * módulo. Apenas declarativo — não entra no bundle.
 */
declare module '*.css' {
  const cssText: string
  export default cssText
}