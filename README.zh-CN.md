# AnyAdapter Hub · 万能适配

简称 **AnyAdapter**。让 Agent 在用户明确授权的范围内连接、观察和控制家庭设备，并区分“请求已接受”和“效果已确认”。它是独立运行的本地中枢，使用 HTTPS、SSE 和 JavaScript SDK；Collie 等 Agent 可以作为客户端，MCP 仅保留为早期可选入口。

[English](README.md) · [文档目录](docs/README.md) · [安装接入](docs/GETTING_STARTED.md) · [设备支持](docs/SUPPORTED_DEVICES.md) · [贡献指南](CONTRIBUTING.md)

**开发预览。** 当前实机部署要求 Windows、Node.js 22.13+ 和带 OpenSSL 的 Git for Windows。通信凭据使用 Windows 当前用户 DPAPI 加密，中枢只监听固定证书的本机 HTTPS。Linux/macOS 尚无生产密钥存储后端，会明确拒绝实机初始化；跨平台测试通过不代表实机部署已受支持。尚未完成独立安全审计，npm 发布保持禁用。

采用[一套共享核心、三个平台发行版](docs/PLATFORM_ARCHITECTURE.md)的架构方向。
Windows、Linux 和 macOS 共享协议、权限、状态和 API；操作系统专用的安全实现已拆到平台层。
三个原生安装包和统一图形界面仍待实现，当前实机支持范围仍是 Windows。

## 已实现什么

- 本地 HTTPS 服务、按设备组织的状态、字段时效和 SSE 事件。
- 精确到客户端、设备、动作的授权，有效期、撤销和派发前再次检查。
- 持久操作记录、幂等键和排队期限；断线或重启后不自动重放可能已执行的写入。
- 按需安装、启用设备适配器。社区机型档案是纯数据，不能安装代码、发现后自动授权或扩大权限。
- 普通状态、抓取画面、读取保留图片分别授权。
- 接入视觉 Agent 后，可用[带加密检查点的 Disney+ 播放流程](docs/MOVIE_WORKFLOW.md)完成选片、续播和画面确认。

核心可在没有设备时启动。安装依赖、启用适配器、登记设备、开启增强功能、签发客户端权限是不同的所有者操作。

## 当前设备范围

| 设备／功能 | 证据与限制 |
| --- | --- |
| LG OLED65B8PUA，固件 `05.50.70`，webOS release `4.4.3` | 已完成首次证书登记、部分固定证书控制和视觉播放工作流的[实机复测](docs/evidence/lg-b8-workflow-2026-10-19.md)。旧记录覆盖部分媒体功能，其他型号／固件未验证。 |
| B8 临时画面观察 | 历史实测取得 1920×1080 JPEG 和系统播放器状态。需精确型号／固件、本地 opt-in 及独立授权。旧局域网回传尚未加密，默认关闭；不提供 Disney+ DOM 或可信片名。 |
| ECOVACS DEEBOT X11 OmniCyclone | US ECOVACS HOME、Windows、既有加密登录。中枢只读状态与详情已实测；运动控制只有离线测试，固件未知。 |

详见[支持矩阵](docs/SUPPORTED_DEVICES.md)及其证据链接。协议相似、测试通过或有人提交报告，都不能自动扩展为另一台设备已受支持。

## 先启动核心

在新的 Windows PowerShell 检出目录中：

```powershell
git clone https://github.com/wudaming00/AnyAdapterHub.git
Set-Location AnyAdapterHub
npm ci --ignore-scripts
node device-hub.mjs adapters
node device-hub.mjs init
node device-hub.mjs serve
```

这会创建受保护的 `.device-hub` 目录并监听 `https://127.0.0.1:8765`，初始没有设备。不会安装电视通信依赖、Python SDK 或系统开机任务。保留服务终端；在另一项目终端执行 `node device-hub.mjs stop` 可停止服务。

旧安装应先按[安全迁移说明](docs/SECURE_SETUP.md#existing-installations)处理，不能重复初始化。电视配对、只读授权和首次读取请跟随[安装接入](docs/GETTING_STARTED.md)。完整测试属于贡献者流程，不是普通安装的前置步骤；可选测试依赖需单独安装。

## 程序接入

先登记设备并按[指南](docs/GETTING_STARTED.md#issue-a-read-only-client)签发最小授权。放在仓库根目录的 Node.js ES module 可以这样使用：

```js
import { readJson } from './lib/hub/config.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { HubClient } from './lib/hub/client.mjs';

const credential = await resolveCredential(await readJson('.device-hub/client.json'));
const hub = new HubClient(credential);
const state = await hub.state('living-room-tv');
// 作出控制决定前先检查字段时间和 stale 标记。
```

客户端密文绑定创建它的 Windows 用户，不能直接复制给另一个账户使用。不要给普通 Agent `owner.json`、电视配对密钥或中枢账户的无限 shell 权限。当前不提供跨账户登记流程或 OS 沙箱。接口、返回值与运维详见 [API/SDK](docs/API.md) 和[运行指南](docs/LOCAL_HUB.md)。

## 按需开启

| 操作 | 含义 |
| --- | --- |
| 安装 | 使固定审查过的依赖可用，例如 `npm run adapter:lg:install`。 |
| 启用 | 选择加载某个已审查的适配器。 |
| 登记 | 把本地设备 ID 绑定到所有者选定的配置；显式登记同时启用对应适配器。 |
| 功能选择 | 为该设备开启 `observer`、`media` 等可选能力。 |
| 授权 | 允许特定客户端在有效期内操作特定设备的特定能力。 |

配置修改需重启生效。增强功能默认关闭；客户端授权不能越过关闭的功能、替换目标或安装适配器。详见[模块架构](docs/MODULAR_ARCHITECTURE.md)。

## 安全与贡献

不要将中枢暴露到公网。DPAPI 能保护复制出去的凭据文件，但不能防住已经控制当前 Windows 账户或管理员权限的攻击者；状态／图像数据库也未因凭据加密而加密。LG 证书固定仍有首次信任及可能共享出厂密钥的限制；旧观察、DLNA 和文件投送链路不是端到端加密。

安全问题请使用[私密漏洞报告](https://github.com/wudaming00/AnyAdapterHub/security/advisories/new)。公开报告不得附带通信密钥、账户令牌、家庭标识、地图、私人画面或原始诊断。

欢迎贡献脱敏型号报告、已有协议的纯数据机型档案或经单独审查的新适配器。参见[贡献指南](CONTRIBUTING.md)、[适配器要求](docs/ADAPTER_REQUIREMENTS.md)和[路线图](docs/ROADMAP.md)。

核心采用 MIT；可选 ECOVACS Python worker 采用 GPL-3.0-or-later，依赖保留各自许可。见 [LICENSE](LICENSE) 和[第三方声明](THIRD_PARTY_NOTICES.md)。
