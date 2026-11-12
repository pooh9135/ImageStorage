type PointerPosition = { x: number; y: number };

export type ListManagerPointerEvent = {
  pointerId: number;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  isPrimary?: boolean;
};

export type ListManagerPointerCaptureTarget = {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
};

type DragCallbacks = {
  onStart(sourceId: string, x: number, y: number): void;
  onMove(x: number, y: number): void;
  onDrop(sourceId: string): void;
  onEnd(): void;
};

type DragSession = {
  sourceId: string;
  pointerId: number;
  origin: PointerPosition;
  pointer: PointerPosition;
  captureTarget: ListManagerPointerCaptureTarget;
  active: boolean;
  finishing: boolean;
};

/** Own only internal reordering; a press without movement remains an ordinary click. */
export function createListManagerPointerDrag(callbacks: DragCallbacks) {
  let session: DragSession | null = null;

  const clear = (current: DragSession) => {
    if (session !== current) return;
    // Releasing capture can synchronously deliver lostpointercapture.
    session = null;
    try {
      if (current.captureTarget.hasPointerCapture(current.pointerId)) {
        current.captureTarget.releasePointerCapture(current.pointerId);
      }
    } catch {
      // The element or pointer may already have disappeared.
    }
    if (current.active) callbacks.onEnd();
  };

  return {
    begin(event: ListManagerPointerEvent, sourceId: string, captureTarget: ListManagerPointerCaptureTarget) {
      if (session || event.isPrimary === false || event.button !== 0 || !(event.buttons & 1)) return false;
      session = {
        sourceId, pointerId: event.pointerId, captureTarget,
        origin: { x: event.clientX, y: event.clientY },
        pointer: { x: event.clientX, y: event.clientY },
        active: false, finishing: false,
      };
      return true;
    },

    move(event: ListManagerPointerEvent) {
      const current = session;
      if (!current || current.finishing || event.pointerId !== current.pointerId) return false;
      if (!(event.buttons & 1)) { clear(current); return false; }
      current.pointer = { x: event.clientX, y: event.clientY };
      if (!current.active) {
        if (Math.hypot(event.clientX - current.origin.x, event.clientY - current.origin.y) < 6) return false;
        try {
          current.captureTarget.setPointerCapture(current.pointerId);
        } catch {
          clear(current);
          return false;
        }
        if (session !== current) return false;
        current.active = true;
        try {
          callbacks.onStart(current.sourceId, event.clientX, event.clientY);
        } catch (error) {
          clear(current);
          throw error;
        }
      }
      if (session !== current) return true;
      try {
        callbacks.onMove(event.clientX, event.clientY);
      } catch (error) {
        clear(current);
        throw error;
      }
      return true;
    },

    finish(event: ListManagerPointerEvent) {
      const current = session;
      if (!current || current.finishing || event.pointerId !== current.pointerId) return false;
      const wasActive = current.active;
      current.finishing = true;
      current.pointer = { x: event.clientX, y: event.clientY };
      try {
        if (wasActive) {
          callbacks.onMove(event.clientX, event.clientY);
          if (session === current) callbacks.onDrop(current.sourceId);
        }
      } finally {
        clear(current);
      }
      return wasActive;
    },

    cancel() {
      if (session) clear(session);
    },

    lostCapture(event: Pick<ListManagerPointerEvent, "pointerId">) {
      if (session?.pointerId === event.pointerId) clear(session);
    },

    get active() { return session?.active ?? false; },
    get pointer(): PointerPosition | null { return session ? { ...session.pointer } : null; },
  };
}
