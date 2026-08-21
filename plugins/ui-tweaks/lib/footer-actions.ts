export function mergeRetainedItems<T extends { key: string }>(
  discovered: readonly T[],
  previous: readonly T[],
  retainMissingKeys: ReadonlySet<string>,
): T[] {
  const discoveredKeys = new Set(discovered.map((item) => item.key));
  return [
    ...discovered,
    ...previous.filter(
      (item) =>
        retainMissingKeys.has(item.key) && !discoveredKeys.has(item.key),
    ),
  ];
}
