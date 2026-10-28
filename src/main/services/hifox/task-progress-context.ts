export function taskRule(task: { taskId: string; spaceId: string; inputVersion: string }) {
  return { id: 'team-task', version: task.inputVersion, title: 'Original team task', body: [
    `Task ${task.taskId}; space ${task.spaceId}; input version ${task.inputVersion}.`,
    'This session has one fixed original task handle. If report_progress is present, call it with activity, step and blocker only.',
    'Use short summaries; never report tool contents, raw logs, tokens, credentials or another task identity.',
    'The tool durably queues progress; only a later server acknowledgement confirms remote delivery.',
    'Turn completion means idle. Business stages, plan approval, testing and acceptance use the team task transition actions.',
    'An app-managed working directory is not an operating-system sandbox. Unsupported external ACP signals require manual reporting.'
  ].join('\n') }
}
