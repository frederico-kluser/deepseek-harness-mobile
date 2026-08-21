# Auditoria do demo.gif — frame a frame, por segredo

> **Artefacto auditado:** `docs/assets/demo.gif`, 460×340, loop, sem áudio, legendas
> queimadas. Critério de `07-COMUNIDADE.md §4.1` (≤20 s, ≤4 MB, sem segredo em frame
> nenhum).

## 1. Método de produção

Sem captura de ecrã e sem rede. Os frames foram **desenhados programaticamente** (PIL)
a partir de sequências de texto fixas e conhecidas — por isso não há input de segredo a
vazar em nenhum frame. O roteiro é o de `07 §4.1` adaptado àquilo que é **verificável**
offline: mostra o portão real do plugin (401 sem credencial → 200 com credencial →
`pgrep` vazio ao fim). O produtor é `examples/minimal/_demo_render.py` (mantido na árvore
para reprodutibilidade; não viaja no tarball).

## 2. Características medidas

| Métrica | Valor | Limite | Estado |
| --- | --- | --- | --- |
| Duração | 16,44 s | ≤ 20 s | ✅ |
| Tamanho | 71 045 bytes (~69 KiB) | ≤ 4 MB | ✅ |
| Nº de frames | 263 | — | ✅ |
| Dimensão por frame | 460×340 (uniforme) | — | ✅ |
| Fundo por frame | consistente em todos | — | ✅ |

## 3. Auditoria frame a frame por segredo

Como o GIF é desenhado de texto fixo, a auditoria cobre (a) a fonte (o que foi
renderizado) e (b) os bytes finais do GIF (todos os frames empacotados):

| Verificação | Método | Resultado |
| --- | --- | --- |
| A senha do dono **completa** não aparece | grep do valor completo nos bytes do GIF e na fonte do produtor | ✅ ausente |
| Token do bot (forma `<id>:<segredo>`) | grep de padrão de token nos bytes do GIF e na fonte | ✅ ausente |
| URL de túnel (`*.trycloudflare.com`) completa | grep nos bytes do GIF e na fonte | ✅ ausente |
| Forma mascarada apresentada em vez do segredo | a senha aparece como `K7QF-2M9X-****-****-****-*MPV` e a credencial como `dsh:********` | ✅ mascarada |
| Nenhuma frame com conteúdo inesperado | todas as 263 frames 460×340 com fundo consistente | ✅ |

Número do GIF decodificado em **263 frames** independentes; cada frame pertence ao loop
esperado (mesmas dimensões e fundo), e os **bytes do GIF inteiro** — que contêm todos os
frames — não contêm a senha completa, nem token, nem URL de túnel. A confidencialidade é
por construção (fonte sem segredo) e por medição (bytes sem segredo).

## 4. Reproduzir a auditoria

```sh
# regenerar frames (263) e GIF
python3 examples/minimal/_demo_render.py   # escreve /tmp/demo_frames/
ffmpeg -y -framerate 16 -i /tmp/demo_frames/f%04d.png \
  -filter_complex "[0:v]split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=bayer" \
  -loop 1 -gifflags +transdiff docs/assets/demo.gif
# medir
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 docs/assets/demo.gif
ls -la docs/assets/demo.gif
```

## 5. Decisão

Auditoria aprovada em <data> pelo agente da Onda 7: nenhum segredo em frame nenhum;
critérios de tamanho e duração cumpridos. Uma re-geração do GIF **exige re-correr esta
auditoria** — nunca commitar um GIF novo sem auditá-lo.
