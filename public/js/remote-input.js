// Captura de mouse e teclado sobre a tela remota (lado de quem presta suporte).
// Converte a posição do ponteiro para coordenadas 0–1 da imagem real, descontando as
// faixas pretas de "object-fit: contain". O teclado só é enviado com a tela em foco.

// Retângulo onde a imagem aparece dentro do elemento de vídeo.
export function contentRect(box, videoWidth, videoHeight) {
  if (!videoWidth || !videoHeight || !box.width || !box.height) return null;
  const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

// Ponto da página -> coordenadas normalizadas. Fora da imagem: null (ou limitado, com `clamp`).
export function normalizePoint(rect, clientX, clientY, { clamp = false } = {}) {
  if (!rect) return null;
  let x = (clientX - rect.left) / rect.width;
  let y = (clientY - rect.top) / rect.height;
  const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (!inside && !clamp) return null;
  x = Math.min(Math.max(x, 0), 1);
  y = Math.min(Math.max(y, 0), 1);
  return { x, y };
}

const flags = (e) => ({ alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey });

// `send(msg)` envia o evento; devolve um objeto com stop().
export function startRemoteInput({ stage, video, send }) {
  let pendingMove = null;
  let frame = 0;
  const rect = () => contentRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);

  const flushMove = () => {
    frame = 0;
    if (pendingMove) send({ kind: 'pointermove', ...pendingMove });
    pendingMove = null;
  };
  const onMove = (e) => {
    const p = normalizePoint(rect(), e.clientX, e.clientY);
    if (!p) return;
    pendingMove = { ...p, ...flags(e) };
    // No máximo um movimento por quadro de tela (~60/s).
    frame ||= requestAnimationFrame(flushMove);
  };
  const onButton = (e) => {
    if (e.button > 2) return;
    const p = normalizePoint(rect(), e.clientX, e.clientY, { clamp: e.type === 'pointerup' });
    if (!p) return;
    if (e.type === 'pointerdown') {
      stage.focus({ preventScroll: true });
      stage.setPointerCapture?.(e.pointerId);
    }
    e.preventDefault();
    send({ kind: e.type, button: e.button, ...p, ...flags(e) });
  };
  const onWheel = (e) => {
    const p = normalizePoint(rect(), e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    const deltaY = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    send({ kind: 'wheel', deltaY: Math.max(-10_000, Math.min(10_000, deltaY)), ...p, ...flags(e) });
  };
  const onKey = (e) => {
    if (e.isComposing) return;
    e.preventDefault();
    send({ kind: e.type, code: e.code.slice(0, 32), key: e.key.slice(0, 32), ...flags(e) });
  };
  const block = (e) => e.preventDefault();

  stage.tabIndex = 0;
  stage.classList.add('controlling');
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerdown', onButton);
  stage.addEventListener('pointerup', onButton);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('keydown', onKey);
  stage.addEventListener('keyup', onKey);
  stage.addEventListener('contextmenu', block);
  stage.focus({ preventScroll: true });

  return {
    stop() {
      cancelAnimationFrame(frame);
      stage.classList.remove('controlling');
      stage.removeAttribute('tabindex');
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerdown', onButton);
      stage.removeEventListener('pointerup', onButton);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('keydown', onKey);
      stage.removeEventListener('keyup', onKey);
      stage.removeEventListener('contextmenu', block);
    },
  };
}
