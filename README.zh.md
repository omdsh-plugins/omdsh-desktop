# omdsh-desktop

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面应用：一个 Electron 外壳，监管一个 harness 运行时，并在它周围补齐原生的那一层——窗口、菜单、活动状态、重启策略，以及看着运行时启动的那个引导页。

这个外壳不属于 harness。它把运行时作为子进程拉起来，通过本地回环 HTTP 跟它说话，所以运行时崩了或者把堆吃光了，只是按外壳自己的策略重启一次，不会把窗口一起带走。

[`app/README.zh.md`](app/README.zh.md) 才是外壳本身的详细说明——运行时进程和它的重启阶梯、登录环境探测、窗口与菜单行为、提醒用的那几条流，以及内存策略。本页说的是它外面这个仓库。

## 目录结构

| 目录 | 是什么 |
|---|---|
| `app/` | Electron 主进程（`@omdsh-plugins/omdsh-desktop`）；`tsdown` 把它打成一个 `lib/main.mjs` |
| `runtime/` | 一份只有依赖的 manifest，写明这个应用交付的是哪个 harness 版本，以及它随身带的那些 omdsh bundle |
| `scripts/` | 打包流水线——闭包、`electron-builder`、引导冒烟、磁盘映像、NSIS 安装程序——以及 harness 与插件的版本来源开关 |
| `assets/` | 应用图标素材 |

## 它内置的 harness 版本

两个文件写着它，而且写的是同一个，今天是 `0.1.0-rc.6`。`runtime/package.json` 是打包流水线真正去安装的那一份：它是工作区之外的一个部署根，那里 `catalog:` 引用无处可解，所以版本号在这里是字面重述一遍的。`pnpm-workspace.yaml` 的 catalog 则是 `app` 解析 API 客户端所依据的那一份。`pnpm run check:harness-pin` 就是这两者一致的证明——只要其中任何一个还挂着 `link:`，它就失败。

工作区把那个版本装在 `runtime/` 下，所以从检出运行时监管的运行时，和打好包的那个内嵌的是同一个——这正是"从源码跑起来"具有代表性的原因。打包读的也是同一个文件。

```sh
pnpm run check:harness-pin        # runtime manifest 和 catalog 指向同一个版本
pnpm run harness:npm              # 对着已发布的版本构建（默认）
pnpm run harness:local ../../deepseek-harness   # 改为对着同级检出构建
```

local 模式把 `@deepseek-ai/dsh` 和 API 客户端用 `link:` 指到一个 harness 检出上。pnpm 不会安装被 link 的包自己的依赖，所以那个检出必须先自己装好、自己构建过（`pnpm run build`）。用它来在外壳里看尚未发布的 harness 改动；准备交付的东西在打包前先用 `harness:npm` 切回去。

## 它内置的插件

