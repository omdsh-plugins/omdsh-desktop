# `@omdsh-plugins/omdsh-desktop`

[English](README.md) | 中文

macOS 与 Windows 桌面应用：一个 Electron 外壳，监管一个内嵌的 `dsh --profile web` 运行时，并在原生窗口中呈现它。它以未签名 `.dmg`（macOS）或 NSIS `.exe`（Windows）交付，由 [`scripts/package-desktop-app.ts`](../scripts/package-desktop-app.ts) 构建，且自包含——Electron 运行时、harness 依赖闭包与已构建的前端全部位于包内，因此安装后的应用不需要代码检出、不需要 Node 安装，也不需要包管理器。决策记录见 harness fork 的 `legacy/all-in-one` 分支上的 Agent Note `2026-08-13-electron-desktop-application`。

外壳不新增任何 harness 能力。它通过运行时的本地回环服务器原样复用已发布的 Web 界面，只拥有浏览器标签页无法承担的部分：进程监管、用户的 shell 环境、原生窗口与菜单行为、提醒信号、一套内存策略，以及运行时在哪台主机上运行的选择。


## 运行时进程

[`src/runtime-supervisor.ts`](src/runtime-supervisor.ts) 将 harness 作为子进程运行而非置于主进程内，因此一次 harness 故障的代价是一次重启而不是整个窗口，其堆上限也独立于 Chromium 之外。该子进程就是 Electron 自身的二进制，运行在 `ELECTRON_RUN_AS_NODE` 模式下——这正是包内不携带第二份 Node 运行时的原因。

| 关注点 | 行为 |
|---|---|
| 启动 | [`src/runtime-launch.ts`](src/runtime-launch.ts) 拥有这条命令行。它包含 `--expose-internals`：Electron 无法加载 Cordis 用来触及 Node 内部模块加载器的 `node-addon-require-builtin` 插件，因此缺少该标志时 HMR 服务会拒绝启动并带崩整次引导。 |
| 就绪 | 以 `dsh web: <url>` 这一行为准，而不是端口开始应答。[`src/readiness.ts`](src/readiness.ts) 跨数据块边界拼接该行，且只在整行完整时才上报。 |
| 端口 | `--port 0`，因此外壳绝不会与终端里启动的 `dsh web` 抢占端口。 |
| 重启 | [`src/restart-policy.ts`](src/restart-policy.ts) 对已正常服务过的运行立即重启，对启动期失败按指数退避，连续五次后停止。会话是持久的，因此一次重启的代价仅是一个进行中的回合。 |
| 关闭 | 运行时收到 `SIGTERM`，由它在自身的五秒上限内释放插件树与子进程；Windows 没有 `SIGTERM`，改为终止该进程。只有在阶梯的宽限期之后才向进程树发信号（Windows 上为 `taskkill /T`），这一步捕获的是卡死运行时未回收的子进程。 |
| 日志 | Electron 的日志目录：macOS 上为 `~/Library/Logs/DeepSeek Harness/runtime.log`，Windows 上为 `%APPDATA%\DeepSeek Harness\logs\runtime.log`；每次运行清空，达到 4 MiB 时轮转。 |

## 用户环境

从 Finder 启动会继承 launchd 的环境，其 `PATH` 只有四个系统目录。智能体要从该 `PATH` 运行用户的工具，因此 [`src/login-environment.ts`](src/login-environment.ts) 在启动时执行一次 `$SHELL -ilc`，读取配置文件组装出的环境，并用标记包裹载荷，使配置文件打印的横幅无法破坏它。当 `PATH` 已带有配置项时跳过探测；探测以五秒为上限，失败则回退到继承的环境。Windows Explorer 与 Linux 桌面会话已经把用户 `PATH` 交给 GUI 应用，因此它们从不探测。

## 窗口行为

窗口直接加载运行时的本地回环源，且不携带 preload，因此 harness 界面运行在沙箱与上下文隔离之下。引导界面（[`resources/boot.html`](resources/boot.html)）是一个本地文件，运行时未在服务时外壳即导航至此；其按钮是 `dsh-action:` 方案的链接，由 [`src/windows.ts`](src/windows.ts) 拦截。窗口几何在开窗前先按当前连接的显示器校验（[`src/window-state.ts`](src/window-state.ts)），因此记录在已拔除显示器上的窗口不会开在屏幕之外。

每个窗口都是同一个源的网页内容，而 harness 界面把窗口所显示的会话按窗口而非按源保存，因此外壳的职责就是说明哪些窗口是新窗口。**新建窗口**加载运行时地址时带上界面的 `new` 参数，窗口即落在属于自己的会话上；首个窗口与 Dock 激活则加载不带参数的地址，恢复上次的会话。该请求在首次加载时即被消耗，因为运行时重启会重新路由已经打开的窗口，而这些都是同一个窗口，并非又一个新窗口。

## 菜单与键盘

