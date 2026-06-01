export type DebouncedSaver = {
  /** (Re)start the debounce timer; the save runs once it stays idle for the delay. */
  schedule(): void;
  /** Cancel any pending timer and run the save immediately. Returns the save result. */
  flush(): void | Promise<void>;
  /** Cancel any pending timer without saving. */
  cancel(): void;
  /** Whether a save is currently scheduled. */
  readonly pending: boolean;
};

/**
 * Trailing-edge debounce around a save side effect, with an immediate `flush`
 * for teardown / beforeunload paths.
 *
 * The `save` callback owns the decision of what (if anything) to persist; this
 * helper only manages the timer lifecycle, so the same shape works for both the
 * reading-position scroll saver and the note autosave.
 */
export function createDebouncedSaver(
  save: () => void | Promise<void>,
  delayMs: number,
): DebouncedSaver {
  let handle: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };

  return {
    schedule(): void {
      cancel();
      handle = setTimeout(() => {
        handle = null;
        void save();
      }, delayMs);
    },
    flush(): void | Promise<void> {
      cancel();
      return save();
    },
    cancel,
    get pending(): boolean {
      return handle !== null;
    },
  };
}