安装程序带 [`omdsh-plughub`](https://github.com/omdsh-plugins/omdsh-plughub)，而且刻意只带它一个。

它在这里，是因为它是唯一一个没法用它自己提供的机制装上的插件。装插件这件事就是在终端里 `dsh plugin --profile web add <package>`，而一台刚跑完安装程序的机器，`PATH` 上根本没有 `dsh`——所以一个刚装好的应用打开来，会是一个没有任何途径去装第二个插件的 harness。

往后的每一个插件，hub 都装得了；而一个被冻进安装程序的插件，就被钉在了这个应用的发版节奏上，与此同时依赖它的那些包却在自由更新。`omdsh-base` 是最清楚的例子：它是每一个模式插件的 `peerDependency`，而 profile 是以 `autoInstallPeers: false` 安装的，所以装一个模式插件并不会把它带进来。那是一份可发现性上的代价，交给 hub 去补更合适——缺了它的模式插件是静默地不工作，而不是让页面失败——它不构成把一个共享库冻在这里的理由。

交付哪些 bundle 只声明一处，就是 catalog 里那些 `@omdsh-plugins/*` 条目。

```sh
pnpm run check:plugin-pin       # runtime manifest 处在一份裸克隆装得上的状态
pnpm run plugins:npm            # 交付已发布的版本
pnpm run plugins:local ..       # 改为交付同级检出
pnpm run plugins:none           # 一个都不带，也就是当前提交的状态
```

**默认构建一个插件都不带，而这正是今天提交的状态**，因为 `@omdsh-plugins/omdsh-plughub` 既没发到 npm 也没推上 GitHub——不存在任何一个"只克隆这个仓库"就能解析的 specifier。打包每一次都会把这件事打印出来。要构建一个真的带着 hub 的安装程序，先跑 `plugins:local ..`；等这个包发布了，`plugins:npm` 会让它成为默认。

**刻意不提交的是一条 `link:`。** pnpm 把它按声明它的那份 manifest 解析，所以一份没有同级检出的克隆只会 WARN、退出码 0，然后留下一条断链——打包再把这条断链带进 `.app`，最后 macOS 直接拒绝给这个包签名。`check:plugin-pin` 就是为此对它失败的，CONVENTIONS 第 8 条说的是同一件事。

除此之外，本地 bundle 不给打包添任何麻烦：`scripts/bundled-plugins.ts` 会把每一个先打成 tarball，闭包再从 tarball 装，所以进到产物里的是实打实的文件。`pnpm pack` 会跑各自的 `prepare`，所以那些检出必须先装好。

### 一个内置 bundle 是怎么进到 profile 里的

有三件事必须同时成立，而"把文件装进去"只是第一件。

| | 需要什么 | 在哪里 |
|---|---|---|
| 闭包里带着它 | `runtime/package.json` 的一条依赖，与它声明的每个 peer 平铺在一起 | `scripts/runtime-closure.ts` |
| profile 点名要它 | 追加进 `dsh.profile.bundles`——启动器自带的 `web` 模板里没有它 | `app/src/bundled-plugins.ts` |
| 它的行解析得了 | 在 `$DSH_HOME/profiles/node_modules` 下的一条软链，因为从那里走不到闭包 | `app/src/bundled-plugins.ts` |

第三件才是那件看着已经做完、其实没有的事。Loader 的 `baseUrl` 是 profile 目录，所以 bundle patch 里那些行的裸 specifier，是靠 Node 从 `$DSH_HOME/profiles/<name>/` 往上走找到的——它走到的是启动器维护的那个扁平兜底目录，里面是 dsh 安装自身依赖闭包中每个包的一条软链。一个装在那个安装**旁边**的插件不在这个闭包里，所以外壳自己把它链进去。启动器对那个目录只增不删，所以这条链站得住。

seeding 在运行时启动之前跑，每个 bundle 只提供一次。外壳加过、而用户又从 `dsh.profile.bundles` 里拿掉的 bundle，会一直保持拿掉的状态——外壳把"自己提供过什么"记在它自己的设置文件里，所以这次撤除不会在下次启动时被推翻。它每次启动都会维护的是那条软链，因为换掉应用就是换掉链所指的东西；而一个被列出、却哪里都解析不到的 bundle 会被摘掉，因为那一种对启动器是致命的，不只是缺失。

hub 会把一个被 seed 进来的 bundle 标成不可移除，而这是对的：它判定可移除的标准是"profile 是否依赖它"，而一个被 seed 的 bundle 是 profile 被给予的一层，不是 pnpm 装进来的一条依赖。那正是启动器自带的 `dsh-base` 和 `dsh-web-app` 所在的那一档——对一个 hub 来说也是对的那一档，否则它可以把自己卸掉，而且不留任何装回来的办法。

profile 本身不由这里写。它不存在时，启动器会被以 `--dump-default-config` 跑一次，那会解析 profile 然后退出——大约三分之一秒——所以这个仓库不必自带一份 profile 模板的副本，而那份模板里的 pnpm 设置，恰恰决定了 hub 自己的安装行为。

## 外壳不负责什么

运行时就是窗口旁边的那一个，仅此而已。从另一台主机提供服务，以及"显示 harness"之外的每一项能力，都是运行时该通过插件长出来的东西，而不是外壳绕过它去够的东西。安装程序把这句话坐实了，而不是推翻它：它在闭包里带上了 [`omdsh-plughub`](https://github.com/omdsh-plugins/omdsh-plughub)，因为一台刚跑完安装程序的机器，`PATH` 上没有 `dsh`，也就没有办法装上第一个插件。那是运行时加载的一个 bundle，不是外壳自己持有的能力。打包流水线内嵌的那个闭包，是这里的 [`scripts/runtime-closure.ts`](scripts/runtime-closure.ts) 构建的。

## 键盘映射

外壳认领哪些和弦，写在兄弟仓库 [`omdsh-shortcuts`](https://github.com/omdsh-plugins/omdsh-shortcuts) 里：承载这张映射表的应用菜单、菜单项装不下的那排窗口级功能键，以及让这两者都避开各 role 的和弦和 harness UI 自有和弦的那个单元测试。这个仓库拥有的是那些和弦执行的东西——窗口、运行时、日志——以及引导页自己的 `Escape` 和 `Enter`，它们只在那一页还在屏幕上时才有含义。

## 安装

Node `^22.19.0 || >=24.0.0`，pnpm 11.7.0，正如 `engines` 和 `packageManager` 所写。pnpm 10+ 会拒绝执行任何依赖的安装脚本，直到它被逐个审过，而 `pnpm-workspace.yaml` 就是审的地方：`electron` 在那里被放行，因为它的安装脚本正是去取外壳赖以运行的那个 Electron 二进制的。跳过了这道放行的安装，最后没有二进制可以启动。

### 从源码运行

```sh
pnpm install
pnpm run build
pnpm --filter @omdsh-plugins/omdsh-desktop exec electron .
```

Electron 加载的是 `app/lib/main.mjs`，也就是 `pnpm run build` 写出来的东西，所以构建至少得跑过一次——这里没有 watch 模式，也没有 `dev` 脚本。之后外壳监管的是 `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`，是锁定的那个版本，而不是你 `PATH` 上那个 `dsh`；它跑在你平常的 `~/.dsh` 上，端口由操作系统分配，所以不会跟终端里已经在跑的 `dsh web` 撞上。

从检出运行会拿走和已安装应用同一把单实例锁，因为那把锁是按应用名算的。在一个已安装的 **DeepSeek Harness** 开着的时候启动它，检出这一份会立刻退出，转而把已安装的那个窗口举到前面。给它一个自己的用户数据目录，两个就能同时跑：

```sh
pnpm --filter @omdsh-plugins/omdsh-desktop exec electron . --user-data-dir=/tmp/dsh-desktop-dev
```

### 从构建产物安装

`pnpm run package:desktop` 在 macOS 上产出磁盘映像，在 Windows 上产出 NSIS 安装程序。两者都没有平台信任的证书，所以装的时候各要多做一步：

- **macOS。** 这个包是即席（ad-hoc）签名，不是公证过的，所以拷到另一台机器上会带着隔离标记。拖进 `/Applications`，然后清一次：

  ```sh
  xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
  ```

- **Windows。** 安装程序未签名，SmartScreen 会拦一道。**更多信息 → 仍要运行。**

装好的应用把 Electron 运行时、harness 闭包和构建好的前端全部装在自己包里。落到哪台机器上，都不需要代码检出、不需要 Node 安装、也不需要包管理器。

## 命令

```sh
pnpm install
pnpm run build              # tsc 产出 lib/types，tsdown 打包 Electron 入口
pnpm run typecheck          # app 源码、测试，以及打包脚本
pnpm run test               # vitest
pnpm run check:harness-pin  # runtime manifest 和 catalog 指向同一个版本
pnpm run harness:npm        # 对着已发布的版本构建（默认）
pnpm run harness:local ../../deepseek-harness   # 对着同级检出构建
pnpm run check:plugin-pin   # runtime manifest 处在一份裸克隆装得上的状态
pnpm run plugins:npm        # 交付已发布的版本
pnpm run plugins:local ..   # 改为交付同级检出
pnpm run plugins:none       # 一个都不带（当前提交的状态）
pnpm run package:desktop    # 完整产物
pnpm run clean              # 删掉 app/lib、dist-desktop 和那些 tsbuildinfo
```

`package:desktop` 把锁定的版本装成一个没有符号链接的闭包，按目标平台裁剪，启动一次作为冒烟测试，把应用打在它外面，然后在 macOS 上产出磁盘映像、在 Windows 上产出 NSIS 安装程序。

它自己的参数写在 `--` 后面，这样 pnpm 才不会把它们当成自己的：

```sh
pnpm run package:desktop -- --platform mac|win --arch arm64|x64 --out <dir>
pnpm run package:desktop -- --skip-deploy --skip-smoke --skip-dmg --skip-installer
```

`--platform` 和 `--arch` 都默认取本机，其中 Windows 目标即便在 Apple 芯片上也默认 `x64`。四个 `--skip-*` 各跳过一个阶段——复用已经铺好的闭包、跳过引导冒烟、在磁盘映像前停下、在安装程序前停下——它们是为了反复调试被跳过那一步之后的阶段而存在的，绝不是用来产出要交付的东西的。

每个目标写进各自的目录——`dist-desktop/dist-mac` 或 `dist-desktop/dist-win`——因为铺在下面的闭包是按某一个平台的原生模块裁过的。否则构建另一个目标时，会发现上一次构建的树正站在自己该在的位置上。`--out` 覆盖这个目录，并且原样采用。

## 它从哪里来

从 harness monorepo 的一个 fork 里拆出来，在那边它是 `apps/desktop`。那份 197 条的、生成出来的 runtime manifest 没有了：闭包现在从 registry 解析，所以它交付的版本就是一个版本号。设计理由是那个 fork 的 `legacy/all-in-one` 分支上的 Agent Note `2026-08-13-electron-desktop-application`；那个分支上还留着已被取代的 `package:mac` 和 `package:win` 启动脚本，它们当年包着一整个 monorepo 检出。

## 已知限制

这里是仓库自身的限制；外壳的那些在 [`app/README.zh.md`](app/README.zh.md#已知限制)。

- **只有 macOS 和 Windows。** 打包对任何其他宿主直接拒绝，而且也没有 Linux 目标可以要：产物就是一个 `.dmg` 和一个 NSIS 安装程序。构建和交付两头都不支持 Linux。
- **Windows 产物可以在 macOS 上打，但没法在那里验证。** 可选原生模块是预构建的，NSIS 目标也不需要 Wine，所以打包本身能成——但 Windows 的 Electron 二进制在 macOS 上跑不起来，于是引导冒烟被跳过，产物是没冒过烟的。macOS 产物则必须要一台 macOS 宿主。
- **交叉构建的 Windows 闭包，`pnpm.cmd` 是手写进去的。** pnpm 只按"自己跑在哪个平台"生成 `.bin` 条目，所以从 macOS 打出来的 Windows 闭包里全是 POSIX 软链——Windows 执行不了，hub 也不会去找它。`scripts/runtime-closure.ts` 负责写这个 shim，缺了它打包会直接失败；但 shim 本身只在 Windows 上被人手动跑过，从来没有冒烟测过。
- **在 Windows 上，从 git specifier 装的插件仍然需要一套真的工具链。** 这个 shim 让打包好的 pnpm 能跑起来（通过应用自己的二进制），这对 registry 安装够了——它根本不做构建。而 git 上的插件会在 `prepare` 里自己构建，那需要一个包里没有的 `node.exe`。**刻意没有**一并写 `node.cmd`：它同样会被放到子进程 `PATH` 的最前面，于是一个跑 `tsdown` 的 `prepare` 会变成"加载不了 Rolldown 的 Node-ABI 原生模块"，而不是"找不到 Node"——结果一样，报错更难懂。真正解决它的是把插件发布出去，不是再加一个 shim。
- **没有任何一件东西带着平台信任的证书。** macOS 包是即席签名而非公证，Windows 安装程序未签名，所以除了构建它的那台机器，别的机器上都要走一遍 `## 安装` 里的那一步。
- **运行时在本地回环上以操作系统分配的端口提供服务，且没有认证**，这与 `dsh web` 已有的姿态一致：任何以同一用户身份运行的进程都能触及那个 API。
- **没有 CI 门禁覆盖这个应用。** 打包需要 macOS 或 Windows，驱动外壳需要一个窗口会话，所以本机打包时那次引导冒烟，就是它所交付闭包的全部证明。
- **在 Windows 上关掉最后一个窗口会退出应用并停掉运行时**；在 macOS 上不会，Dock 图标还留着。
- **从源码运行要先构建，而且要有自己的锁。** 这里没有 `dev` 脚本也没有 watch 模式，而且一次未加处理的检出运行没法和已安装的那一份并存——这两件都是 `## 安装` 里绕开的问题，不是这个仓库解决掉的问题。
