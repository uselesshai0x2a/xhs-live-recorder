export function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
