# DSH Spark Insights

[English](README.md) | 中文

一个 DeepSeek Harness（DSH）插件：读取 Minecraft 服务器用 [spark](https://github.com/lucko/spark) 采集的性能数据（`.sparkprofile` / `.sparkheap`），解析 TPS、MSPT、CPU、内存、GC、线程、热点方法与插件占用，并向 Agent 提供两个只读工具。

## 兼容性

- spark 数据版本 2；同时兼容旧版嵌套 `children` / `time` 格式
- gzip 包装的导出、spark health 原始数据
- Paper / Spigot / Fabric / Forge / NeoForge / 代理端，以及 [spark-nukkit](https://github.com/lucko/spark-extra-platforms/tree/main/spark-nukkit)
- 当前 spark-nukkit 没有实现 tick 统计，因此 Nukkit 导出没有 TPS / MSPT / tick 计数；窗口统计回退为固定时间桶（含 CPU 占用），工具会按 CPU 排序并明确标注；CPU、内存、GC、线程、热点、来源归因和堆摘要仍可用

## 功能

- 自动识别并解压 gzip 包装，解析 spark 的 protobuf 导出：
  - `.sparkprofile`：采样分析（execution / allocation / lock）
  - `.sparkheap`：堆摘要
  - spark health 原始数据（无采样栈时降级为健康报告）
- 性能快照：TPS、MSPT（median / p95 / max）、CPU（进程 / 系统）、堆内存、GC、磁盘、玩家数、运行时间、世界实体 / 区块
- 采样分析：
  - 线程分组统计：采样量 / 等待占比 / ≈On-CPU（剔除内核等待帧）、合并数 (xN)、顶层帧归属
  - 按 self time 与 inclusive time 排序的热点方法
  - 可检索的调用树
  - 按 tick 窗口筛选热点方法 / 调用树 / 来源归因
  - 按时间窗口的 TPS / MSPT / CPU / 实体 / 区块；无 tick 统计时回退按 CPU 占用排序并标注
  - 插件 / mod 来源归因（spark 的 `classSources` / `methodSources` / `lineSources`）
- 时间序列指标：TPS、MSPT、CPU、堆/非堆、分配速率、世界实体/区块、玩家 ping
- 插件 / mod 列表，世界/实体/game rules/data packs，内存池、网络接口、系统信息
- 堆摘要：按大小、实例数排序的类表
- 自动应用 Mojang mappings，混淆类名/方法名重映射为官方名（见[映射](#映射)）
- 解析结果按文件版本缓存（最近 2 个文件），重复查询不必重新解析

所有解析都在本机完成，不上传导出文件内容或玩家数据；唯一的网络访问是按需下载 Mojang mappings，请求中只包含用于定位映射的 Minecraft 版本号（见[映射](#映射)）。

## 采集数据

在服务器控制台执行（Paper / Spigot / Fabric / Forge 等平台命令语法相同）：

```text
/spark profiler start
/spark profiler stop --save-to-file
```

生成 `.sparkprofile` 文件。堆摘要：

```text
/spark heapsummary --save-to-file
```

生成 `.sparkheap` 文件。把文件放到本机任意可读路径即可。

### Nukkit（NK）

spark 官方额外平台仓库提供了 [spark-nukkit](https://github.com/lucko/spark-extra-platforms/tree/main/spark-nukkit)。它依赖同一套 `spark-common`，导出的 `.sparkprofile` / `.sparkheap` 格式与 Paper / Fabric / NeoForge 等平台完全一致，因此本插件不需要转换即可直接解析。

Nukkit 版目前没有实现 tick 统计（`createTickHook` / `createTickReporter`），所以：

- 平台统计中没有 TPS / MSPT；窗口统计回退为固定时间桶，只含 CPU 占用
- 窗口表会按 CPU 占用排序，并标注 `tick statistics not recorded; windows are time buckets`
- 报告会明确提示 `spark-nukkit build does not expose tick statistics`
- 仍会正常显示 CPU、内存、GC、线程、热点方法、inclusive 时间、来源归因
- 堆摘要同样适用

Nukkit 上导出的文件通常在 `plugins/spark/profile-*.sparkprofile`。

## 工具

### `spark_analyze`

读取一个 spark 导出，返回性能总览：

- 平台、Minecraft / spark 版本、数据版本、采集时间窗口
- TPS / MSPT / CPU / 内存 / GC / 玩家 / 世界概况
- 时间序列指标（TPS / MSPT / CPU / 内存 / 分配 / 世界 / ping）
- 插件 / mod 列表
- 世界、实体类型、内存池、网络、系统信息
- 线程分组
- 热点方法（self + inclusive），支持按 tick 窗口筛选
- 最差 tick 窗口
- 插件 / mod 占用
- 堆摘要（`.sparkheap`）

参数：

| 参数 | 说明 |
|---|---|
| `file_path` | spark 文件路径，相对路径按当前会话工作目录解析 |
| `mappings_path` | 可选，Mojang ProGuard mappings 文件路径（见[映射](#映射)） |
| `thread` | 可选，线程组名称或子串；默认服务端主线程（"Server thread"、"main" 等），否则取 ≈On-CPU 时间最长（剔除内核等待）的线程 |
| `limit` | 热点表行数，1–50，默认 10 |

### `spark_query`

按视图查询同一个文件：

| `view` | 内容 |
|---|---|
| `methods` | 按 self / inclusive 排序的方法表（支持 `query` 过滤） |
| `threads` | 全部线程组，按 ≈On-CPU 时间排序（剔除内核等待帧） |
| `tree` | 调用树；`query` 定位类 / 方法，`depth` 控制匹配点以下的层数，`limit` 为输出行数预算（默认 120，上限 300） |
| `windows` | tick 时间窗口；`sort=time` 或 `sort=worst`（无 tick 统计时 worst 从 MSPT 依次回退到 TPS、CPU 占用） |
| `sources` | 插件 / mod 来源归因 |
| `metrics` | spark 指标时间序列（TPS / MSPT / CPU / 内存 / 分配 / 世界 / ping） |
| `plugins` | 插件 / mod 名称、版本、作者、builtin 标记 |
| `world` | 实体类型、世界、区块、game rules、data packs |
| `system` | CPU、堆、内存池、网络接口、OS / Java / JVM、ping |
| `heap` | 堆类表；`sort=size` 或 `sort=instances` |

`spark_query` 接受与 `spark_analyze` 相同的 `file_path` 和可选 `mappings_path`（见[映射](#映射)），以及上表中的 `view`、`query`、`window`、`depth`、`sort`、`limit`。

`methods`、`tree`、`sources` 支持 `window`（从 1 开始的 tick 窗口序号），用于只分析某个窗口的堆栈。

示例：

```text
spark_analyze(file_path: "profile.sparkprofile")
spark_query(file_path: "profile.sparkprofile", view: "methods", sort: "total", limit: 20)
spark_query(file_path: "profile.sparkprofile", view: "methods", window: 3, limit: 20)
spark_query(file_path: "profile.sparkprofile", view: "tree", query: "tickChunk", depth: 5)
spark_query(file_path: "profile.sparkprofile", view: "sources", limit: 10)
spark_query(file_path: "profile.sparkprofile", view: "metrics")
spark_query(file_path: "profile.sparkprofile", view: "plugins", limit: 50)
spark_query(file_path: "profile.sparkprofile", view: "world")
spark_query(file_path: "profile.sparkprofile", view: "system")
spark_query(file_path: "heap.sparkheap", view: "heap", sort: "instances")
```

## 映射

采样的调用帧仍使用 ProGuard 混淆名时（典型是原版服务端，如 `agh.a`），插件会自动把它们重映射为 Mojang 官方名——热点表、调用树、来源归因、堆类表全部生效。帧本身已经是可读类名时（Paper、Spigot、Forge/NeoForge、Fabric、代理等），插件会根据帧形状跳过版本缓存与下载（平台本身未被整体跳过时，导出文件旁放置的映射文件仍会生效）。来源按以下顺序解析：

1. 显式传入的 `mappings_path` 参数，指向对应版本的 ProGuard mappings 文件（Mojang 的 `server.txt` / `client.txt`）；
2. 导出文件旁的同目录文件：`<导出名>.mappings`、`<导出名>.map`、`server.txt`、`client.txt`；
3. 版本缓存目录 `~/.dsh/spark-insights-mappings/<版本>.txt`——自动下载的映射落盘在这里，也可以手动放入（离线环境友好）；
4. 按 profile 里的 Minecraft 版本从 Mojang piston-meta 自动下载，并写回缓存目录供后续查询复用（同一版本的两个并发首次查询可能各自下载一次）。

所有映射文件都会先解析校验：不是 ProGuard mappings 的文件（误放的 `server.txt`、JSON source map、方向相反的映射等）会被忽略（显式传入时会在报告中说明），既不会被套用，也不会挡住缓存/下载。下载共用一个 25 秒预算，校验通过后才写入缓存；下载瞬时失败的版本约两分钟后才重试（“版本不存在/官方未发布映射”这类确定性结果不会反复请求）。

说明：

- 不需要 Mojang mappings 的平台/导出会跳过并在报告中注明：Paper / Purpur / Folia ≥ 1.20.5 运行时本来就是官方名；Fabric 是 intermediary 名（`class_1234`，需要另一种映射格式）；Nukkit 是基岩版；帧本身可读的 profile 会在有界采样后跳过。显式传入的 `mappings_path` 不受此限制。
- 设置 `SPARK_INSIGHTS_NO_NETWORK=1` 可彻底关闭下载；`SPARK_INSIGHTS_MAPPINGS_DIR` 可移动缓存目录。
- 方法重映射会利用帧上的 JVM descriptor 精确选择重载；`lambda$…` 帧也会改写。同名重载的 descriptor 全都对不上时保留混淆名而不是猜测；没有 descriptor 的旧格式导出会退化为取该混淆名的第一个候选。行号不做重映射；父类不在映射表内时方法名保留混淆名、类名仍会重映射。
- 混淆名会在不同 Minecraft 版本间复用，版本不匹配的映射可能偶然命中少量名字。报告里的 `Mappings` 行会给出实际重映射的帧数；命中数异常偏低通常说明映射文件不属于这个导出。

## 实现说明

- 运行时依赖 `protobufjs`（BSD-3-Clause）。
- 使用官方 spark schema 生成静态 protobuf 解码器（[`lib/spark-pb.js`](lib/spark-pb.js)），metadata / window / heap / health 字段来自 `proto/spark/`。
- 保留手写 wire-format 解码器，用于旧版嵌套 `children` / `time` 格式以及 schema 解码失败时的兼容回退。
- 支持 spark 的扁平化采样树（`childrenRefs` 索引）以及旧版嵌套 `children` / `time` 字段。
- 时间单位遵循 spark：
  - execution：毫秒 CPU 时间
  - allocation：字节
  - lock：毫秒锁等待
- 单文件上限 256 MiB；解压后上限 512 MiB；节点上限 400 万个；树深上限 4096 帧；mappings 文件上限 64 MiB；映射文件先校验后使用，解析结果受缓存预算限制。
- 报告中的时间使用 UTC。
- 自动应用 Mojang mappings（见[映射](#映射)）；Fabric intermediary 名与 Forge / NeoForge SRG 名不做重映射。

## 安装

按包名安装已发布的包：

```text
plugin_manager install_bundle(target: "dsh-spark-insights")
```

或者直接从 GitHub 仓库安装：

```text
plugin_manager install_bundle(target: "https://github.com/MemoriesOfTime/DSH-Spark-Insights")
```

`install_bundle` 会自行解析包并安装依赖（包括 schema 解码器使用的 `protobufjs`）。

开发时，克隆仓库后把目录作为本地 bundle 安装：

```bash
git clone https://github.com/MemoriesOfTime/DSH-Spark-Insights.git dsh-spark-insights
cd dsh-spark-insights
npm install
```

```text
plugin_manager install_bundle(target: "/absolute/path/to/dsh-spark-insights")
```

本地链接安装后，修改源码重启 Harness 即可加载新版本。

安装后两个工具对 Agent 可见；文件通过 Host 的 `ctx.fs` 读取，相对路径使用当前 Session 的工作目录。

## 开发与验证

需要 Node.js 20+ 和 npm。

```bash
npm install
npm test
```

schema 解码器由 [`proto/spark/`](proto/spark/) 生成：

```bash
npm run generate:proto
```

测试包含合成 sampler / heap / health / 旧格式 / allocation / lock / gzip / Nukkit fixture、mappings（解析 / 重映射 / 注入 fetch 的来源解析）、工具注册与文件读取。测试本身不访问网络。真实 spark 导出可作为本地冒烟测试：

```bash
SPARK_SAMPLE=/path/to/profile.sparkprofile npm test
```

未设置 `SPARK_SAMPLE` 时该冒烟测试自动跳过。CI 在 Node.js 20、22、24 上运行测试，并检查 `npm pack` 内容。

## 安全与隐私

- 只读：不修改输入文件，不写入工作区
- 唯一可能的网络请求是按需从 Mojang piston-meta / piston-data 主机（及其重定向）下载官方 mappings（HTTPS）；请求中只包含 Minecraft 版本号，不上传导出文件内容、类名或玩家数据；`SPARK_INSIGHTS_NO_NETWORK=1` 可彻底关闭
- 下载的映射校验通过后才原子写入 `~/.dsh/spark-insights-mappings/`（可用 `SPARK_INSIGHTS_MAPPINGS_DIR` 重定位），后续查询复用缓存（同一版本的两个并发首次查询可能各自下载一次）；无遥测；唯一运行时依赖是 `protobufjs`，插件自身无安装脚本
- 解析不受信任文件时受文件大小、解压大小、节点数、树深与 mappings 大小上限保护
- 详见 [SECURITY.md](SECURITY.md)
