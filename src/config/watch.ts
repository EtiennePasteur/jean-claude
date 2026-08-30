import { watch } from 'chokidar';

/**
 * Watches the config file and calls `onChange` after each save.
 *
 * Only the config file is watched: stub files are re-read on every request, so
 * editing a response takes effect with no reload at all.
 */
export function watchConfig(filePath: string, onChange: () => void | Promise<void>): () => Promise<void> {
  const watcher = watch(filePath, {
    ignoreInitial: true,
    // Editors save by atomic rename, which otherwise fires on a half-written file.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
  });

  watcher.on('change', () => void onChange());
  watcher.on('add', () => void onChange());

  return () => watcher.close();
}
