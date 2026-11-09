# Contributing · 参与贡献

Thank you for your interest in Storewright. · 感谢你对 Storewright 的关注。

## Code contributions are not accepted for now · 暂不接受代码贡献

Storewright is the author's portfolio and contains only the author's own work, so pull requests with code are not accepted for now ([decision 0027](docs/decisions/0027-portfolio-license.md)). Ideas, questions and bug reports are welcome as issues. · Storewright 是作者的作品集，里面只有作者自己的工作，所以暂不接受带代码的 pull request（[决策记录 0027](docs/decisions/0027-portfolio-license.md)）。欢迎用 issue 提想法、问题和错误报告。

When you open an issue: · 开 issue 时：

- **Only public information.** This project is built from public information and its own design. Do not share anything taken from an employer or another company: no internal documents, screenshots, system names, data or metrics. · **只用公开信息。** 本项目只基于公开资料和自己的设计。请不要分享任何来自雇主或其他公司的内容：内部文档、截图、系统名称、数据或指标都不行。
- **No code in issues.** Describe the idea or the problem in words; please do not paste code or anything confidential to you or anyone else. · **issue 里不贴代码。** 用文字描述想法或问题；请不要贴代码，也不要贴你或任何人的保密信息。
- **How ideas are used.** By opening an issue you agree that the ideas in it may be used in Storewright without any obligation to you. · **想法怎么用。** 开 issue 即表示你同意：其中的想法可以用在 Storewright 里，作者对你不承担任何义务。

If code contributions open later, their terms will be written here first. · 以后如果开放代码贡献，会先在这里写明条款。

## Working on your own copy · 在自己的副本上开发

