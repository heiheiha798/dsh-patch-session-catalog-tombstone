# dsh-patch-session-catalog-tombstone

一个可重复应用的本地补丁包，用于已安装的 **DeepSeek Harness** npm 包
（`@deepseek-ai/*`）。它给 subagent catalog 事实增加第三种 **`removed`
（墓碑 / tombstone）** 模式，使被永久删除的 subagent 收回其 catalog 行，
而不是在会话侧边栏里留下一条幽灵记录。

该改动没有出现在已发布的 bundle 中，上游发布线也不包含它，因此只能在本机
`node_modules` 上打补丁。`dsh update` 会从 npm 重装 `node_modules`，把改动
抹掉——本工具包让这个改动可以反复应用、可校验、幂等。

- 运行环境：**Node >= 22**，**零依赖**。
- 已验证版本：**`@deepseek-ai/*` 0.2.2-rc.5**（见下表）。
- 补丁方式：基于**断言过的上游锚点做精确字符串替换**，不使用行号，上游一旦变化
  就失败关闭（fail closed）。

## 修复的问题

`subagent/catalog` 事实是只追加的发现历史。删除子会话时只删除了会话本身，
catalog 事实仍然保留，因此父会话的 `subagentCatalog` 投影继续发布该行，
Web 端也继续把它显示在侧边栏和 lineage 下拉框中。原来的数据结构无法表达
“这个子会话已经不存在”而不重写历史。

## 补丁做了什么

把上游提交 `93e0ef008f`（详见 [docs/upstream-source.md](docs/upstream-source.md)）
回移到编译后的 bundle 中：

1. **新的 catalog 事实变体** —— 声明 `{ version: 3, mode: "removed" }`，并加入
   `eventDataSchema` 联合类型（`dsh-subagent`）。
2. **投影收回该行** —— `subagentCatalogEntries` 记录被墓碑标记的 child id，
   并从发布的视图中过滤掉；catalog 投影的 `stateVersion` 从 6 升到 7
   （`dsh-subagent`）。
3. **恢复校验器接受墓碑** —— 0.2.2 中原生 v3 catalog 载荷全部经过
   `nativeCatalogFact`，因此由它接受 `version === 3 && mode === "removed"`；
   关系校验器遇到墓碑时收回 child id，而不是触发重复检测
   （`dsh-session-format-v3-to-v4`，以及被内联进
   `dsh-session-persistence-jsonl/lib/worker.cjs` 的同一份校验器）。
4. **释放被回收的 name** —— 0.2.2 给每个 child 增加了同级唯一的 `name`，并在
   恢复时拒绝重复 name。由于收回后的视图不再占用已删除 child 的 name，正在运行的
   manager 可能把该 name（或自动生成的 `agent-N`）分配给新的同级。校验器因此
   记录 `id → name`，在墓碑到来时连同 id 一起释放 name，保证这类日志仍可恢复。

日志依然只追加，**会话格式仍为 v4**；只有投影 state version 发生变化。

### 三个锚点（`verify` 检查的内容）

| 包 | 文件 | 断言的标记 |
| --- | --- | --- |
| `@deepseek-ai/dsh-subagent` | `lib/index.js` | 声明 `removedCatalogSchema`；`removed` 加入 `eventDataSchema` 联合；`subagentCatalogEntries` 中的 `removed.size === 0` 过滤；`stateVersion: 7` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | `lib/worker.cjs` | `nativeCatalogFact` 对 `version === 3 && mode === "removed"` 提前返回；墓碑 `ids.delete(id)` 与 `namesById` 分支 |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | `lib/index.js` | 格式校验器中同样的三处改动 |

`scripts/verify.mjs` 对三个文件做 11 个逐字节标记检查，并打印通过/失败表格。

## `dsh update` 之后重新应用

```bash
dsh update
node scripts/apply.mjs          # 重新应用到当前安装
node scripts/verify.mjs         # 必须 exit 0
```

`apply.mjs` 幂等：在已打补丁的树上输出 `already applied` 且不写任何文件。
首次打补丁时会在每个被改文件旁写一次性备份
（`<file>.bak-before-tombstone`），因此改动可回滚。

### 安装根目录解析顺序

`--root` 优先；否则依次为：

1. `$DSH_NODE_MODULES`
2. `$DSH_INSTALL_ROOT`
3. `$_DSH_INSTALL_ROOT`
4. auto-detected: the global npm prefix (`npm prefix -g`) or the real path of the
   `dsh` executable, resolved to `<prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`

根目录是 `@deepseek-ai` **scope 目录**，即包含 `dsh-subagent`、
`dsh-session-persistence-jsonl`、`dsh-session-format-v3-to-v4` 的目录。

## 命令

