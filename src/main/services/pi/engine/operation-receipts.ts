import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { piOperationReceiptSchema, piRequestIdSchema, type PiOperationReceipt } from '../protocol'

export class PiOperationReceipts {
  private readonly directory: string
  private readonly identity: bigint

  constructor(sessionDirectory: string, create = true) {
    this.directory = join(sessionDirectory, 'operation-receipts')
    if (create) mkdirSync(this.directory, { recursive: true })
    const stat = lstatSync(this.directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.directory) !== this.directory) throw new Error('Pi receipt directory was redirected')
    this.identity = stat.ino
  }

  private file(requestId: string, stage: string): string {
    const stat = lstatSync(this.directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== this.identity || realpathSync(this.directory) !== this.directory) throw new Error('Pi receipt directory changed')
    const digest = createHash('sha256').update(piRequestIdSchema.parse(requestId)).digest('hex')
    return join(this.directory, `${digest}.${stage}.json`)
  }

  claim(receipt: PiOperationReceipt): void { this.write(receipt, 'claim') }
  started(receipt: PiOperationReceipt): void { this.write(receipt, 'start') }
  settle(receipt: PiOperationReceipt): void { this.write(receipt, 'end') }

  private write(receipt: PiOperationReceipt, stage: string): void {
    const file = this.file(receipt.requestId, stage)
    const descriptor = openSync(file, 'wx')
    try {
      writeFileSync(descriptor, JSON.stringify(receipt))
      fsyncSync(descriptor)
    } finally { closeSync(descriptor) }
  }

  read(requestId: string): PiOperationReceipt | null {
    for (const stage of ['end', 'start', 'claim']) {
      const file = this.file(requestId, stage)
      try {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Pi receipt file is invalid')
        const receipt = piOperationReceiptSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
        if (receipt.requestId !== requestId) throw new Error('Pi receipt belongs to another request')
        return receipt
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    return null
  }
}
