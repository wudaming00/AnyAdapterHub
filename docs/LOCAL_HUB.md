# 本地 Device Hub

AdaptAny 是独立进程。CLI、Node SDK 或后续 Collie 客户端都通过本地 HTTP API 使用它。它不依赖某个 Agent，也不会自动配对电视、修改固件、取得 root 或安装系统开机任务。

以下说明对应当前代码行为。单台 B8 的 Hub HTTP 链路已有有限真机验证，具体范围见文末；不能据此宣称全部能力或其他设备都已验证。

## 初始化与启动

需要支持 `node:sqlite` 的 Node.js 22.13+、已安装的项目依赖，以及已经明确配对的电视配置。先查看命令：

```powershell
node device-hub.mjs help
```

用自己的已配对配置和电视地址替换尖括号内容，再运行一次初始化：

```powershell
node device-hub.mjs init --tv-config "<已配对配置文件>" --host "<电视局域网地址>" --id living-room-tv
node device-hub.mjs serve
```

默认私有目录为 `.device-hub`，默认端口为 8765。`init` 保存已有电视配置的引用，并建立所有者凭据；重复初始化不会覆盖现有凭据。`serve` 保持在前台运行，仅监听本机回环地址。停止时等待正在执行的事务清理，再关闭适配器。

私有目录中的凭据和数据库不要提交或共享。普通客户端不需要原始电视配对密钥，也不应拿到所有者凭据。

所有者可以运行 `node device-hub.mjs stop` 停止服务。此操作会立即阻止新派发，等待已执行事务的清理，再关闭设备连接。普通客户端不能关闭中枢。

## 给客户端最小授权

服务运行后，在另一个终端签发只读客户端凭据：

```powershell
node device-hub.mjs grant --label cli-read --caps state.read,events.read --device living-room-tv --out .device-hub/client.json --hours 24
node device-hub.mjs status --device living-room-tv
node device-hub.mjs capabilities --device living-room-tv
node device-hub.mjs events --after 0
```

CLI 普通命令默认读取 `.device-hub/client.json`；授权管理命令默认使用所有者凭据。令牌写入私有文件，不打印到终端。`events` 持续输出 SSE 事件，按 Ctrl+C 结束。

控制权限要另行签发。例如只授权音量与静音：

```powershell
node device-hub.mjs grant --label audio-client --caps state.read,audio.volume.set,audio.mute.set --device living-room-tv --out .device-hub/audio-client.json --hours 24
node device-hub.mjs call --device living-room-tv --action audio.volume.set --args '{"volume":15}' --key volume-example-1 --credential .device-hub/audio-client.json
```

查询和撤销授权：

```powershell
node device-hub.mjs grants
node device-hub.mjs revoke --grant-id "<授权ID>"
```

撤销和过期会阻止后续请求，并在真正派发动作前再次检查。`--caps all` 是所有者显式授予全部已知能力的选择，不是推荐的默认权限。

安装应用清单需要单独的 `app.list` 能力，`state.read` 不隐含此权限。它只返回经过筛选的应用 ID、标题、系统应用标记及普通启动是否允许，不返回应用 URL、图标地址或原始权限列表。要调用它，给相应客户端签发 `app.list` 后提交同名动作和空参数对象。

## 图像权限单独控制

`screen.observe` 允许发起临时观测；`screen.read` 允许读取已保存帧。二者分别授权。截图还要求电视本地配置明确启用临时观测，客户端授权不能替代该开关。

```powershell
node device-hub.mjs grant --label screen-client --caps screen.observe,screen.read --device living-room-tv --out .device-hub/screen-client.json --hours 1
node device-hub.mjs observe --device living-room-tv --out captures/current.jpg --credential .device-hub/screen-client.json
```

保存目录须已存在，输出文件不能已存在。状态订阅不会携带图片字节；拿到帧 ID 也不能绕过 `screen.read`。当前帧五分钟后不可读取，并限制每设备帧数及总大小。过期清理不代表磁盘安全擦除。

B8 观测会短暂使用特定系统覆盖层，结束后关闭并恢复原应用。它是按次状态与截图请求，不是连续投屏或实时视频，也不提供 Disney+ DOM。内部播放器 `playing` 可能只是首页预览；不能据此宣称电影已播放。

## Node SDK

