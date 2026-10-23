# Contributing · 参与贡献

Thank you for your interest in Storewright. · 感谢你对 Storewright 的关注。

## Before you start · 开始之前

- **Only public information.** This project is built from public information and its own design. Do not contribute anything taken from an employer or another company: no internal documents, screenshots, system names, data or metrics. · **只用公开信息。** 本项目只基于公开资料和自己的设计。请不要贡献任何来自雇主或其他公司的内容：内部文档、截图、系统名称、数据或指标都不行。
- **Open an issue first** for larger changes, so we can agree on the approach. · 较大的改动请**先开一个 issue** 讨论做法。

## Set up · 环境

Node.js 20 or later. · 需要 Node.js 20 或更高版本。

```bash
npm install
```

```bash
npm run check
```

```bash
npm run build:all
```

```bash
npm run e2e
```

`npm run e2e:browsers` also runs WebKit (Safari), Firefox and phone setups after `npx playwright install webkit firefox`. · 先运行 `npx playwright install webkit firefox`，`npm run e2e:browsers` 还会在 WebKit（Safari 内核）、Firefox 和手机上测试。

## Guidelines · 约定

- **Match the surrounding code.** TypeScript throughout; most code comments and design documents are in Chinese, and contributions in English are welcome. · **和周围的代码保持一致。** 全部使用 TypeScript；代码注释和设计文档大多是中文，欢迎用英文贡献。
- **The operations core stays pure.** `decide` returns events or a rejection code; `applyEvent` only applies events. No Chinese string literals in `packages/*` (rejections are codes, translated in the apps). · **作业核心保持纯函数。** `decide` 只返回事件或拒绝代码，`applyEvent` 只应用事件；`packages/*` 里不写中文字符串字面量（拒绝原因是代码，在应用里翻译）。
- **Every UI string goes through `t()`** and needs an English entry; tests fail otherwise. · **界面文字都要经过 `t()`**，并且要有英文译文，否则测试会失败。
- **Tests come with changes.** `npm run check` must pass; UI changes should keep `npm run e2e` passing (add a scenario when behavior changes). Phase 1, AI and industry reports must stay reproducible unless the change is meant to alter them. · **改动要带测试。** `npm run check` 必须通过；界面改动要保持 `npm run e2e` 通过（行为变了就加场景）。除非改动本来就要改变结果，否则 Phase 1、AI 和行业报告要能逐行复现。
- **Record decisions.** Notable design decisions go into `docs/decisions/` as a new record. · **记录决策。** 重要的设计决定写成 `docs/decisions/` 里的一条新记录。

## License of contributions · 贡献的许可

Storewright is dual-licensed: code under [AGPL-3.0](LICENSE) with a commercial license also offered, and documentation under [CC BY 4.0](LICENSE-docs). By submitting a contribution you agree that:

1. your contribution is licensed under the same terms as the files it changes (AGPL-3.0 for code, CC BY 4.0 for documentation); and
2. you grant the project maintainer a perpetual, worldwide, non-exclusive, royalty-free license to use, modify, sublicense and relicense your contribution, including under commercial terms; and
3. you have the right to make the contribution (it is your own work, or you have permission, and it contains no confidential information of anyone else).

If you do not agree, please open an issue describing the idea instead of a pull request.

Storewright 采用双许可：代码使用 [AGPL-3.0](LICENSE)，另提供商业许可；文档使用 [CC BY 4.0](LICENSE-docs)。提交贡献即表示你同意：

1. 你的贡献按它所修改文件的许可发布（代码 AGPL-3.0，文档 CC BY 4.0）；
2. 你授予项目维护者永久、全球、非独占、免费的许可，可以使用、修改、再许可和以其他条款（包括商业条款）发布你的贡献；
3. 你有权提交这份贡献（是你自己的作品或已获得许可，并且不含任何人的保密信息）。

如果不同意，请改为开一个 issue 描述你的想法，而不是提交 pull request。
