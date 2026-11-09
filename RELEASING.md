# Releasing · 发布流程

Parts 2 and 3 (StoreX and StoreX Chain) are released separately: each has its own version, tag and GitHub Release, and the release notes come from its CHANGELOG. Part 1 (Storewright) is not released with tags for now.

第二部分 StoreX 和第三部分 StoreX 全链路分开发布：各自有版本号、标签（tag）和 GitHub Release，发布说明来自各自的 CHANGELOG。第一部分 Storewright 目前不打标签发布。

## 约定 · Conventions

| 部分 | 版本号 | 变更记录 | 标签 | 发布标题 |
|---|---|---|---|---|
| StoreX（第二部分） | `StoreX/package.json` 的 `version` | [`StoreX/CHANGELOG.md`](StoreX/CHANGELOG.md) | `storex-v0.2.0` | StoreX 0.2.0 |
| StoreX 全链路（第三部分） | `StoreX-Chain/package.json` 的 `version` | [`StoreX-Chain/CHANGELOG.md`](StoreX-Chain/CHANGELOG.md) | `storex-chain-v0.2.0` | StoreX Chain 0.2.0 |
| 卸货场引擎库 `@storewright/yard` | `packages/yard/package.json` 的 `version` | [`packages/yard/CHANGELOG.md`](packages/yard/CHANGELOG.md) | `yard-v0.1.0` | @storewright/yard 0.1.0 |
| 车辆重叠审计库 `@storewright/overlap-audit` | `packages/overlap-audit/package.json` 的 `version` | [`packages/overlap-audit/CHANGELOG.md`](packages/overlap-audit/CHANGELOG.md) | `overlap-audit-v0.1.0` | @storewright/overlap-audit 0.1.0 |

- 版本号按[语义化版本 2.0.0](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。1.0 之前，次版本号（0.**x**.0）加 1 表示有新功能或不兼容的改动，修订号（0.2.**x**）加 1 表示只修问题。
- 标签名是「部分名（小写）+ `-v` + 版本号」，一个标签只对应一个部分；用带注释的标签（`git tag -a`）。
- 变更记录按 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)：平时把改动写进最上面的「Unreleased」，发布时把这些内容移到新的版本标题下面，「Unreleased」留空。
- 首个版本 0.2.0 的标题现在写的是「待发布（首次推送时填写日期）」，发布前换成日期。

## 步骤（按顺序）· Steps, in order

前提：`main` 已经推送到 GitHub，上面的自动测试（CI）全部通过。

1. **定版本号和日期。** 两个 `package.json` 的 `version` 和 CHANGELOG 里最新的版本标题一致（现在都是 0.2.0）。把标题里的「待发布（首次推送时填写日期）」换成发布当天的日期（`YYYY-MM-DD`）；检查「Unreleased」是空的，文件底部的比较链接指向新标签。
2. **本地检查。** 在仓库根目录运行 `npm run release:check`：它先核对每个部分的版本号和 CHANGELOG 标题，再按顺序跑下面这些检查（第二部分、第三部分、两个程序库），最后列一张表，有一项没过就不要打标签（`-- --only chain|storex|libs` 只查一部分）。也可以手动运行：

   ```bash
   npm ci
   npm run check -w StoreX && npm run lint -w StoreX && npm run build -w StoreX
   npm run check -w StoreX-Chain && npm run lint -w StoreX-Chain && npm run build -w StoreX-Chain && npm run docs:check -w StoreX-Chain
   ```

   `lint` 只要求没有 error，warning 允许。
3. **提交、推送**第 1 步的改动，等 `main` 上的 CI 全部变绿。CI 没有全绿就不要打标签。
4. **打标签、推送标签**，标签指向刚才变绿的那个提交：

   ```bash
   git tag -a storex-v0.2.0 -m "StoreX 0.2.0"
   git tag -a storex-chain-v0.2.0 -m "StoreX Chain 0.2.0"
   git push origin storex-v0.2.0 storex-chain-v0.2.0
   ```

5. **生成软件物料清单（SBOM，CycloneDX 格式）**，只列运行时依赖，作为发布的附件（这两个文件不提交）：

   ```bash
   npm sbom --sbom-format cyclonedx --omit dev -w StoreX > storex-0.2.0.cdx.json
   npm sbom --sbom-format cyclonedx --omit dev -w StoreX-Chain > storex-chain-0.2.0.cdx.json
   ```

   报 `ESBOMPROBLEMS` 时，说明装好的依赖和要求的版本对不上：先用 `npm ls` 找出标着 `invalid` 或 `missing` 的包，修好再生成。
