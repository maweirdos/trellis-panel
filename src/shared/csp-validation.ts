import { z } from 'zod'

// Both Electron worlds enforce a CSP that forbids generating validation code.
z.config({ jitless: true })