You can build, run and change your own copy as [AGPL-3.0](LICENSE) (code) and [CC BY 4.0](LICENSE-docs) (documentation) allow; the licenses do not grant the right to use the Storewright name or icon. See the [License section of the README](README.md#license--许可证). · 你可以按 [AGPL-3.0](LICENSE)（代码）和 [CC BY 4.0](LICENSE-docs)（文档）在自己的副本上构建、运行和修改；许可证不授予使用 Storewright 名称和图标的权利。详见 [README 的「许可证」一节](README.md#license--许可证)。

Node.js 22 or later. · 需要 Node.js 22 或更高版本。

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

## Conventions this project follows · 本项目遵守的约定

- **Match the surrounding code.** TypeScript throughout; most code comments and design documents are in Chinese. · **和周围的代码保持一致。** 全部使用 TypeScript；代码注释和设计文档大多是中文。
- **The operations core stays pure.** `decide` returns events or a rejection code; `applyEvent` only applies events. No Chinese string literals in `packages/*` (rejections are codes, translated in the apps). · **作业核心保持纯函数。** `decide` 只返回事件或拒绝代码，`applyEvent` 只应用事件；`packages/*` 里不写中文字符串字面量（拒绝原因是代码，在应用里翻译）。
- **Every UI string goes through `t()`** and needs an English entry; tests fail otherwise. · **界面文字都要经过 `t()`**，并且要有英文译文，否则测试会失败。
- **Tests come with changes.** `npm run check` must pass; UI changes keep `npm run e2e` passing (add a scenario when behavior changes). Phase 1, AI and industry reports stay reproducible unless the change is meant to alter them. · **改动要带测试。** `npm run check` 必须通过；界面改动要保持 `npm run e2e` 通过（行为变了就加场景）。除非改动本来就要改变结果，否则 Phase 1、AI 和行业报告要能逐行复现。
- **Record decisions.** Notable design decisions go into `docs/decisions/` as a new record. · **记录决策。** 重要的设计决定写成 `docs/decisions/` 里的一条新记录。

## Parts 2 and 3 · 第二、三部分

The rules above apply to the whole repository, including part 2 ([StoreX](StoreX/README.en.md)) and part 3 ([StoreX Chain](StoreX-Chain/README.en.md)): code contributions are not accepted for now, and issues follow the same public-information rules. The notes below are for working on your own copy. · 上面的规则适用于整个仓库，包括第二部分 [StoreX](StoreX/README.md) 和第三部分 [StoreX 全链路](StoreX-Chain/README.md)：暂不接受代码贡献，issue 同样只用公开信息。下面是在自己的副本上改这两部分时的说明。

Both parts use the dependencies installed at the repository root (run `npm install` there first) and are run from their own folder. · 两部分都用仓库根目录装好的依赖（先在根目录运行 `npm install`），在各自的目录里运行。

```bash
cd StoreX-Chain          # or · 或者: cd StoreX
npm run check            # typecheck + unit tests · 类型检查 + 单元测试
npm run lint             # ESLint: errors must be fixed, warnings are allowed · 代码检查：error 必须改，warning 允许
npm run format:check     # Prettier, run by hand only (not in CI) · 格式检查，只手动运行（不在自动测试里）
npm run reports          # regenerate docs/results/ · 重新生成 docs/results/
```

StoreX Chain also has: · StoreX 全链路另外有：

```bash
npm run docs:sync        # update the marked numbers in the docs from docs/results/data.json · 按 data.json 更新文档里标出来的数字
npm run docs:check       # check them only · 只检查
npm run assistant:eval   # duty assistant evaluation · 值班助手评测
npm run overlaps         # vehicle overlap audit · 车辆重叠审计
node scripts/check3d.mjs # 3D regression check, with npm run dev running · 三维回归检查（开着 npm run dev）
```

- **`docs/results/` is generated.** Only `npm run reports` writes it; never edit it by hand. · **`docs/results/` 是生成的。** 只能由 `npm run reports` 写，不要手改。
- **Numbers in documents come from the data.** In StoreX Chain, numbers taken from the results are marked `<!--n:path|digits|unit-->` and updated with `npm run docs:sync`; `npm run docs:check` must pass ([data dictionary](StoreX-Chain/docs/results/DATA.md)). · **文档里的数字来自数据。** StoreX 全链路文档里取自结果的数字用 `<!--n:路径|小数位|单位-->` 标出来，用 `npm run docs:sync` 更新，`npm run docs:check` 必须通过（见[数据字典](StoreX-Chain/docs/results/DATA.md)）。
- **The default region is frozen.** New region options apply only to random and custom regions; the default region's generation and results must not change (after `npm run reports`, `data.json` differs only in `runtime`). · **默认区域冻结。** 新的区域选项只用于随机、自定义区域；默认区域的生成和结果不能变（`npm run reports` 以后 `data.json` 只有 `runtime` 变化）。
- **Tests come with changes.** `npm run check` must pass in the part you changed. A new duty-assistant intent or tool comes with evaluation questions and a rerun of `npm run assistant:eval`, and the blind test sets are never used for tuning. 3D and vehicle-motion changes keep `node scripts/check3d.mjs` and `npm run overlaps` passing. · **改动要带测试。** 改了哪一部分，那一部分的 `npm run check` 必须通过；新的值班助手意图或工具要加评测题并重跑 `npm run assistant:eval`，盲测题不拿来调；三维和车辆运动的改动要保持 `node scripts/check3d.mjs` 和 `npm run overlaps` 通过。
- **Extending StoreX Chain:** see the [extension guide](StoreX-Chain/docs/05-extending.md) and the [glossary](StoreX-Chain/docs/glossary.md); the twin server's interface is in [protocol.md](StoreX-Chain/server/protocol.md) (English: [protocol.en.md](StoreX-Chain/server/protocol.en.md)), and changes to it update both. · **扩展 StoreX 全链路：** 见[扩展指南](StoreX-Chain/docs/05-extending.md)和[术语表](StoreX-Chain/docs/glossary.md)；孪生服务的接口见 [protocol.md](StoreX-Chain/server/protocol.md)（英文版 [protocol.en.md](StoreX-Chain/server/protocol.en.md)），接口改了两份一起改。
