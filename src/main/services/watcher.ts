import type watch from 'chokidar'

export class TrellisWatcher {
  private watcher: watch.FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private onChange: (() => void) | null = null
  private onFile: ((path: string, ev: 'add' | 'change') => void) | null = null

  /**
   * @param onFile 文件级事件探针（不防抖，add/change 直通）——供 spec 同步等
   *   需要具体文件路径的消费方使用；不传则行为与原先完全一致。
   */
  start(root: string, onChange: () => void, onFile?: (path: string, ev: 'add' | 'change') => void): void {
    this.stop()
    this.onChange = onChange
    this.onFile = onFile ?? null
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
      const fileEvent = (ev: 'add' | 'change') => (path: string): void => {
        this.onFile?.(path, ev)
      }
      this.watcher.on('add', (p) => {
        debounced()
        fileEvent('add')(p)
      })
      this.watcher.on('change', (p) => {
        debounced()
        fileEvent('change')(p)
      })
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
    this.onFile = null
  }
}

function joinSafe(root: string, seg: string): string {
  return root.endsWith('\\') || root.endsWith('/') ? root + seg : `${root}/${seg}`
}
