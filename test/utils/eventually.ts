/**
 * Retries an assertion until it passes or `timeoutMs` runs out, for side
 * effects the app performs after answering (event handlers writing
 * notifications, counters, audit lines). Rethrows the last failure.
 */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 3_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
