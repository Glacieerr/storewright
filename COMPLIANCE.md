# Compliance statement · 合规声明

> **What this is.** The author's self-declaration and self-check record for Storewright, as of 2026-10-28 (before the first public release). It is not a certificate, and no third party has audited the project. Formal certifications (for example ISO/IEC 27001, SOC 2, PCI DSS, HACCP or an accessibility conformance audit) are issued only by accredited auditors and do not apply to a personal open-source portfolio project in its current form. Section 9 lists what such a review would need.
>
> **这是什么。** 这是作者对 Storewright 的自我声明和自查记录，截至 2026-10-28（第一次公开发布之前）。它不是证书，也没有经过任何第三方审核。正式的认证（例如 ISO/IEC 27001、SOC 2、PCI DSS、HACCP 或无障碍符合性审核）只能由有资质的审核机构出具，不适用于目前这样的个人开源作品集项目。第 9 节列出了真要做正式审核时需要什么。

## 1. Nature of the project · 项目性质

Storewright is a personal open-source portfolio project: a digital twin and store-operations prototype for grocery stores. It is a working prototype and demo, not a product certified for production use. All stores, products, customers, associates and numbers in it are synthetic.

Storewright 是一个个人开源作品集项目：面向超市的门店数字孪生和作业系统原型。它是能运行的原型和演示，不是通过认证、可以直接用于生产的产品。里面所有的门店、商品、顾客、员工和数字都是合成的。

## 2. Independence and information boundary · 独立性与信息边界

- **Not affiliated.** This project is not affiliated with any retailer or company. · **无隶属关系。** 本项目与任何零售商、企业无隶属关系。
- **Public information only.** It is built from public information (news releases, public filings and papers, published patents, general industry knowledge), the author's understanding of common store workflows and the author's own design. It uses no internal documents, screenshots, system names, codes, data or metrics of any employer or company. · **只用公开信息。** 本项目只基于公开信息（新闻稿、公开文件与论文、已公开的专利、行业通用知识）、作者对门店通用工作流的理解和作者自己的设计；没有使用任何雇主或公司的内部文档、截图、系统名称、代号、数据或指标。
- **Original design and neutral names.** The UI, UX, logo and icons were designed for this project and do not imitate any existing system's layout or colors. Product and module names are neutral (Pick, Stage, Handoff and so on) and contain no third-party trademarks. · **原创设计、中性命名。** 界面、交互、logo 和图标都是为本项目设计的，不模仿任何现有系统的布局和配色；产品名和模块名是中性的（拣货、暂存、交付等），不含第三方商标。
- **Recorded as a rule.** The boundary is decision G-02 in [docs/03](docs/03-open-questions.md), and contributors must follow it too ([CONTRIBUTING.md](CONTRIBUTING.md)). The public research documents ([docs/01](docs/01-workflow-design.md), [docs/02](docs/02-feasibility.md)) cite public reports by name only to show where public facts come from. · **写成了规则。** 这条边界是 [docs/03](docs/03-open-questions.md) 里的决定 G-02，贡献者也必须遵守（[CONTRIBUTING.md](CONTRIBUTING.md)）。公开调研文档（[docs/01](docs/01-workflow-design.md)、[docs/02](docs/02-feasibility.md)）点名引用公开报道，只是为了说明公开事实的出处。
- **Patents.** Before implementing methods such as batching, tote assignment, arrival-driven preparation and substitution suggestions, the author read related published patents and designed around them (decision G-11 in [docs/03](docs/03-open-questions.md)). That analysis is a private record and is not published. · **专利。** 实现分批、分框、按到店准备、替代推荐等方法之前，作者阅读了相关的已公开专利并做了规避设计（[docs/03](docs/03-open-questions.md) 的决定 G-11）。规避分析是私人记录，不公开。

## 3. Intellectual property and licenses · 知识产权与许可证

