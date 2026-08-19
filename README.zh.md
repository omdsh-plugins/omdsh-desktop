# omdsh-desktop

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面应用：一个 Electron 外壳，监管一个 harness 运行时，并在它周围补齐原生的那一层——窗口、菜单、活动状态、重启策略，以及看着运行时启动的那个引导页。

这个外壳不属于 harness。它把运行时作为子进程拉起来，通过本地回环 HTTP 跟它说话，所以运行时崩了或者把堆吃光了，只是按外壳自己的策略重启一次，不会把窗口一起带走。

## ⬇️ 下载

| 平台 | 安装包 |
|---|---|
| **macOS 13 及以上，Apple 芯片** | [DeepSeek-Harness-0.1.0-rc.7-arm64.dmg](https://github.com/omdsh-plugins/omdsh-desktop/releases/download/v0.1.0-rc.7/DeepSeek-Harness-0.1.0-rc.7-arm64.dmg) · 208 MB |
| **Windows 64 位** | [DeepSeek-Harness-0.1.0-rc.7-x64-setup.exe](https://github.com/omdsh-plugins/omdsh-desktop/releases/download/v0.1.0-rc.7/DeepSeek-Harness-0.1.0-rc.7-x64-setup.exe) · 131 MB |

上面两个链接锁定的是某一次构建；**[发布页](https://github.com/omdsh-plugins/omdsh-desktop/releases/latest)** 上永远是最新的那一版。机器上不需要再装别的——harness 运行时、插件中心、模式系统都在安装包里。

两个安装包都没有购买开发者证书签名，所以首次打开时系统会拦一下：macOS 在「应用程序」里右键点图标 →**打开**→ 再点一次**打开**；Windows 在 SmartScreen 弹窗上点**更多信息**→**仍要运行**。

[`app/README.zh.md`](app/README.zh.md) 才是外壳本身的详细说明——运行时进程和它的重启阶梯、登录环境探测、窗口与菜单行为、提醒用的那几条流，以及内存策略。本页说的是它外面这个仓库。

## 目录结构

| 目录 | 是什么 |
|---|---|
| `app/` | Electron 主进程（`@omdsh-plugins/omdsh-desktop`）；`tsdown` 把它打成一个 `lib/main.mjs` |
| `runtime/` | 一份只有依赖的 manifest，写明这个应用交付的是哪个 harness 版本，以及它随身带的那些 omdsh bundle |
| `scripts/` | 打包流水线——闭包、`electron-builder`、引导冒烟、磁盘映像、NSIS 安装程序——以及 harness 与插件的版本来源开关 |
| `assets/` | 应用图标素材 |

## 它内置的 harness 版本

三个文件写着它，而且写的是同一个，今天是 `0.1.0-rc.7`——第三个是应用自己的版本号，因为产物的文件名就是告诉别人"里面装的是哪个运行时"的东西。`runtime/package.json` 是打包流水线真正去安装的那一份：它是工作区之外的一个部署根，那里 `catalog:` 引用无处可解，所以版本号在这里是字面重述一遍的。`pnpm-workspace.yaml` 的 catalog 则是 `app` 解析 API 客户端所依据的那一份。`pnpm run check:harness-pin` 就是这两者一致的证明——只要其中任何一个还挂着 `link:`，它就失败。

工作区把那个版本装在 `runtime/` 下，所以从检出运行时监管的运行时，和打好包的那个内嵌的是同一个——这正是"从源码跑起来"具有代表性的原因。打包读的也是同一个文件。

```sh
pnpm run check:harness-pin        # 两份 manifest、catalog 和版本号指向同一个版本
pnpm run check:harness-outdated   # registry 上有更新的 release 时失败
pnpm run harness:latest           # 迁到它：catalog、runtime pin，以及这个应用自己的版本号
pnpm run harness:npm              # 对着已发布的版本构建（默认），并把版本号取过来
pnpm run harness:local ../../deepseek-harness   # 改为对着同级检出构建
```

上游发了新版本时，`harness:latest` 就是全部动作：读 registry 上有什么、拒绝任何不比当前 pin 更新的东西、要求 API 客户端**发布了同一个 release**，然后写两条 catalog 条目，再做 `harness:npm` 做的事。`check:harness-outdated` 是同样的读取但不写，所以定时任务可以用它来说"有个新版本在等着"。

两者都**不看 `latest` dist-tag**，这不是为谨慎而谨慎：`@deepseek-ai/dsh-host-apiproxy` 已经发布了 `0.1.0-rc.7`，而它的 `latest` 还指着 `0.0.1-rc.1`——一条相信这个 tag 的命令，会告诉你这个应用得把 API 客户端往回退一个 minor 版本。

`harness:npm` 会把 `package.json` 和 `app/package.json` 的版本号设成它所指向的那个 release，而 `check:harness-pin` 在两者漂移时失败——所以换一个 harness 版本是**一条命令**，而不是一条命令外加一处得靠人记住的 manifest 编辑。同一个 release 的重新构建叫 `<release>+<n>`：semver 在比较优先级时忽略 build metadata，这正好对——那样的构建不是一个更新的 release。

local 模式把 `@deepseek-ai/dsh` 和 API 客户端用 `link:` 指到一个 harness 检出上。pnpm 不会安装被 link 的包自己的依赖，所以那个检出必须先自己装好、自己构建过（`pnpm run build`）。用它来在外壳里看尚未发布的 harness 改动；准备交付的东西在打包前先用 `harness:npm` 切回去。

## 它内置的插件

安装程序带 [`omdsh-plughub`](https://github.com/omdsh-plugins/omdsh-plughub) 和 [`omdsh-basemode`](https://github.com/omdsh-plugins/omdsh-basemode)。两者在这里的理由不同，而且都不能推广到第三个。

**hub 是唯一一个没法用它自己提供的机制装上的插件。** 装插件这件事就是在终端里 `dsh plugin --profile web add <package>`，而一台刚跑完安装程序的机器，`PATH` 上根本没有 `dsh`——所以一个刚装好的应用打开来，会是一个没有任何途径去装第二个插件的 harness。

**模式系统是那个没人会自动装上的 peer。** 它自己不贡献任何模式，单独装也不显示任何开关；它是所有模式插件注册进去的那个注册表，而每个模式插件都把它声明成 `peerDependency`。profile 是以 `autoInstallPeers: false` 安装的，所以通过 hub 装 Chat 或 Code **不会**把它带进来，而缺了它的模式插件是静默加载的——没有开关、没有分段、也没有报错。带上它，意味着点一次就能得到一个真的能用的模式，而不是一个悄无声息的。

代价是真实的，也值得写明：一个共享库进了安装程序，就被钉在了这个应用的发版节奏上，而依赖它的那些包仍在自由更新。有两件事让这个代价咬不动。一是它的依赖方都以 `*` 声明它，所以它的任何版本都不会卡住其中任何一个；二是 hub 可以把一份更新的副本装进 profile 自己的目录，那个位置在解析路径上比这个应用链过去的那份更近，所以一次安装永远不会被内置的那份锁死。

这两个之外的每一个插件，hub 都装得了；上面这套理由，就是第三个插件要进来必须先挣到的东西。

交付哪些 bundle 声明在 catalog 里那些 `@omdsh-plugins/*` 条目上，而 `runtime/package.json` 必须以同一个版本把它们全写上——今天是 `omdsh-basemode` 0.2.2 和 `omdsh-plughub` 0.2.4。写两处的理由和 harness 版本号写两处一样：闭包是装在这个工作区之外的，那里 `catalog:` 引用无处可解。这些版本就是 npm 上的发布版，所以单独克隆本仓库就能打包：`pnpm install && pnpm run build && pnpm run package:desktop` 会从 registry 拉它们，和拉 harness 本身一样。

```sh
pnpm run check:plugin-pin         # runtime manifest 和 catalog 指向同一个版本
pnpm run check:plugin-outdated    # npm 上有比当前 pin 更新的版本时失败
pnpm run plugins:latest           # 迁到它：catalog 和 runtime pin
pnpm run plugins:npm              # 交付 catalog 里已发布的版本（默认）
pnpm run plugins:local ..         # 改为交付同级检出
pnpm run plugins:none             # 一个都不带
```

默认构建两个都带着，而且打包每一次都会把"这一趟带了什么"打印出来。

`plugins:latest` 就是 hub 或模式系统发了新版本时的全部动作：读 npm 上有什么、拒绝任何不比当前 pin 更新的东西、写 catalog，再做 `plugins:npm` 做的事。`check:plugin-outdated` 是同样的读取但不写。两者都不看 `latest` dist-tag。

**永远不该提交的是一条 `link:`。** pnpm 把它按声明它的那份 manifest 解析，所以一份没有同级检出的克隆只会 WARN、退出码 0，然后留下一条断链——打包再把这条断链带进 `.app`，最后 macOS 直接拒绝给这个包签名。`check:plugin-pin` 就是为此对它失败的，CONVENTIONS 第 8 条说的是同一件事。要拿未发布的插件改动打包就用 `plugins:local ..`，提交前切回 `plugins:npm`（或 `plugins:latest`）。

除此之外，本地 bundle 不给打包添任何麻烦：`scripts/bundled-plugins.ts` 会把每一个先打成 tarball，闭包再从 tarball 装，所以进到产物里的是实打实的文件而不是软链。`pnpm pack` 会跑各自的 `prepare`，所以那些检出必须先装好。而一个版本号根本不需要这一套——pnpm 从 registry 解析它，和别的包没两样。

### 一个内置 bundle 是怎么进到 profile 里的

有三件事必须同时成立，而"把文件装进去"只是第一件。

| | 需要什么 | 在哪里 |
|---|---|---|
| 闭包里带着它 | `runtime/package.json` 的一条依赖，与它声明的每个 peer 平铺在一起 | `scripts/runtime-closure.ts` |
| profile 点名要它 | 追加进 `dsh.profile.bundles`——启动器自带的 `web` 模板里没有它 | `app/src/bundled-plugins.ts` |
| 它的行解析得了 | 在 `$DSH_HOME/profiles/node_modules` 下的一条软链，因为从那里走不到闭包 | `app/src/bundled-plugins.ts` |

第三件才是那件看着已经做完、其实没有的事。Loader 的 `baseUrl` 是 profile 目录，所以 bundle patch 里那些行的裸 specifier，是靠 Node 从 `$DSH_HOME/profiles/<name>/` 往上走找到的——它走到的是启动器维护的那个扁平兜底目录，里面是 dsh 安装自身依赖闭包中每个包的一条软链。一个装在那个安装**旁边**的插件不在这个闭包里，所以外壳自己把它链进去。启动器对那个目录只增不删，所以这条链站得住。

seeding 在运行时启动之前跑，每个 bundle 只提供一次。外壳加过、而用户又从 `dsh.profile.bundles` 里拿掉的 bundle，会一直保持拿掉的状态——外壳把"自己提供过什么"记在它自己的设置文件里，所以这次撤除不会在下次启动时被推翻。它每次启动都会维护的是那条软链，因为换掉应用就是换掉链所指的东西；而一个被列出、却哪里都解析不到的 bundle 会被摘掉，因为那一种对启动器是致命的，不只是缺失。

hub 会把一个被 seed 进来的 bundle 标成不可移除，而这是对的：它判定可移除的标准是"profile 是否依赖它"，而一个被 seed 的 bundle 是 profile 被给予的一层，不是 pnpm 装进来的一条依赖。那正是启动器自带的 `dsh-base` 和 `dsh-web-app` 所在的那一档。插件中心和模式系统在 Update 把它们写成真实依赖之后仍留在这一档——前者否则可以把自己卸掉、不留任何装回来的办法，后者是那个没人会自动装上的 peer。

打包应用换了一个这个外壳还没为这个 home 准备过的版本时，第一次启动会在 seeding 之前删掉 `$DSH_HOME/profiles`。通过 hub 装上的插件会在启动时被组合进去，一份对着上一个运行时写下的残留不会降级，而是直接拒绝启动。设置、凭证、会话，以及 harness home 里其余的东西都留着：它们不在启动器的 bundle 列表上。同一个安装包之后的启动不会再动 hub 随后写入的内容，所以那次首次启动之后装上的插件第二天还在。从检出运行永远不会做这件事，因为替换 `app/lib` 并不是在安装一个应用。

profile 本身不由这里写。它不存在时，启动器会被以 `--dump-default-config` 跑一次，那会解析 profile 然后退出——大约三分之一秒——所以这个仓库不必自带一份 profile 模板的副本，而那份模板里的 pnpm 设置，恰恰决定了 hub 自己的安装行为。

## 外壳不负责什么

运行时就是窗口旁边的那一个，仅此而已。从另一台主机提供服务，以及"显示 harness"之外的每一项能力，都是运行时该通过插件长出来的东西，而不是外壳绕过它去够的东西。安装程序把这句话坐实了，而不是推翻它：它在闭包里带上了插件——带 hub 是因为一台刚跑完安装程序的机器，`PATH` 上没有 `dsh`，也就没有办法装上第一个。那些是运行时加载的 bundle，不是外壳自己持有的能力。打包流水线内嵌的那个闭包，是这里的 [`scripts/runtime-closure.ts`](scripts/runtime-closure.ts) 构建的。

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
pnpm run check:plugin-pin         # runtime manifest 和 catalog 指向同一个版本
pnpm run check:plugin-outdated    # npm 上有比当前 pin 更新的 hub 或模式系统时失败
pnpm run plugins:latest           # 把 pin 迁到那些版本
pnpm run plugins:npm              # 交付 catalog 里已发布的版本（默认）
pnpm run plugins:local ..         # 改为交付同级检出
pnpm run plugins:none             # 一个都不带
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
- **从 git specifier 装的插件，可能以任何白名单都够不着的方式失败。** git 包的 `prepare` 会在 pnpm store 下面跑一次嵌套 `pnpm install` 去取该插件的 devDependencies；如果被拦的是那次嵌套安装，报出来的是 `ERR_PNPM_PREPARE_PACKAGE`，而 profile 的 `allowBuilds` 对那个目录不生效。绕开它的办法是把插件发布出去——registry 安装下载的是构建好的树，根本不做构建。（构建本身在内置的 Node 下是没问题的：`tsdown` 和它的 Rolldown 原生模块在 `ELECTRON_RUN_AS_NODE` 下能正常加载，因为那是 N-API，跨 Node 与 Electron ABI 稳定。）
- **没有任何一件东西带着平台信任的证书。** macOS 包是即席签名而非公证，Windows 安装程序未签名，所以除了构建它的那台机器，别的机器上都要走一遍 `## 安装` 里的那一步。
- **运行时在本地回环上以操作系统分配的端口提供服务，且没有认证**，这与 `dsh web` 已有的姿态一致：任何以同一用户身份运行的进程都能触及那个 API。
- **没有 CI 门禁覆盖这个应用。** 打包需要 macOS 或 Windows，驱动外壳需要一个窗口会话，所以本机打包时那次引导冒烟，就是它所交付闭包的全部证明。
- **在 Windows 上关掉最后一个窗口会退出应用并停掉运行时**；在 macOS 上不会，Dock 图标还留着。
- **新的打包版本会清掉通过 hub 装上的插件。** 版本号变了之后的第一次启动会删掉 `$DSH_HOME/profiles`，这样一份对着当前运行时加载不了的残留就不会把引导拖死。设置、凭证和会话留着；把插件装回来的是 hub。从检出运行不会做这件事，同一个版本之后的启动也不会动 hub 随后装上的东西。
- **Windows 安装程序每次都会清除默认 profile 下的插件。** 即使同版本覆盖安装也会删除 `~/.dsh/profiles`，`.dsh` 下的其他内容保持不变；上面的首次启动检查仍会兜底自定义 `$DSH_HOME` 和安装阶段清理失败的情况。
- **从源码运行要先构建，而且要有自己的锁。** 这里没有 `dev` 脚本也没有 watch 模式，而且一次未加处理的检出运行没法和已安装的那一份并存——这两件都是 `## 安装` 里绕开的问题，不是这个仓库解决掉的问题。
