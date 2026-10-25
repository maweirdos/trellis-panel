/** Collaboration glyphs share a 24-unit grid and a restrained, theme-aware palette. */
export const COLLABORATION_ICON_COLORS = {
  blue: { light: '#4d6c99', dark: '#9bb6db' },
  teal: { light: '#477f79', dark: '#96c3bb' },
  ochre: { light: '#92713f', dark: '#cdb283' },
  plum: { light: '#80658e', dark: '#bda6ca' },
  rose: { light: '#a25f66', dark: '#d2a0a5' }
} as const

export const COLLABORATION_GLYPHS = {
  overview: { tone: 'blue', fill: 'M4 4h7v7H4zm10 0h6v5h-6zM4 14h7v6H4zm10-2h6v8h-6z', path: 'M4 4h7v7H4zm10 0h6v5h-6zM4 14h7v6H4zm10-2h6v8h-6z' },
  spaces: { tone: 'blue', fill: 'M3 7l9-4 9 4-9 4z', path: 'M3 7l9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4' },
  members: { tone: 'teal', fill: 'M8 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M17 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5', path: 'M8 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M2 20v-3a6 6 0 0 1 12 0v3zM17 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M17 13a5 5 0 0 1 5 5v2h-4' },
  agents: { tone: 'plum', fill: 'M5 7h14v13H5z', path: 'M7 7h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2M12 3v4M2 11v5M22 11v5M9 12v1M15 12v1M9 17h6' },
  crews: { tone: 'plum', fill: 'M9 3h6v6H9zM3 15h6v6H3zm12 0h6v6h-6z', path: 'M9 3h6v6H9zM3 15h6v6H3zm12 0h6v6h-6zM12 9v3M6 15v-3h12v3' },
  skills: { tone: 'ochre', fill: 'M5 4h14v16H5z', path: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M9 8l-2 3 2 3M15 8l2 3-2 3M13 7l-2 8M9 18h6' },
  tasks: { tone: 'blue', fill: 'M5 4h14v17H5z', path: 'M8 4H5v17h14V4h-3M9 2h6v5H9zM8 12l1.5 1.5L12 11M14 12h2M8 17h8' },
  board: { tone: 'blue', fill: 'M4 7h4v7H4zm6 0h4v11h-4zm6 0h4v4h-4z', path: 'M3 3h18v18H3zM8 3v18M15 3v18M5 8h1M10 8h3M10 12h3M17 8h2' },
  inbox: { tone: 'teal', fill: 'M3 12h5l2 3h4l2-3h5v8H3z', path: 'M3 12l3-8h12l3 8v8H3zM3 12h5l2 3h4l2-3h5M9 8h6' },
  triage: { tone: 'ochre', fill: 'M3 4h18l-7 8v7l-4 2v-9z', path: 'M3 4h18l-7 8v7l-4 2v-9zM8 8h8' },
  projects: { tone: 'ochre', fill: 'M4 6h16v15H4z', path: 'M4 6h6l2-3h8v18H4zM8 11h8M8 15h5M8 18h8' },
  iterations: { tone: 'teal', fill: 'M4 7h16v14H4z', path: 'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16M8 14h3v3H8zM15 14h1M15 17h1' },
  automations: { tone: 'plum', fill: 'M3 3h7v7H3zm11 11h7v7h-7z', path: 'M3 3h7v7H3zm11 11h7v7h-7zM14 6h4v4M18 6l-6 6M10 18H6v-4M6 18l6-6' },
  review: { tone: 'ochre', fill: 'M3 5h15v14H3z', path: 'M11 20H3V4h15v6M7 8h7M7 12h3M14 16l2 2 5-6' },
  done: { tone: 'teal', fill: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M8 12l3 3 5-6' },
  blocked: { tone: 'rose', fill: 'M8 3h8l5 5v8l-5 5H8l-5-5V8z', path: 'M8 3h8l5 5v8l-5 5H8l-5-5V8zM12 7v6M12 17h.01' },
  backlog: { tone: 'blue', fill: 'M4 5h16v15H4z', path: 'M4 5h16v15H4zM4 10h16M8 15h8' },
  todo: { tone: 'blue', fill: 'M5 4h14v16H5z', path: 'M5 4h14v16H5zM8 8h8M8 12h5M8 16h3' },
  in_progress: { tone: 'blue', fill: 'M12 3a9 9 0 1 0 0 18V3z', path: 'M12 3a9 9 0 1 0 9 9M12 3v9l6 4M16 4h.01M20 8h.01' },
  cancelled: { tone: 'rose', fill: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M8 8l8 8M16 8l-8 8' },
  relation: { tone: 'blue', fill: 'M3 12l5-5 4 4-5 5z', path: 'M10 7l2-2a4 4 0 0 1 6 6l-2 2M14 17l-2 2a4 4 0 0 1-6-6l2-2M9 15l6-6' },
  comment: { tone: 'teal', fill: 'M3 4h18v13H9l-6 4z', path: 'M3 4h18v13H9l-6 4zM7 8h10M7 12h6' },
  activity: { tone: 'blue', fill: 'M3 3h18v18H3z', path: 'M3 12h4l3-7 4 14 3-7h4' },
  reports: { tone: 'ochre', fill: 'M5 3h10l4 4v14H5z', path: 'M5 3h10l4 4v14H5zM15 3v5h4M9 17v-3M12 17v-6M15 17v-4' }
} as const

export type CollaborationIconName = keyof typeof COLLABORATION_GLYPHS