| Item · 项目 | Status · 情况 |
|---|---|
| Code · 代码 | [AGPL-3.0-only](LICENSE) |
| Documentation, pseudocode, reports · 文档、伪代码、报告 | [CC BY 4.0](LICENSE-docs) |
| Third-party packages · 第三方软件包 | 199 run-time packages, all under permissive licenses compatible with AGPL-3.0 (MIT, ISC, BlueOak-1.0.0, Apache-2.0, BSD-3-Clause, 0BSD); listed with their license texts and copyright notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), regenerated with `npm run notices` · 运行时用到 199 个软件包，全部是与 AGPL-3.0 兼容的宽松许可（MIT、ISC、BlueOak-1.0.0、Apache-2.0、BSD-3-Clause、0BSD）；清单、许可文本和版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，用 `npm run notices` 重新生成 |
| Distribution · 分发 | The demo site and the Docker image ship `LICENSE`, `LICENSE-docs` and `THIRD_PARTY_NOTICES.md` ([scripts/build-site.mjs](scripts/build-site.mjs), [Dockerfile](Dockerfile)) · 演示站点和 Docker 镜像都附带 `LICENSE`、`LICENSE-docs` 和 `THIRD_PARTY_NOTICES.md` |
| Assets · 素材 | No third-party 3D models, textures, fonts or images: the 3D world, vehicles and boats are generated in code from public dimensions; the app icon was made for this project; no external fonts are loaded · 没有第三方三维模型、贴图、字体或图片：三维世界、车辆和船按公开尺寸由代码生成；应用图标是为本项目制作的；不加载外部字体 |
| Trademarks · 商标 | "Storewright" is the project's name and is not a registered trademark. Other names that appear in the documents belong to their owners · 「Storewright」是项目名称，不是注册商标；文档中出现的其他名称归各自的所有者 |
| Contributions · 贡献 | Code contributions are not accepted for now: the portfolio contains only the author's own work; ideas and bug reports are welcome as issues, without code or anyone's confidential information ([CONTRIBUTING.md](CONTRIBUTING.md)) · 暂不接受代码贡献：作品集里只有作者自己的工作；欢迎用 issue 提建议和问题，但请不要贴代码或任何人的保密信息 |
| Name and icon · 名称和图标 | The licenses do not grant the right to use the Storewright name or icon · 许可证不授予使用 Storewright 名称和图标的权利 |
| Commercial use by the author · 作者的商业用途 | None. Storewright is a portfolio and everything is in this repository: no paid features, private modules, commercial licenses or paid services ([decision 0027](docs/decisions/0027-portfolio-license.md)) · 没有。Storewright 是作品集，全部内容都在本仓库：没有付费功能、私有模块、商业许可或付费服务（[决策记录 0027](docs/decisions/0027-portfolio-license.md)） |

**Use by others** ([decision 0027](docs/decisions/0027-portfolio-license.md)). Anyone may use, change and share Storewright as AGPL-3.0 and CC BY 4.0 allow, including commercially under their conditions, without any warranty or support. The built-in store templates and the stores built in Your Store are synthetic demo data, not an operating plan for any store. · **别人怎么用**（[决策记录 0027](docs/decisions/0027-portfolio-license.md)）。任何人都可以按 AGPL-3.0 和 CC BY 4.0 使用、修改和分享 Storewright，包括在许可证条件下商用；不提供任何保证或技术支持。内置门店模板和「你的商店」里搭建的门店都是演示用的合成数据，不是任何门店的运营方案。

## 4. Data and privacy · 数据与隐私

- **Synthetic data only.** No real customer, associate or sales data is used anywhere, including tests and reports. · **只有合成数据。** 任何地方（包括测试和报告）都不使用真实的顾客、员工或销售数据。
- **No tracking.** The apps contain no third-party analytics, advertising or tracking scripts. · **不做跟踪。** 应用里没有第三方统计、广告或跟踪脚本。
- **Stays local.** The in-browser demo keeps its data in the browser's IndexedDB on the user's own device and clears operations events after 12 hours without use ([docs/13](docs/13-demo-and-deployment.md)); stores built in Your Store stay in the same browser and leave it only as a file the user exports. The server keeps data in its own database (embedded PGlite or PostgreSQL). · **数据留在本地。** 浏览器内演示的数据保存在用户自己设备上的 IndexedDB 里，超过 12 小时不用会清空作业事件（[docs/13](docs/13-demo-and-deployment.md)）；「你的商店」里搭建的门店也只在这个浏览器里，只有用户自己导出时才会变成文件；服务端的数据保存在它自己的数据库里（嵌入式 PGlite 或 PostgreSQL）。
- **Pickup codes** are stored only as salted SHA-256 hashes; no event contains a code in plain text ([docs/08](docs/08-live-operations.md)). · **取货码**只保存带盐的 SHA-256 哈希，事件里没有任何取货码明文（[docs/08](docs/08-live-operations.md)）。
- **Store AI is local-first.** Models are trained on the store's own (here synthetic) data on the store's machine; with an optional local language model, store data is not sent to outside services ([docs/10](docs/10-store-ai.md)). · **门店 AI 本地优先。** 模型在门店自己的机器上用门店自己的（这里是合成的）数据训练；接入可选的本地语言模型时，门店数据不发到外部服务（[docs/10](docs/10-store-ai.md)）。
- **Associate data ethics** ([docs/10 §9](docs/10-store-ai.md)): staffing is modeled by role and task, not by person; skills and authorizations are explicit inputs; no individual turnover prediction; personal efficiency is shown only to that person and managers see team totals; personal data is deleted or anonymized after a retention period. · **员工数据伦理**（[docs/10 第 9 节](docs/10-store-ai.md)）：按「岗位 + 任务」建模，不按个人建模；技能与授权是明确录入的数据；不预测个人离职风险；个人效率只给本人看，管理者看团队汇总；个人数据过了保留期删除或匿名化。

