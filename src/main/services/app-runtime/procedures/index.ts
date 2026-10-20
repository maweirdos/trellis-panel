import { ApplicationRuntime } from '../lib/controller'

/** Both IPC and the authenticated agent protocol share this one lifecycle owner. */
export const appRuntime = new ApplicationRuntime()
