type ScrollHost = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight" | "getBoundingClientRect">;

/** One animation loop keeps scrolling even when the dragged image is held still at an edge. */
export function createListManagerAutoScroll(
  host: ScrollHost,
  isDragging: () => boolean,
  onScroll: (x: number, y: number) => void,
  frames = {
    request: (callback: FrameRequestCallback) => window.requestAnimationFrame(callback),
    cancel: (id: number) => window.cancelAnimationFrame(id),
  },
) {
  let pointer: { x: number; y: number } | null = null;
  let frame: number | null = null;
  let previousTime: number | null = null;
  let currentSpeed = 0;
  let remainder = 0;

  const stop = () => {
    if (frame !== null) frames.cancel(frame);
    frame = null;
    pointer = null;
    previousTime = null;
    currentSpeed = 0;
    remainder = 0;
  };
  const velocity = () => {
    if (!pointer || !isDragging()) return 0;
    const rect = host.getBoundingClientRect();
    if (pointer.x < rect.left || pointer.x > rect.right || pointer.y < rect.top - 24 || pointer.y > rect.bottom + 24) return 0;
    const y = Math.max(rect.top, Math.min(rect.bottom, pointer.y));
    const band = Math.min(64, rect.height / 3);
    if (band <= 0) return 0;
    if (y < rect.top + band) return -1350 * (1 - (y - rect.top) / band);
    if (y > rect.bottom - band) return 1350 * (1 - (rect.bottom - y) / band);
    return 0;
  };
  const tick: FrameRequestCallback = (time) => {
    frame = null;
    const speed = velocity();
    if (!speed || !pointer) { stop(); return; }
    const elapsed = previousTime === null ? 1 / 60 : Math.min(0.032, Math.max(0, (time - previousTime) / 1000));
    previousTime = time;
    if (currentSpeed && Math.sign(currentSpeed) !== Math.sign(speed)) { currentSpeed = 0; remainder = 0; }
    currentSpeed += (speed - currentSpeed) * (1 - Math.exp(-elapsed / 0.1));
    const before = host.scrollTop;
    const limit = Math.max(0, host.scrollHeight - host.clientHeight);
    const next = Math.max(0, Math.min(limit, before + currentSpeed * elapsed + remainder));
    host.scrollTop = next;
    remainder = next - host.scrollTop;
    if (host.scrollTop === before && ((speed < 0 && before <= 0) || (speed > 0 && before >= limit))) { stop(); return; }
    if (host.scrollTop !== before) onScroll(pointer.x, pointer.y);
    frame = frames.request(tick);
  };
  return {
    update(x: number, y: number) {
      pointer = { x, y };
      if (!velocity()) { stop(); return; }
      if (frame === null) frame = frames.request(tick);
    },
    stop,
  };
}
