import type watch from 'chokidar'

export class TrellisWatcher {
  private watcher: watch.FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private onChange: (() => void) | null = null

  start(root: string, onChange: () => void): void {
    this.stop()
    this.onChange = onChange
    // Lazy import keeps startup light and avoids loading chokidar when unused.
    import('chokidar').then(({ watch }) => {
      this.watcher = watch(joinSafe(root, '.trellis'), {
        ignoreInitial: true,
        persistent: true,
        depth: 8,
        ignored: [
          /(^|[/\\])\.backup-[^/\\]*[/\\]/,
          '**/node_modules/**',
          '**/.git/**'
        ]
      })
      const debounced = () => {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => this.onChange?.(), 300)
      }
      this.watcher.on('add', debounced)
      this.watcher.on('change', debounced)
      this.watcher.on('unlink', debounced)
      this.watcher.on('addDir', debounced)
      this.watcher.on('unlinkDir', debounced)
    })
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.watcher) {
      this.watcher.close().catch(() => undefined)
      this.watcher = null
    }
    this.onChange = null
  }
}

function joinSafe(root: string, seg: string): string {
  return root.endsWith('\\') || root.endsWith('/') ? root + seg : `${root}/${seg}`
}
