# 本地运行与维护

本指南对应当前的 **Windows DPAPI + 固定证书 HTTPS** 版本。首次安装见 [Get started](GETTING_STARTED.md)，旧安装见[加密迁移](SECURE_SETUP.md#existing-installations)，协议细节见 [API/SDK](API.md)。

中枢是独立本地进程；不依赖 Agent 框架，不自动发现、配对、安装 SDK 或建立系统开机任务。默认地址为 `https://127.0.0.1:8765`。下列命令从仓库根目录运行；可选操作仅用于你拥有或获授权管理的设备。

## 启动、停止和目录

```powershell
node device-hub.mjs serve
node device-hub.mjs stop
```

`serve` 占用当前终端；在另一项目终端执行 `stop`。停止需要 owner 凭据，会阻止新派发并关闭连接、完成已开始观察的受限清理；不是取消已经被设备接受的效果。

`init` 只能用于新的或空的专用目录，不能用来重置已存在的中枢。不要直接删除数据库以解决一次请求失败：幂等历史丢失后，重发旧操作可能再次产生效果。

| 私有文件 | 用途 |
| --- | --- |
| `hub.json` | 登记的设备引用、启用的适配器、每台设备的功能选择。 |
| `owner.json` | DPAPI 加密的所有者令牌与公开 TLS 信任信息。 |
| `identity.json` | DPAPI 加密的 Hub TLS 私钥、证书与指纹。 |
| 自选客户端 JSON，例如 `client.json` | 指定客户端的加密令牌、grant ID 与 Hub 证书。 |
| `state.sqlite` 及其 WAL/SHM | 状态、事件、操作和受限保留的帧；此数据库内容未由凭据加密功能加密。 |
| `process.json` | 进程与监听信息；不是独立的身份或安全凭据。 |

原 LG 配对文件仍在登记时指定的路径，Hub 保存引用而不是复制一个可随意分享的登录。不要移动、上传或公开这些文件。若选择自定义 `--home`，所有命令都要传同一路径，授权输出必须直接位于该 home 中。自定义目录不一定匹配仓库的忽略规则；建议选仓库之外的专用私有目录。

## 安装、启用、登记、功能、授权

五层操作的边界见[模块架构](MODULAR_ARCHITECTURE.md)。更改登记、启用状态或功能后重启服务；不会热加载社区脚本。

```powershell
node device-hub.mjs adapters
node device-hub.mjs stop
node device-hub.mjs disable --adapter lg-webos
node device-hub.mjs serve
```

禁用保留登记与凭据，但重启后不加载该适配器，也不读取它的设备配置。另一独立终端可再次停止服务并恢复：

```powershell
node device-hub.mjs stop
node device-hub.mjs enable --adapter lg-webos
node device-hub.mjs serve
```

启用不负责安装依赖或登记设备。LG 依赖需由所有者明确执行 `npm run adapter:lg:install`；ECOVACS 使用[单独安装的 worker](ECOVACS_X11.md)。空中枢也可以启动，设备清单为空；它不会因此扫描网络。

新增设备使用 `add`，而不是再次 `init`。例如已完成配对后：

```powershell
node device-hub.mjs stop
$tvHost = '<TV_LAN_IP>'
node device-hub.mjs add --tv-config .lg-tv.local.json --host $tvHost --id living-room-tv
node device-hub.mjs serve
```

设备 ID 不能重复，现有登记不能通过 `add` 静默替换。云设备不能用命令行 host 改变目标。当前没有设备删除、动态插件安装或通用配置管理 API；本地修改登记也必须保留精确目标绑定。

## 签发只读授权

服务运行后，在另一个终端：

```powershell
node device-hub.mjs grant --label status-reader --device living-room-tv --caps state.read,events.read --hours 24 --out .device-hub/client.json
node device-hub.mjs status --device living-room-tv
node device-hub.mjs capabilities --device living-room-tv
node device-hub.mjs events --after 0
```

令牌不打印。输出文件必须不存在并且直接位于私有 home 内；CLI 默认使用 `.device-hub/client.json`，自定义文件需加 `--credential FILE`。默认设备 ID 为 `living-room-tv`，其他设备必须传 `--device`。

默认 grant 为 24 小时，CLI 允许最多 30 天。权限到期后需要签发新 grant，不能覆盖旧文件假定权限已经续期。加密文件绑定创建它的 Windows 用户，跨账户登记或安全令牌转移流程尚未实现。

## 单独授权控制

只签发计划使用的能力。例如音量和静音：

```powershell
node device-hub.mjs grant --label audio-client --device living-room-tv --caps state.read,audio.volume.set,audio.mute.set --hours 1 --out .device-hub/audio-client.json
```

随后的一次控制会改变电视状态，仅在明确需要时运行：

```powershell
node device-hub.mjs call --device living-room-tv --action audio.volume.set --args '{"volume":15}' --key example-volume-request-1 --credential .device-hub/audio-client.json
```

PowerShell 将 JSON 作为单个参数传入；其他 shell 的引号方式不同。SDK 能直接传对象，减少命令行转义。不要把口令或令牌放进 `--args`。

同一客户端、设备与幂等键的同一动作及参数返回原操作；更换参数会冲突。请求超时后查询原 operation，不能为了“确保执行”换新 key 反复重发。派发后的不确定状态应由读回和所有者判断处理。

`--caps all` 只是签发时当前能力清单的快照，不是未来通配授权，也不能开启关闭的增强功能。应用清单需要 `app.list`，`state.read` 不隐含它。通用遥控、输入和点击可能操作应用中的购买或设置，不能视为无风险的普通读取。

## 查询和撤销

```powershell
node device-hub.mjs grants
node device-hub.mjs revoke --grant-id '<GRANT_ID>'
```

只有 owner 能管理授权。撤销会阻止后续鉴权、事件交付和排队动作派发；不能撤回已经送出的指令、已经交付的帧或已经发生的设备效果。删除客户端文件不等于撤销服务器上的授权。

把普通 Agent 限定为 SDK/HTTPS 窄授权客户端。持有同一 OS 账户无限 shell 的程序能读取或修改 owner 环境，本项目没有提供 OS 沙箱。

## 画面观察

画面观察默认关闭，并使用尚未端到端加密的旧局域网回传。仅在经过审查的精确 B8 型号／固件和可信网络上，由所有者决定开启。

需要同时满足：

1. Hub 中该设备的 `observer` 功能已启用并重启生效。
2. 原私有 LG 配置中该设备明确设置 `allowTemporaryObserver: true`。
3. 客户端具有 `screen.observe`；读取图片还要独立的 `screen.read`。
4. 真实设备身份、固件和受控通道通过适配器的固定检查。

先在原配对文件的目标设备元数据中调整本地开关，**保留加密密钥、证书指纹和其他登记字段**，不要用一个示例 JSON 覆盖整个文件。然后：

```powershell
node device-hub.mjs stop
node device-hub.mjs features --device living-room-tv --features observer
node device-hub.mjs serve
```

功能选择是替换列表；以上选择仅保留 `observer`，同时需要媒体时写 `observer,media`。功能不会扩大已有客户端 grant。

在另一终端授予并发起一次观察：

```powershell
node device-hub.mjs grant --label screen-client --device living-room-tv --caps screen.observe,screen.read --hours 1 --out .device-hub/screen-client.json
New-Item -ItemType Directory -Path captures -Force | Out-Null
node device-hub.mjs observe --device living-room-tv --out captures/current.jpg --credential .device-hub/screen-client.json
```

父目录要先存在，目标图片必须不存在。此操作会短暂进入受控覆盖层并尝试恢复原应用；返回清理与恢复结果，不能把部分成功当成完整观察。普通 SSAP 若返回 HTTP 截图地址，新版下载器会拒绝明文降级；它不是该 B8 临时观察机制的替代。

保留帧最多五分钟，每设备最多五帧、总计最多 32 MiB；过期后 API 立即拒绝读取，定期逻辑清理不等于 WAL、备份或磁盘安全擦除。导出到 `captures` 的图片不再受 Hub 帧过期策略管理，不能公开上传。

观察不是连续视频、电视 root 或 Disney+ DOM。系统 `playing` 可能只是首页预览，不能确认具体电影或账号状态。

## 媒体功能

`media` 功能与普通播放/暂停遥控分开。它包含媒体 URL、DLNA 和文件投送；其中旧协议不提供完整的局域网认证与加密。

- 停止 Hub，明确选择 `features --device living-room-tv --features media`，然后重启。
- 本地文件还需要原私有 LG 元数据中的明确 `mediaRoots`。
- 网址还需要明确 `allowedUrlOrigins`，默认拒绝。
- 给客户端分别授予要用的固定动作。没有任意 HTTP、文件或厂商 RPC 透传。

不要把凭据目录加入媒体根，不要给不可信 Agent 整个用户目录或宽泛 URL 源。电视后续进行的 DNS 和跳转行为不由中枢完整约束。

## SDK 与结果判断

仓库根目录的 ES module：

```js
import { readJson } from './lib/hub/config.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { HubClient } from './lib/hub/client.mjs';

const hub = new HubClient(await resolveCredential(await readJson('.device-hub/audio-client.json')));
const operation = await hub.execute('living-room-tv', 'audio.volume.set', { volume: 15 }, {
  idempotencyKey: 'example-volume-request-1',
  timeoutMs: 30000,
});
console.log(operation.state, operation.result?.confirmed);
```

`submit()` 提交操作，`operation(id)` 查询原操作，`execute()` 有限等待。等待结束仍可能是 `queued` 或 `running`。接口返回、错误码、逐字段时效和 SSE 游标见 [API](API.md)。

| 状态 | 应如何理解 |
| --- | --- |
| `queued` / `running` | 尚未有最终结果，继续查询原 operation。 |
| `confirmed` | 在结果所述范围内有确认依据，不等于更广业务目标已完成。 |
| `unconfirmed` | 没有充分的效果验证。 |
| `failed` / `expired` / `cancelled` | 查阅具体结果；不能自动将所有失败视为安全重试。 |
| `unknown` | 可能已产生效果，不能自动重放。 |

LG 默认约五秒轮询，状态字段各有来源、观察时间、过期时间和 `stale`。在线连接不意味着每个字段都新鲜，SSE 不等于电视内部状态实时推送。事件日志保留一万条，操作和幂等记录在数据库生命周期内保留；监控磁盘增长。

## 更新、迁移和历史证据

更新前通过服务原终端或原启动器停止旧进程，再更新到经过审查的版本。当前 CLI 不会为了停止旧版服务而自动解密失败后降级读取明文令牌。迁移开始前会检查端口未被占用。

按[安全迁移说明](SECURE_SETUP.md#existing-installations)迁移已存在的 home 和显式命名的配对文件，再重启。电视关闭时仍可完成加密，但证书登记为 pending，无法通过未验证连接控制电视。下次由所有者开机后重跑迁移并重启，现有指纹不会被静默替换。

<a id="live-verification"></a>

2026-10-19 的 [LG 旧链路实测](evidence/local-hub-2026-10-19.md)记录了静音恢复、幂等、临时画面、授权拒绝和事件交付。它是 HTTPS/证书加固前的历史记录，不是新链路的实机认证。当前 [ECOVACS 只读证据](evidence/ecovacs-x11-2026-10-19.md)同样只覆盖所列能力。支持范围以[设备矩阵](SUPPORTED_DEVICES.md)为准。

更多故障处理见 [Troubleshooting](TROUBLESHOOTING.md)，威胁与限制见[安全政策](../SECURITY.md)。