从项目根目录运行的代码可以使用 `lib/hub/client.mjs`。凭据文件由所有者预先签发，程序不需要读取电视配置：

```js
import { readFile } from 'node:fs/promises';
import { HubClient } from './lib/hub/client.mjs';

const credential = JSON.parse(await readFile('.device-hub/audio-client.json', 'utf8'));
const hub = new HubClient(credential);
const operation = await hub.execute('living-room-tv', 'audio.volume.set', { volume: 15 }, {
  idempotencyKey: 'volume-example-1',
  timeoutMs: 30000,
});
console.log(operation.state, operation.result?.confirmed);
```

`submit()` 只提交作业；`operation(id)` 查询状态；`execute()` 提交并有限等待。等待结束仍可能返回 `queued` 或 `running`，客户端应继续查询原作业，而不是换一个幂等键重发。

使用具有相应授权的 SDK 客户端，可以通过 `state(deviceId)` 读取状态、`events({afterId, signal})` 接收事件、`frame(frameId)` 读取图像。客户端断线后用最后的事件 ID 重新建立事件流；当前 SDK 不自动恢复连接。事件日志只保留最近一万条，存在缺口时重新获取当前状态。

## 作业、期限与状态

| 状态 | 含义 |
| --- | --- |
| `queued` / `running` | 已排队／正在处理，尚无最终结果。 |
| `confirmed` | 在结果指定范围内观察到目标状态，不代表更广的业务目标已经完成。 |
| `unconfirmed` | 请求已发送或收到应答，但效果缺少充分验证。 |
| `failed` | 请求被拒绝或验证失败，详见脱敏错误。 |
| `expired` | 在派发前超过请求期限。 |
| `unknown` | 可能已产生效果，但因中断、错误或重启无法确定。 |
| `cancelled` | 作业未继续派发，例如排队期间重启或授权失效。 |

同一客户端重复使用同一幂等键和相同请求，会返回原作业；相同键配不同参数会冲突。幂等不意味着设备协议本身支持事务。服务不会自动重放不确定的写操作：重启后的排队作业取消，执行中作业标为未知。

每个状态字段带有自己的观察时间、过期时间和来源，读取时提供 `stale`。当前 LG 适配器默认约五秒轮询一次；SSE 是 Hub 已知事件的传输方式，不等于电视内部状态实时推送。过期字段、在线连接和历史截图必须分别理解。

## HTTP 接口

SDK 使用带 Bearer 授权的本地接口，令牌不放在 URL 中：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/devices` | 授权范围内的设备。 |
| GET | `/v1/devices/{id}/state` | 带字段新鲜度的状态。 |
| GET | `/v1/devices/{id}/capabilities` | 当前客户端获准使用的固定能力。 |
| POST | `/v1/devices/{id}/actions` | 提交带幂等键和期限的动作。 |
| GET | `/v1/operations/{id}` | 查询自己的作业。 |
| GET | `/v1/events?after={eventId}` | 可恢复游标的 SSE 事件流。 |
| GET | `/v1/frames/{id}` | 单独授权的图像读取。 |

服务不是公网或不可信多用户网络接口。社区机型 JSON 只能描述兼容性和证据，不能添加代码、权限或任意调用。Home Assistant、Matter 和其他厂商适配器尚未实现；新增适配器必须独立代码审查。

<a id="live-verification"></a>

## 已完成的有限真机验证

2026-10-19，LG OLED65B8PUA、固件 05.50.70：

- 经过 Hub HTTP 请求切换静音并恢复，均读回确认。
- 重复使用相同幂等键和请求，返回同一作业 ID。
- 取得并查看 1920×1080 JPEG，图像大小为 162,218 字节；临时资源清理及原应用恢复均确认成功。
- 读取到 Disney+ 的 MSE 播放管线，画面尺寸为 1920×1080，状态为 `playing`；这可能来自预览，不确认具体电影。
- 只读客户端的越权请求被拒绝，撤销授权后的请求被拒绝。
- SSE 收到 19 条事件，验证了事件交付；这不代表帧率或电视内部连续事件订阅。

该记录不包含账号内容、原始截图或私有网络信息，也不覆盖全部 Hub 动作、所有异常路径或其他型号。

更多边界见 [架构](ARCHITECTURE.md) 和 [安全说明](../SECURITY.md)。
