# @storewright/labels

Label generation: QR codes that carry only opaque IDs, and tote, piece, case, staging-slot and location labels as SVG previews and ZPL print templates.

标签生成：只编码不透明 ID 的二维码，以及取货框、大件、后仓箱、暂存格位和库位标签的 SVG 预览与 ZPL 打印模板。

## What's inside · 主要内容

- `src/qr.ts`: the QR module matrix (error correction M), an SVG path, and RGBA pixels for decode tests. · 二维码的模块矩阵（纠错等级 M）、SVG 路径，以及用于解码测试的像素。
- `src/tote.ts`: the tote label and the oversized-piece label, 4" × 2" at 203 dpi, monochrome. The temperature zone is shown by an inverted band, an icon, its name and a letter code, without colour. `toteLabelSvg`, `toteLabelZpl`. · 取货框和大件标签，4" × 2"，203 dpi，单色。温区用黑底反白条带、图标、名称和大字母代码表示，不靠颜色。
- `src/case.ts`: the backroom case label (4" × 3": GS1 Digital Link QR code, UPC-A barcode, pack size, received date, optional lot and expiry) and location labels for backroom bins and shelf locations. · 后仓箱标签（4" × 3"：GS1 Digital Link 二维码、UPC-A 条码、箱规、收货日期，可选批号和保质期），以及后仓库位和货架货位标签。
- `src/slot.ts`: the staging-slot label (4" × 1"); its QR code is the slot code. · 暂存格位标签（4" × 1"），二维码内容就是格位编码。
- `src/labels.test.ts`: decodes the QR codes with jsQR and checks the SVG and ZPL output. · 用 jsQR 解码二维码，检查 SVG 和 ZPL 输出。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/labels
```

To see real labels, start the backend; then http://localhost:8787/api/stores/demo/labels/slots shows the staging-slot label sheet. · 想看实际的标签，先启动后端，再打开 http://localhost:8787/api/stores/demo/labels/slots ，就是暂存格位标签。

```bash
npm run server
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`; third-party `qrcode-generator` (and `jsqr` in tests) · 测试还用到 `jsqr`
- **Used by · 使用它的模块：** `@storewright/server`. The hub's label endpoints load it on demand, in Node and in the in-browser demo. · 门店中枢的标签接口按需加载它，Node 后端和浏览器内演示都是这样。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#5-live-operations) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [01 Workflow design](../../docs/01-workflow-design.md): label specification (§5) · 标签规范（第 5 节）
- [Label samples](../../docs/samples/labels.md), with the SVG files in [samples/labels](../../docs/samples/labels/) · 标签样本，SVG 文件在 samples/labels 目录
- [03 Open questions](../../docs/03-open-questions.md): labels and QR codes (section L) · 标签与二维码（L 部分）
- [08 Live operations](../../docs/08-live-operations.md): labels in the associate app (§1) · 员工作业端里的标签（第 1 节）
- [Decision 0008](../../docs/decisions/0008-phase3-plan.md): QR codes, tote label SVG and ZPL in Phase 3 · Phase 3 的二维码、取货框标签 SVG 和 ZPL
- [Decision 0009](../../docs/decisions/0009-phase4-plan.md): case labels with GS1 Digital Link and UPC-A, location labels · 后仓箱标签（GS1 Digital Link 和 UPC-A）、库位标签
- [Decision 0015](../../docs/decisions/0015-v1-release.md): label code loaded only when printing (§2) · 标签代码只在打印时加载（第 2 节）
