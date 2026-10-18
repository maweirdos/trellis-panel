# Git Conventions

> Git commit message format and branch naming conventions.

---

## Commit Message Format

```
type(scope): description

[optional body]

[optional footer]
```

### Language (mandatory)

- Write commit descriptions and prose bodies in **Chinese**, including documentation, tests and tooling commits. Do not copy English descriptions from older history.
- Retain Conventional Commit types and technical scope identifiers, for example `feat(acp): 接入图片输入与预览`.
- Keep code identifiers, paths, product names, issue references and machine-readable trailers unchanged when needed. These do not replace the Chinese explanation.
- Use the same Chinese-description rule for PR titles. State the concrete behavior or reason, rather than vague wording such as `更新代码`.

```text
feat(acp): 接入图片输入与预览
fix(reader): 修复切换项目后旧文档结果覆盖当前内容
docs(git): 明确提交说明使用中文
```

### Types

| Type       | Description                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature                                             |
| `fix`      | Bug fix                                                 |
| `docs`     | Documentation only                                      |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test`     | Adding or updating tests                                |
| `chore`    | Build process, dependencies, or tooling                 |
| `style`    | Formatting, missing semicolons, etc.                    |
| `perf`     | Performance improvement                                 |

### Scopes

Scope should identify the affected area:

| Scope      | Description      |
| ---------- | ---------------- |
| `db`       | Database changes |
| `ipc`      | IPC handlers     |
| `ui`       | User interface   |
| `auth`     | Authentication   |
| `project`  | Project module   |
| `settings` | Settings module  |

### Examples

```bash
# Feature
feat(project): 添加项目归档功能

# Bug fix
fix(db): 修复数据库迁移时序问题

# Refactor
refactor(ipc): 提取公共参数校验逻辑

# Documentation
docs: 更新 API 文档

# Chore
chore: 将 Electron 升级至 v28
```

---

## Branch Naming

```
type/description
```

### Examples

```bash
# Feature branches
feat/project-archive
feat/dark-mode-support

# Bug fix branches
fix/login-crash
fix/db-migration-order

# Refactor branches
refactor/ipc-structure
refactor/type-definitions
```

---

## Commit Best Practices

### Keep Commits Atomic

Each commit should represent one logical change:

```bash
# GOOD - Separate commits
git commit -m "feat(project): 添加归档按钮"
git commit -m "feat(project): 实现项目归档流程"
git commit -m "test(project): 补充项目归档测试"

# BAD - Mixed changes
git commit -m "添加归档功能并修复一些问题"
```

### Write Clear Descriptions

```bash
# GOOD - Clear description
feat(auth): 添加 Google OAuth2 登录

# BAD - Vague
feat: 更新认证
```

### Use Body for Context

```bash
git commit -m "fix(db): 处理迁移中的空时间戳

原迁移假定所有记录均有时间戳，导致从 v1.0 升级时失败。
对空时间戳增加显式处理，保留已有记录。

Fixes #123"
```

---

## Pre-Commit Checklist

Before committing:

- [ ] Code compiles (`npm run typecheck`)
- [ ] Linting passes (`npm run lint`)
- [ ] Tests pass (`npm test`)
- [ ] Commit message follows format
- [ ] Description and prose body are Chinese; technical identifiers may retain their original spelling
- [ ] Changes are atomic

---

## Pull Request Guidelines

### Title Format

Same as commit message:

```
type(scope): description
```

### Description Template

```markdown
## Summary

Brief description of changes.

## Changes

- Added X
- Fixed Y
- Refactored Z

## Testing

- [ ] Unit tests added/updated
- [ ] Manual testing done

## Screenshots

(if applicable)
```

---

## Summary

| Convention     | Format                     | Example                       |
| -------------- | -------------------------- | ----------------------------- |
| Commit message | `type(scope): 中文说明`    | `feat(auth): 添加登录功能`      |
| Branch name    | `type/description`         | `feat/oauth-login`            |
| Commit body    | Optional Chinese context   | 中文说明变更原因与行为         |
| PR title       | Same as commit             | `feat(auth): 添加 OAuth 登录`  |