外壳只安装一层地板，其上什么都不装：Quit、编辑类 role、窗口类 role——无论有没有 runtime 在跑都必须存在的操作。地板之上的一切都由 runtime 贡献，并在其变化时重建，因此挂载插件菜单就长出来、卸载插件就退回地板，外壳既不重建也不重启。

这个切分完全遵循「各自能做什么」。只有主进程能构建原生菜单、占用应用级组合键，因此外壳发布一份固定的原生能力词汇——`new-window`、`restart-runtime`、`reveal-log`、`open-in-browser`、`toggle-idle-suspend`——由贡献方决定哪些出现、放在哪一栏、绑定什么组合键。某一项也可以归 runtime 自己所有，这时外壳把它的 id 回传，而不是自己执行。

| 文件 | 持有什么 |
|---|---|
| [`src/menu-contract.ts`](src/menu-contract.ts) | 本构建把什么视为合法贡献 |
| [`src/menu-channel.ts`](src/menu-channel.ts) | 跟随承载贡献的事件流 |
| [`src/native-menu.ts`](src/native-menu.ts) | 地板，以及贡献叠加其上后的模板 |

经由该通道到达的一切都是不可信输入。本构建不具备的能力名会被丢弃，而不是渲染成一个按下去毫无反应的条目；无法识别的文档版本会被整体拒绝，而不是读一半——正因如此，贡献方与外壳才能各自独立演进，而这正是「插件挂载到一个已安装的应用上」所要求的。

复选项的状态归外壳而非贡献文档所有：外壳在构建条目时读取自己存储的设置，因此重建不会让勾选状态与它所描述的东西发生漂移。

桌面端开发时对接的贡献方是 [`@omdsh-plugins/omdsh-shortcuts`](https://github.com/omdsh-plugins/omdsh-shortcuts/blob/HEAD/README.md)，它是一个 runtime 插件而非本包的依赖——本仓库对它没有任何构建期认知。

harness 窗口是本外壳并不扩展的网页内容，因此菜单未占用的每一个键都属于窗口内的界面——这也是贡献的组合键避开可打印字符的原因。

引导界面是本仓库唯一持有的键盘，因为它的键只有在窗口正显示该页面时才有含义：`Escape` 停止一次迟迟不就绪的启动，在启动失败时按 `Enter` 重试。

## 提醒与电源

[`src/activity.ts`](src/activity.ts) 折叠运行时自身的帧，这些帧经由 [`AbstractApiClient`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/README.md) 的子类通过 WebSocket 下行通道读取：

- **host 流**在运行时提供服务期间保持打开。它报告哪些会话正在运行，据此在回合运行期间恰好持有防休眠锁，并在没有窗口获得焦点时才发出"任务完成"通知。
- **mux 流**仅在没有窗口获得焦点时打开，承载表示智能体正在等待用户的审批与提问帧。可见窗口本就展示这些请求，因此在用户注视时订阅只会让运行时的帧序列化翻倍而不产生任何新信号。待处理请求呈现为 Dock 角标。

## 内存策略

[`src/resource-governor.ts`](src/resource-governor.ts) 每 30 秒采样一次运行时，并应用一套规则，其首要条款是绝不打断智能体工作：所有回收都只作用于空闲的运行时。空闲且十分钟内没有窗口打开的运行时会被停止，并在下次激活时重启；空闲且占用超过物理内存 35% 的运行时会原地重启。空闲停止在应用菜单中是一个复选项。

## Known Limitations and Deferred Work

- 运行时在本地回环上以操作系统分配的端口提供服务且没有认证，这与 `dsh web` 已有的姿态一致：任何以同一用户身份运行的进程都能触及该 API。Electron IPC 载体可以去掉这个端口，代价是重新实现插件包端点、引导清单注入以及 Web 载体已经提供的下行通道。
- 停止空闲运行时也会停掉调度与作业插件本可在空闲期间运行的工作。菜单复选项可关闭该行为；区分"被调度的工作"与"空闲"的策略暂缓。
- 下行通道的路径名在此重述，因为其常量位于 `packages/client` 包中，而 host 侧 TypeScript 程序有意看不到它。
- 该 macOS 包是即席（ad-hoc）签名而非公证：拷贝到另一台机器时需要 `xattr -dr com.apple.quarantine <app>`。Windows 安装程序未签名；SmartScreen 会警告。
- 没有 CI 门禁覆盖该应用。打包需要 macOS 或 Windows，驱动外壳需要窗口会话；本机打包运行自身的引导冒烟测试才是它所交付闭包的证明。在 macOS 上构建的 Windows 安装程序未经冒烟。
- NSIS 安装程序用 [`build/close-app-processes.nsh`](build/close-app-processes.nsh) 替换 electron-builder 对"应用是否在运行"的检测，因为运行时与外壳共用可执行文件，且它重启自身的速度快过默认检测放弃的速度。macOS 构建主机只能证明该脚本可以编译；关闭路径需要在 Windows 上对一个正在运行的应用做一次覆盖安装来验证。
- 在 Windows 上关闭最后一个窗口会退出应用并停止运行时；在 macOS 上不会。
