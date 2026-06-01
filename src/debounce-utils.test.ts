import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./debounce-utils";

describe("createDebouncedSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the save once after the idle delay", () => {
    const save = vi.fn<() => void>();
    const saver = createDebouncedSaver(save, 600);

    saver.schedule();
    expect(save).not.toHaveBeenCalled();
    expect(saver.pending).toBe(true);

    vi.advanceTimersByTime(599);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saver.pending).toBe(false);
  });

  it("coalesces rapid schedule calls into a single trailing save", () => {
    const save = vi.fn<() => void>();
    const saver = createDebouncedSaver(save, 600);

    saver.schedule();
    vi.advanceTimersByTime(300);
    saver.schedule();
    vi.advanceTimersByTime(300);
    saver.schedule();
    vi.advanceTimersByTime(599);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush cancels the pending timer and saves immediately", () => {
    const save = vi.fn<() => void>();
    const saver = createDebouncedSaver(save, 600);

    saver.schedule();
    expect(saver.pending).toBe(true);
    saver.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(saver.pending).toBe(false);

    // The cancelled timer must not fire a second save later.
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush still saves when nothing is scheduled", () => {
    const save = vi.fn<() => void>();
    const saver = createDebouncedSaver(save, 600);

    saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush returns the save promise so callers can await it", async () => {
    const save = vi.fn<() => Promise<void>>(async () => {});
    const saver = createDebouncedSaver(save, 600);

    const result = saver.flush();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending save without running it", () => {
    const save = vi.fn<() => void>();
    const saver = createDebouncedSaver(save, 600);

    saver.schedule();
    saver.cancel();
    expect(saver.pending).toBe(false);

    vi.advanceTimersByTime(600);
    expect(save).not.toHaveBeenCalled();
  });
});