6. **建 GitHub Release。** 仓库页 → Releases → Draft a new release：
   - Choose a tag 选 `storex-v0.2.0`，标题写 `StoreX 0.2.0`；
   - 说明：复制 `StoreX/CHANGELOG.md` 里 0.2.0 一节（也可以先点 Generate release notes 看一遍这期间合并的 PR，分类见 `.github/release.yml`，再换成 CHANGELOG 的内容）；
   - 把 `storex-0.2.0.cdx.json` 拖进附件区；
   - 0.x 版本可以勾选 Set as a pre-release（可选）；
   - Publish release。

   StoreX 全链路照样做一遍（标签 `storex-chain-v0.2.0`，标题 `StoreX Chain 0.2.0`，附件 `storex-chain-0.2.0.cdx.json`）。也可以用 GitHub 命令行工具，发布说明从 CHANGELOG 里截出来：

   ```bash
   awk '/^## \[0\.2\.0\]/{f=1;next} /^## \[/{f=0} /^\[[^]]+\]: /{next} f' StoreX/CHANGELOG.md > notes-storex.md
   gh release create storex-v0.2.0 --title "StoreX 0.2.0" --notes-file notes-storex.md storex-0.2.0.cdx.json
   ```

   **附件会自动挂上。** 发布（Publish）以后，`.github/workflows/release-assets.yml` 按标签前缀自动构建并上传附件：`storex-chain-v*`、`storex-v*` 挂静态网页包（`<部分>-<版本>-web.zip`，解压后放到任意静态托管就能用）和 SBOM；`yard-v*`、`overlap-audit-v*` 挂 npm 安装包（`.tgz`）和 SBOM。上面第 5 步手动生成 SBOM 的命令留作备用（工作流失败时用）。

7. **（可选）DOI。** 想让每个发布有一个可以引用的 DOI，可以用 Zenodo 和 GitHub 的集成：用 GitHub 账号登录 Zenodo → 在它的 GitHub 设置页打开本仓库的开关 → 之后每次在 GitHub 上发布 Release，Zenodo 自动存档一份并分配 DOI。开关必须在发布**之前**打开，已经发布的 Release 不会补存档。拿到 DOI 以后可以写进 `CITATION.cff`（`doi:` 字段）和 README。
8. **发布之后。** 两个 CHANGELOG 的「Unreleased」保持空着，下一轮改动写进去；`CITATION.cff` 覆盖整个仓库，需要时更新它的 `version` 和 `date-released`。重新部署在线演示（Actions → Deploy demo site → Run workflow），让 `/storex/` 和 `/storex-chain/` 跟上发布的版本。

## 两个程序库 · The two libraries

卸货场引擎 `@storewright/yard` 和车辆重叠审计 `@storewright/overlap-audit`（根目录 `packages/`）各自有版本号和 CHANGELOG，单独打标签（上面的表）。步骤和上面一样，只是：

- 本地检查用 `npm run release:check -- --only libs`（包的测试、打包）。
- `npm run pack:libs` 把每个库编译成 JavaScript 和类型声明，生成可以直接安装的 `dist-pkg/storewright-<名字>-<版本>.tgz`（`dist-pkg/` 不提交）。别人可以用 `npm install <Release 附件的网址>` 安装，不需要 npm 账号。
- **（可选）发布到 npm**：需要你自己的 npm 账号和 `@storewright` 组织（作用域）。在 npmjs.com 建好组织以后：`npm login`，再 `npm publish dist-pkg/storewright-yard-0.1.0.tgz --access public`。这是对外公开的一步，做不做由你决定；不发布到 npm 也不影响从 Release 安装。

## 第一次推送 · The first push

第一次推送按这个顺序：推送 → CI 全绿 → 打标签 → 建发布。

1. 推送前把两个 CHANGELOG 标题里的日期填好（上面第 1 步），这样标签指向的提交里日期已经是对的。
2. 推送 `main`，等 CI 全绿（第 3 步）。
3. 打标签（第 4 步），建发布（第 5、6 步）；要 DOI 的话，在建发布之前打开 Zenodo 的开关（第 7 步）。
4. 部署在线演示，打开下面三个地址检查；没问题以后，把 README 里「（首次推送后可用）」的字样去掉。
   - 第一部分：<https://glacieerr.github.io/storewright/>
   - 第二部分：<https://glacieerr.github.io/storewright/storex/>
   - 第三部分：<https://glacieerr.github.io/storewright/storex-chain/>
