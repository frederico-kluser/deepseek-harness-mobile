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

/**
 * Declaração de módulo para o import do PNG da logo (`../logo.png`) processado
 * pelo esbuild como `dataurl` (ver `scripts/build-client.mjs` — loader
 * `{ '.png': 'dataurl' }`): a imagem é embebida no bundle como uma data URL
 * `data:image/png;base64,...` (o harness serve SÓ `lib/client.js`, sem
 * side-cars). Apenas declarativo — não entra no bundle.
 */
declare module '*.png' {
  const dataUrl: string
  export default dataUrl
}
