# dsh-ppt-master

把 [PPT Master](https://github.com/hugohe3/ppt-master)（上游 v6.8.0，MIT）的整套 skill 原样封装成一个 **DeepSeek Harness 插件（bundle）**：装进任意一台装了 DSH 的机器，`/ppt-master` 就能用，生成的仍然是原生可编辑的 `.pptx`。

上游是一个"由 AI 工具执行的 skill/workflow"，不是 npm 包、不是 DSH 插件，也没有任何 JS 入口。这个包做三件事：

1. **原样搬运** `skills/ppt-master/`（13054 个文件、38.1 MiB，`SKILL.md`、`workflows/`、`references/`、`scripts/`、`templates/`）作为不可变 payload，字节不变；
2. **注册为 skill**：插件向 `ctx.skills` 注册一个 provider，技能名 `ppt-master`，加载时把宿主环境说明追加在正文之后（上游正文与完整性闸门保护的四个文件都不改）；
3. **跨平台包装**：`dsh-ppt-master` CLI 负责解释器探测、UTF-8 stdio、可写工作副本、隔离依赖环境，把 skill 里写死的 `python3 ...` / `skills/ppt-master/...` 映射到当前机器。

## 目录结构

```
dsh-ppt-master/
├── package.json           # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml       # 插入一行插件：id ppt-master-skill
├── lib/
│   ├── index.js           # Cordis 插件入口（name/inject/apply）
│   ├── skill.js           # skills provider：list/get、frontmatter 解析
│   ├── host.js            # 路径、解释器探测、工作副本、加载时追加的适配说明
│   └── vendor.js          # 目录统计与 sha256 树摘要
├── bin/ppt-master.mjs     # CLI：doctor / install-deps / run / where / materialize / digest / version
├── scripts/build-vendor.mjs
├── skills/ppt-master/     # 上游 payload（字节不变）
└── VENDOR.json            # 上游仓库、commit、版本、文件数、树摘要
```

## 安装

DSH 的 bundle 就是一个 npm 包，安装/卸载/更新都走官方 `dsh plugin`（内部转发 pnpm，并自动维护 profile 的 `dsh.profile.bundles`，不需要手改清单）。

## 安装

```bash
# 推荐：从 GitHub tag 装（跨机器通用）
dsh plugin --profile web add github:DASHAN-0079/dsh-ppt-master#v6.8.0-dsh.1

# 从本地目录装（开发/调试）
dsh plugin --profile web add C:\Users\yoyok\dsh-ppt-master

# 从 tarball 装（离线机器）
dsh plugin --profile web add ./dsh-ppt-master-6.8.0-dsh.1.tgz
```

确认 bundle 层已合成：

```bash
dsh --profile web --dump-config | Select-String ppt-master
```

```text
# == dsh-ppt-master
- id: ppt-master-skill
  name: dsh-ppt-master
```

看到这一层就装好了；会话进程下次启动时加载（本包只注册一个 skill provider，不占端口、不改 UI）。装好后技能目录里会出现 `ppt-master`，也可以 `/ppt-master` 直接调用。

> **不需要 `allowBuilds` 授权**：本包是纯 ESM/JS，没有 `prepare` / `postinstall` 脚本，git 安装不会触发安装期代码执行。仍建议 pin tag 或 `#<sha>`，这样上游无法悄悄换掉你安装的内容。

## 更新

```bash
# 1) 装了 tag 引用：改成新 tag 即可（等价于重新 add）
dsh plugin --profile web add github:DASHAN-0079/dsh-ppt-master#v6.8.0-dsh.2

# 2) 装了分支引用（不带 tag/commit）：直接 update
dsh plugin --profile web update dsh-ppt-master
```

更新后 bundle 层不变，重启进程生效；工作副本会按新 `VENDOR.json` 的树摘要自动重刷，`venv` 与 `~/.ppt-master/.env` 保留。

## 卸载

```bash
dsh plugin --profile web remove dsh-ppt-master
# 可选：清掉工作副本与隔离依赖环境（不影响 projects/ 与 ~/.ppt-master/.env）
Remove-Item -Recurse -Force "$env:DSH_HOME\ppt-master"
```

`remove` 会同时删除依赖和 bundle 层，`ppt-master` 从技能目录消失。POSIX 机器把清目录那行换成 `rm -rf "${DSH_HOME:-$HOME/.dsh}/ppt-master"`。

## 验证

```bash
node <pkg>/bin/ppt-master.mjs doctor
```

```text
ok    python          ~/.dsh/ppt-master/venv/Scripts/python.exe (Python 3.13.3, isolated)
ok    isolated env    ~/.dsh/ppt-master/venv/Scripts/python.exe
ok    integrity gate  exit 0
ok    dependencies    19/19 installed
warn  external tools  missing: ffmpeg, ffprobe, pandoc, magick, soffice
      skill           ~/.dsh/ppt-master/repo/skills/ppt-master
      projects        <会话工作目录>\projects
```

`external tools` 的 warn 是可选项（旁白视频、PDF/DOCX 转换、PPTX 转图片等路由才需要）。

插件本身的契约测试：

```bash
node --test test/     # payload 摘要、frontmatter、list/get、工作副本闸门、apply() 注册与释放
```

## 三条命令

```bash
node <pkg>/bin/ppt-master.mjs doctor          # 建工作副本、跑完整性闸门、查解释器与依赖
node <pkg>/bin/ppt-master.mjs install-deps     # 建隔离环境并装 requirements.txt（--optional 加 OCR）
node <pkg>/bin/ppt-master.mjs run scripts/project_manager.py init my_deck
```

`doctor` 全绿（`ok`）之后，skill 里的所有 `python3 scripts/xxx.py` 都换成 `run scripts/xxx.py`；
`run` 会保证 cwd 是你的项目目录、stdio 是 UTF-8、解释器是选中的那个。

## 路径

| 用途 | 位置 |
| --- | --- |
| 不可变 payload | `<包>/skills/ppt-master` |
| 可写工作副本（skill 实际读取的目录） | `$DSH_HOME/ppt-master/repo/skills/ppt-master` |
| 隔离依赖环境 | `$DSH_HOME/ppt-master/venv` |
| 安装状态 | `$DSH_HOME/ppt-master/host.json` |
| 项目目录 | 会话工作目录下的 `projects/` |
| 用户密钥 | `~/.ppt-master/.env` |

`$DSH_HOME` 未设置时用 `~/.dsh`。环境变量覆盖：`PPT_MASTER_DATA`、`PPT_MASTER_VENV`、`PPT_MASTER_PYTHON`、`PPT_MASTER_SKILL_DIR`。

## 为什么需要"工作副本"

npm/pnpm 的安装目录是不可变的（pnpm 还把它硬链到全局 store），而 skill 会把模板索引写回 `skills/ppt-master/templates/` 之类的路径；直接写会污染 store，甚至在只读安装上失败。所以插件在首次加载时把 payload 复制到 `$DSH_HOME/ppt-master/repo/skills/ppt-master`（按 `VENDOR.json` 的树摘要做版本比对，payload 升级后自动重刷），skill 全程只读写这份副本。挂载时校验失败（摘要不符）不会静默复用旧副本。

## 跨平台做了什么

- **解释器探测**：`PPT_MASTER_PYTHON` → 隔离环境 → `py -3` / `py` / `python3` / `python`（Windows），`python3` / `python`（POSIX），逐个用 `sys.executable` 回读校验；Windows 的 `python3.exe` App Execution Alias（exit 9009）会被识别并跳过——这正是上游 `SKILL.md` 里那条"9009 就改用 python"规则的程序化版本。
- **UTF-8**：所有子进程强制 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`PYTHONLEGACYWINDOWSSTDIO=0`，规避上游 `console_encoding.py` 在非 UTF-8 控制台上的失败。
- **路径**：所有路径由 `node:path` 拼装，`resourceBase` 用正斜杠形式登记，工作副本绝对路径在加载时注入，不依赖 `cd` 或仓库检出。
- **POSIX 语法不掉链子**：上游正文里的 `/tmp/`、`&&`、`$VAR`、`~/`、`powershell.exe` + PowerPoint COM 等写法，由加载时追加的"Runtime adapter"逐条给出替代说法，模型按平台翻译而不是照抄。

## 与原版的差异和限制

1. **完整性闸门不可绕过**。`scripts/attribution_guard.py` 是上游 fail-closed 闸门，任何非零都意味着立即停止。插件不改 `SKILL.md`、`LICENSE`、`SPONSORS.md`、`SPONSORS_CN.md` 和脚本文件，所以闸门照常通过（`doctor` 会跑一遍并记录退出码）；宿主适配说明只追加在**加载时**的正文尾部，磁盘上的文件不变。
2. **依赖按机器安装**。`requirements.txt` 里有 `PyMuPDF`（AGPL-3.0，只被 `pdf_to_md.py` 用到）、`skia-pathops`、`uharfbuzz` 等二进制轮子，必须在本机 `install-deps`；上游建议 Python 3.10–3.14，`doctor` 只保证"能跑 + 闸门通过"，具体版本以 `python --version` 为准。
3. **可选外部工具**：`ffmpeg/ffprobe`（旁白视频）、`pandoc`、`imagemagick`、`soffice`。缺了不会崩，相关路由会在需要时停下来告诉用户。
4. **旁白视频路由**依赖 Windows 桌面版 PowerPoint 的 COM 自动化，其它平台用不了——这是上游能力边界，不是封装引入的。
5. **不复制**仓库根目录的 `.github/`、`projects/`、`docs/`、`AGENTS.md`：它们是仓库维护与文档，不属于 skill 运行时。
6. 上游若改动 `SKILL.md` 结构（例如新增路由或闸门），本包需要重新 vendor 一次；`VENDOR.json` 的树摘要会让不匹配的旧副本失效。

## 维护者：升级上游 payload

```bash
git clone --depth 1 https://github.com/hugohe3/ppt-master <src>
robocopy <src>\skills\ppt-master <pkg>\skills\ppt-master /MIR
node <pkg>\scripts\build-vendor.mjs        # 刷新 VENDOR.json（commit/版本/摘要）
node <pkg>\bin\ppt-master.mjs materialize  # 重刷工作副本
node <pkg>\bin\ppt-master.mjs doctor
```

## 许可

封装层 MIT。`skills/ppt-master/**` 来自 PPT Master，同样 MIT，版权归 Hugo He（见 `skills/ppt-master/LICENSE` 与 `SPONSORS.md`）；本包不做二次分发之外的任何修改，也不代表上游立场。
