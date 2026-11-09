<!--
Code pull requests from outside are not accepted for now (see CONTRIBUTING.md); please open an issue for ideas, questions and bug reports.
The checklist below is for the maintainer, or for a change agreed in an issue beforehand.
暂不接受外部的代码 pull request（见 CONTRIBUTING.md）；想法、问题和错误报告请开 issue。
下面的清单给维护者自己用，或用于事先在 issue 里确认过的改动。
-->

## Summary · 改了什么

<!-- One or two sentences on what changed and why; link the issue as "Closes #123". · 一两句话说明改了什么、为什么；关联的 issue 写成 "Closes #123"。 -->

## Parts · 涉及的部分

- [ ] Storewright (part 1) · 第一部分
- [ ] StoreX (part 2) · 第二部分
- [ ] StoreX Chain (part 3) · 第三部分（StoreX 全链路）
- [ ] Repository, documentation or CI · 仓库、文档或 CI

## Checks · 自检

- [ ] Storewright: `npm run check` passes; UI changes keep `npm run e2e` passing. · 第一部分：`npm run check` 通过；界面改动保持 `npm run e2e` 通过。
- [ ] StoreX: `npm run check -w StoreX`, `npm run lint -w StoreX` (no errors) and `npm run build -w StoreX` pass. · 第二部分：这三条命令通过（代码检查没有 error）。
- [ ] StoreX Chain: `npm run check -w StoreX-Chain`, `npm run lint -w StoreX-Chain` (no errors), `npm run build -w StoreX-Chain` and `npm run docs:check -w StoreX-Chain` pass. · 第三部分：这四条命令通过（代码检查没有 error）。
- [ ] If simulation results changed, the reports were regenerated (`npm run reports -w <part>`) and the numbers in the documents updated. · 仿真结果变了的话，重新生成了报告，文档里的数字也同步了。
- [ ] Notable design decisions are recorded in `docs/decisions/`; changes to parts 2 and 3 are noted in their `CHANGELOG.md`. · 重要的设计决定写进了 `docs/decisions/`；第二、三部分的改动记进了各自的 `CHANGELOG.md`。
- [ ] If dependencies changed, `npm run notices` was run. · 依赖变了的话，运行了 `npm run notices`。
- [ ] Public files contain no company or brand names, internal names, local paths or email addresses; only public information and synthetic data. · 公开文件里没有公司或品牌名、内部名称、本地路径和邮箱；只用公开信息和合成数据。

## Notes · 其他说明