## 5. Security · 安全

- Vulnerabilities are reported privately as described in [SECURITY.md](SECURITY.md). · 漏洞按 [SECURITY.md](SECURITY.md) 私下报告。
- **The demo has no real sign-in by design** (you pick an identity from a roster). A non-demo deployment needs real authentication, roles and session expiry ([docs/08 §7](docs/08-live-operations.md)), plus `DEMO=0`, a `CONSOLE_KEY` and HTTPS. · **演示版本按设计没有真正的登录**（从名单里选身份）。非演示部署需要真正的登录、角色权限和会话过期（[docs/08 第 7 节](docs/08-live-operations.md)），并设置 `DEMO=0`、`CONSOLE_KEY` 和 HTTPS。
- Shift-lead actions that affect people, money or customers need a second confirmation, and stores can require scanning so taps cannot replace scans ([decision 0026](docs/decisions/0026-flow-fixes.md)). · 带班负责人涉及人、钱、顾客的动作要二次确认；门店可以「要求扫码」，点选不能代替扫码（[决策记录 0026](docs/decisions/0026-flow-fixes.md)）。

## 6. Accessibility · 无障碍

Automated end-to-end checks run on every test run: every control has an accessible name, text contrast meets WCAG 2.1 AA in the light and dark themes, focus is visible, and sign-in works with the keyboard alone ([e2e/a11y.spec.ts](e2e/a11y.spec.ts)). There has been no manual screen-reader test and no formal conformance audit.

每次端到端测试都会自动检查：每个控件都有可访问的名称，浅色和深色主题的文字对比度达到 WCAG 2.1 AA，焦点可见，只用键盘也能登录（[e2e/a11y.spec.ts](e2e/a11y.spec.ts)）。还没有做过人工读屏测试，也没有做过正式的符合性审核。

## 7. Food safety, age checks and other store rules · 食品安全、年龄核验等门店规则

Cold-chain timers, temperature alerts (defaults: chilled above 5 °C, frozen above −15 °C, hot holding below 57 °C), the food safety log, 21+ checks, recalls and incident checklists are workflow aids with configurable defaults taken from public guidance. They are not legal compliance tools and are not legal advice; a store must follow its local laws and its own procedures.

冷链计时、温度告警（默认：冷藏高于 5 °C、冷冻高于 −15 °C、熟食保温低于 57 °C）、食品安全记录、21+ 核验、召回和突发状况清单都是作业辅助，默认值取自公开指南，可以修改。它们不是法规合规工具，也不构成法律意见；门店必须遵守当地法律和自己的规程。

## 8. Use of AI · AI 的使用

- **In the product.** Store AI makes recommendations that always state their reasons, run in a display, confirm or auto mode, go live only after beating simpler baselines, and are downgraded automatically when they keep missing ([docs/10](docs/10-store-ai.md)). No language model is downloaded or bundled. · **产品里的 AI。** 门店 AI 的每条建议都写明理由，分「只显示 / 需确认 / 自动执行」三种模式；比更简单的方法好才上线，连续不准会自动降级（[docs/10](docs/10-store-ai.md)）。没有下载或打包任何语言模型。
- **In development.** Storewright was built with an AI coding assistant (Claude Code by Anthropic). The author set the requirements and business rules, made the design decisions and trade-offs, and reviewed and accepted the results; code, tests and documents were written together with the assistant, and commits carry a `Co-Authored-By` line. · **开发中的 AI。** Storewright 是在 AI 编程助手（Anthropic 的 Claude Code）协助下开发的：作者提出需求和业务规则，做设计决定和取舍，审阅并验收结果；代码、测试和文档由作者和 AI 助手协作完成，提交记录里带有 `Co-Authored-By` 标注。
- **Results are evidence level B**: simulation on synthetic data under stated assumptions, never a claim about a real store ([docs/05 §5](docs/05-evaluation-and-roadmap.md)). · **结果是证据等级 B**：在列明的假设下、用合成数据仿真得到，不代表任何真实门店（[docs/05 第 5 节](docs/05-evaluation-and-roadmap.md)）。