```bash
# 应用到当前安装（默认根目录），幂等，只备份一次
node scripts/apply.mjs

# 只报告将要发生的改动，不写文件
node scripts/apply.mjs --dry-run

# 只校验：三个文件全部打好才 exit 0
node scripts/apply.mjs --check

# 打印三个目标包的已安装版本
node scripts/apply.mjs --version

# 标记表 + exit 0/1
node scripts/verify.mjs

# 对其他目录树操作（CI、fixtures、暂存副本）
node scripts/apply.mjs --root /path/to/@deepseek-ai
node scripts/verify.mjs --root /path/to/@deepseek-ai

# 测试套件（不需要访问真实安装）
node --test
```

退出码：`0` 成功，`1` 补丁/校验失败，`2` 用法错误。
`--dry-run` 与 `--check` 均不写文件。

### 失败行为

- **标记已存在** → 输出 `already applied` 并跳过（可以随时重复执行）。
- **上游锚点存在** → 按规则做精确字符串替换；写入前断言每个锚点只出现一次。
- **锚点缺失**（上游 bundle 变了）→ 非零退出，并指出包名、文件、规则、标记
  以及已安装版本；不写任何文件，需要针对新构建重新推导锚点。
- **文件只打了一半**（部分规则已应用）→ 非零退出并拒绝覆盖；请还原
  `<file>.bak-before-tombstone` 或重新安装。

## 更新后跳过本补丁的后果

`dsh update` 会把 bundle 还原为上游原始版本。此时，日志中含有 v3 `removed`
catalog 事实的会话在恢复时会被拒绝：v4 校验器抛出
`subagent/catalog requires a supported versioned catalog fact`；已经以
`stateVersion: 7` 持久化的 catalog 投影状态也不会被还原后的
`stateVersion: 6` 定义接受。实际表现：受影响的会话恢复失败，被删除的
subagent 重新出现在 catalog/侧边栏中。

## 已验证版本

| 包 | 版本 | 文件 | 状态 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-subagent` | 0.2.2-rc.5 | `lib/index.js` | 已验证（4 个锚点均按实际安装的 bundle 重新推导） |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.2-rc.5 | `lib/worker.cjs` | 已验证（同上） |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | 0.2.2-rc.5 | `lib/index.js` | 已验证（同上） |

`scripts/verify.mjs` 会为每一行打印已安装版本，因此即使所有标记仍然匹配，
未来版本变化也会显示出来；`apply --check` 始终是权威门禁。

## 仓库结构

```
patches/                       三个 unified diff（路径相对于各包目录）
scripts/spec.mjs               锚点、替换、标记、断言（唯一事实来源）
scripts/apply.mjs              精确字符串应用器：--root/--dry-run/--check/--version
scripts/verify.mjs             标记表，exit 0/1
test/                          node:test 测试套件（单元、verify、可选集成）
fixtures/pristine/             裁剪后的上游原始 bundle 片段（合成 fixture 树）
fixtures/expected/             应用补丁后逐字节期望输出
docs/upstream-source.md        上游提交摘要与规则映射
```

fixtures 是相关 bundle 片段的裁剪副本，不是完整包；测试覆盖幂等性、逐字节输出、
`already applied` 报告、`--dry-run`/`--check`、锚点缺失失败和半打补丁拒绝。
`test/integration.test.mjs` 还会把已安装的 0.2.2-rc.5 bundle 复制到临时根目录、
在副本上打补丁，并断言 `--check`/`verify` 通过、再次应用是逐字节 no-op、且源安装
从未被写入；未安装 dsh 时（例如 CI 中）自动跳过。

## 补丁清单

| 补丁 | 包 | 上游源码 |
| --- | --- | --- |
| `patches/01-dsh-subagent-v3-removed-catalog-fact.patch` | `dsh-subagent` | `src/catalog.ts` |
| `patches/02-dsh-session-persistence-jsonl-catalog-tombstone-validator.patch` | `dsh-session-persistence-jsonl` | `src/facts.ts` + `src/validation.ts`（内联） |
| `patches/03-dsh-session-format-v3-to-v4-catalog-tombstone-validator.patch` | `dsh-session-format-v3-to-v4` | `src/facts.ts` + `src/validation.ts` |

每个补丁都是相对于包目录的普通 `diff -u`，用于审阅与溯源；
`apply.mjs` 执行等价的精确字符串编辑（刻意不依赖 `patch(1)`）。

```bash
# 仅审阅：在原始包目录中 dry-run
patch -p0 --dry-run < patches/01-dsh-subagent-v3-removed-catalog-fact.patch
```

## 回滚

```bash
cd <install root>/dsh-subagent/lib && cp index.js.bak-before-tombstone index.js
# ... dsh-session-persistence-jsonl/lib/worker.cjs 同样处理
# ... dsh-session-format-v3-to-v4/lib/index.js 同样处理
```

或者再次执行 `dsh update`，从 npm 重装原始包。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。上游包代码仍遵循其自身许可证；本仓库只包含 diff、
锚点和工具脚本。
