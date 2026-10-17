v0.4.1当前补丁记录：v041-visual-review.md、v041-diagram-renders.json、v041-browser-layout.json及validation.json；仅06b重绘，其余沿用下述v0.4结果。

# 复核记录的版本范围

当前权威记录：validation.json、verify-artifacts.py、diagram-renders.json、v04-visual-review.md、browser-layout.json及screenshots/v04-*.png。验证脚本只读；传入--record才更新本地validation.json。它校验文档合同与引用，不执行产品用例。

baseline-hashes.json、write-plan.json、project-write-result.json、portable-validation.json、visual-review.md和未带v04前缀的旧截图来自v0.3，保留为历史审计，不代表v0.4验证。v0.4写入和打包检查使用v04-*.json；file-manifest.json是本版重新生成的交付文件清单，不含自身和最终ZIP。

所有JSON中的绝对源码/目标路径仅描述本机审计证据，不是跨设备业务链接。包内相对链接与图表可脱离仓库阅读；项目源码本身未打包。