## 9. Self-check, 2026-10-28 · 自查记录（2026-10-28）

| Check · 检查项 | Result · 结果 | How · 方法 |
|---|---|---|
| Third-party licenses · 第三方许可证 | ✅ 199 packages, all permissive and compatible · 199 个，全部宽松、兼容 | `npm run notices` |
| License texts shipped with builds · 分发时附上许可 | ✅ Demo site and Docker image · 演示站点和 Docker 镜像 | `scripts/build-site.mjs`, `Dockerfile` |
| Secrets and credentials · 密钥和凭据 | ✅ None found in the 595 files to be committed · 待提交的 595 个文件里没有发现 | Pattern scan for cloud keys, code-hosting tokens and private keys · 按云服务密钥、代码托管令牌、私钥的格式扫描 |
| Local paths and personal contacts · 本机路径和个人联系方式 | ✅ None, except third-party authors' emails inside their license notices, kept as the licenses require · 没有；第三方作者写在许可声明里的邮箱按许可要求原样保留 | Text scan · 文本扫描 |
| Private modules and licence codes · 私有模块和授权码 | ✅ None: Your Store is in this repository and needs no licence code · 没有：「你的商店」在本仓库里，不需要授权码 | Code search · 代码检索 |
| Private notes and outputs · 私人笔记和输出 | ✅ `private/`, experiment outputs and builds are git-ignored · `private/`、实验输出、构建产物都在 `.gitignore` 里 | `git check-ignore` |
| Tracking scripts · 跟踪脚本 | ✅ None · 没有 | Code search · 代码检索 |
| Accessibility (automated) · 无障碍（自动） | ✅ Passing · 通过 | `npm run e2e` (a11y project) |
| Tests · 测试 | ✅ 383 unit and property tests; 83 end-to-end runs across all browser setups (23 of them on Chrome), all passing; walkthrough of 22 sections and 221 steps with 0 failures (2026-10-29) · 383 个单元与属性测试；全部浏览器的端到端测试 83 个（其中 Chrome 23 个）全部通过；走查 22 个部分、221 步、0 失败（2026-10-29） | `npm run check`, `npm run e2e`, `npm run e2e:browsers` |
| Real sign-in and roles · 真正的登录和角色 | ⚠️ Not built; required before any non-demo deployment · 没有做；任何非演示部署之前必须做 | [docs/08 §7](docs/08-live-operations.md) |
| Source link on a public deployment · 公开部署时的源代码链接 | ⚠️ To add once the repository is public (AGPL-3.0 §13 practice) · 仓库公开后加上（AGPL-3.0 第 13 条的做法） | — |
| Dependency vulnerability audit · 依赖漏洞审计 | ⚠️ Run `npm audit` before deploying · 部署前运行 `npm audit` | — |
| Manual screen-reader test, accessibility audit · 人工读屏测试、无障碍审核 | ⚠️ Not done · 没有做 | — |
| Third-party security review · 第三方安全审核 | ⚠️ Not done · 没有做 | — |
| Real equipment integration · 真实设备联调 | ⚠️ Not done; demo readings are simulated · 没有做；演示读数由仿真产生 | [docs/14 §11](docs/14-digital-twin.md) |

**If a formal review is needed later · 以后真要做正式审核时：** the OpenSSF Best Practices badge (a public self-assessment), REUSE compliance (SPDX headers in every file, checked with `reuse lint`), an accessibility conformance report by an independent auditor, and a third-party security review or penetration test. None of these has been done. · 可以考虑 OpenSSF Best Practices 徽章（公开的自评问卷）、REUSE 合规（每个文件加 SPDX 头，用 `reuse lint` 检查）、独立审核机构出具的无障碍符合性报告、第三方安全审核或渗透测试。以上都还没有做。

— The author, 2026-10-28 · 作者，2026-10-28
