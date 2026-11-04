/** Shared wording for the actual reviewed-requirement preset and its preflight. */
export const REQUIREMENT_STAGE_IDS = ['implement', 'check'] as const
/** Upper bound on the JSON-encoded stage report included by the next stage. */
export const REQUIREMENT_REPORT_JSON_BYTES = 128 * 1024
export type RequirementStageId = typeof REQUIREMENT_STAGE_IDS[number]

export function requirementStageFile(stage: RequirementStageId): string {
  return stage === 'implement' ? 'implementation.md' : 'test-report.md'
}

export function requirementStageInstruction(taskDir: string, stage: RequirementStageId): string {
  const instruction = stage === 'implement'
    ? '依据已审阅的固定需求、计划、适用规范和现有设计（如有）实际开发，记录实际修改和未完成事项；不得用报告代替代码。实施报告的 JSON 编码不得超过 128 KiB。'
    : '对本任务实际变更执行适用的检查，修复发现的问题，写 test-report.md 记录实际命令、结果与未运行项。不要伪造测试、产品确认或 QA 通过，不要自动归档或更改 Jira 状态。'
  return `${instruction}\n以已审阅的固定需求和计划为基线，不覆盖原始需求和计划。\n任务目录：.trellis/tasks/${taskDir}\n产物写入该任务目录的 ${requirementStageFile(stage)}。遵循项目原有任务权限与工作流；不要修改其他任务。`
}

export function workflowOutputInstruction(paths: string[]): string | null {
  return paths.length ? `Declared task output files: ${paths.join(', ')}. Read the fixed baseline and update only the requested stage. Final completion is subject to the declared output checks.` : null
}

export function requirementContextInstruction(taskDir: string, stage: RequirementStageId): string {
  const path = `.trellis/tasks/${taskDir}/${requirementStageFile(stage)}`
  return [requirementStageInstruction(taskDir, stage), workflowOutputInstruction([path])].filter((value): value is string => value !== null).join('\n\n')
}
