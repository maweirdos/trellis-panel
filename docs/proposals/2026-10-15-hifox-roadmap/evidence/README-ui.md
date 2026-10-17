# v0.5 UI证据说明

当前范围为登录网页，原生HiFox未操作。ui-evidence.json为25条记录，其中19张JPEG经保存后目检、6条仅结构。图片为原始捕获或捕获时裁切，未生成/修补内容；剪裁目的记录在privacy字段。未收录无效截图、私人会话、主机名/所有者行及凭据。ui-coverage.json/CSV按原U01–U22逐检查点记录边界，非全路径通过。ux-findings.json为设计分析；ux-acceptance.json在上级目录，均not_run。截图哈希可校验，网页构建版本未知，时间来自执行会话。UI23–25只记录观察日期，未伪造精确时间。


v0.5.1修正UI03为1000×900。viewport是会话中CSS像素视口，image_size是JPEG头解析出的编码图片像素；viewport_crop说明隐私裁切，两者不可混用。U08仅结构，UI06为独立会话入口参考。图片字节没有修改。
