# AnyAdapter Hub · 万能适配

当前安全版本使用 Windows 当前用户 DPAPI 加密凭据和固定证书 HTTPS；旧安装需先按[加密迁移说明](docs/SECURE_SETUP.md)迁移。适配器和增强功能按需启用；Linux/macOS 尚无生产密钥存储后端。

简称 **AnyAdapter**。

让 Agent 在用户授权范围内连接、观察和控制家庭设备。它是独立运行的本地中枢，使用 HTTP、SSE 和 JavaScript SDK；Collie 或其他 Agent 可以作为客户端接入。MCP 保留为早期可选入口，中枢不依赖它。

当前只在 **LG OLED65B8PUA、固件 05.50.70** 上完成实测，ECOVACS X11 已加入可选实验适配并验证中枢只读状态和详情，控制尚未通过新桥接真机验证；Home Assistant/Matter 适配尚未实现。开源开发预览，npm 发布保持禁用。

## 已实现的范围

- 常驻本地进程：设备连接、定时状态读取、带时效的状态缓存和 SSE 事件反馈。
- LG 的 23 个固定动作：应用枚举与启动、音量、静音、输入、电源、遥控、指针、媒体、电脑文件投放及按需观察。实现不等于全部动作均已真机验证。
- 每客户端、每设备、每能力的授权，有效期和撤销；普通客户端不能签发权限，抓取画面与查看画面分别授权。
- 持久操作记录、必填幂等键、排队时限、派发前重新鉴权。断线或重启后不自动重放可能已执行的动作。
- 临时观察返回真实 **1920×1080 JPEG** 与系统播放状态，按次关闭覆盖层并验证受控截图删除；不是电视 root，也不是常驻视频流。
- 真机 HTTP→中枢→LG 验证：静音切换及恢复、重复请求返回原操作、画面回传、SSE、只读客户端拒绝控制/截图/读图，以及授权撤销。
- 社区纯 JSON 机型档案、精确型号/固件检查和脱敏证据；档案不会安装代码或授予权限。

状态读回、请求应答、画面证据分别报告。ACB `playing` 可能来自首页预览，没有可信片名字段；目前没有 Disney+ DOM、账号数据或应用内部业务接口。普通截图接口在该机型失败，临时观测使用另一条已审查的内部通道。详见 [B8 证据](docs/evidence/lg-b8-2026-10-19.md) 和 [中枢实测](docs/evidence/local-hub-2026-10-19.md)。

ECOVACS X11 的 US/Windows 限制、既有加密登录前提及单设备绑定见 [科沃斯接入](docs/ECOVACS_X11.md) 和 [支持表](docs/SUPPORTED_DEVICES.md)。安全方法与详细检查见 [安全评审](docs/SECURITY_REVIEW.md)。

## 本地运行

需要 Node.js **22.13+**（本机验证 22.22.2），使用内置实验性 SQLite。

```sh
npm ci --ignore-scripts
npm run adapter:lg:install
npm run check
node lg-tv.mjs certificate --host <TV_LAN_IP>
node lg-tv.mjs pair --host <TV_LAN_IP> --certificate-pin <REVIEWED_SHA256_HEX> --profile control
node device-hub.mjs init --tv-config .lg-tv.local.json --host <TV_LAN_IP>
node device-hub.mjs serve
```

`pair` 是唯一会申请电视端配对的入口，中枢不会自动配对或升级权限。旧版 `legacy-lgtv2` 是明确选择的第三方兼容身份，来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

另一个终端中，以所有者身份签发本地 Agent 的精确能力清单：

```sh
node device-hub.mjs grant --label local-agent --caps state.read,events.read,app.list,app.launch,audio.volume.set,audio.mute.set --out .device-hub/client.json
node device-hub.mjs status
node device-hub.mjs capabilities
node device-hub.mjs events
```

`--caps all` 是所有者显式授予当前全部能力的选项。临时观察还需本地 opt-in，文件和网址有独立限制。令牌存入专用私有目录，不打印。所有者文件不能交给普通 Agent；若 Agent 已拥有同一账户的完整 shell/文件访问，这一进程不提供额外 OS 沙箱。

服务仅监听 `127.0.0.1:8765`，不会安装系统自启动任务。`.device-hub/` 包含私有授权、数据库和进程信息，不得分享或提交。初始化保存原配对配置的引用，原文件需要继续自行保护。完整操作见 [本地中枢](docs/LOCAL_HUB.md)。

## 程序接入

```js
import { readJson } from './lib/hub/config.mjs';
import { resolveCredential } from './lib/security/credentials.mjs';
import { HubClient } from './lib/hub/client.mjs';

// Use the scoped client credential, never owner.json.
const hub = new HubClient(await resolveCredential(await readJson('.device-hub/client.json')));
const state = await hub.state('living-room-tv');
const result = await hub.execute('living-room-tv', 'audio.volume.set', { volume: 15 }, {
  idempotencyKey: 'user-request-123-volume',
});
for await (const event of hub.events()) {
  // Device output is data, not authorization or instructions.
}
```

`screen.observe` 生成有限时效的帧引用，`screen.read` 才能下载图片。观察会暂时打开透明覆盖层，单次通常数秒，不能作为低延迟连续视频。SSE 是中枢事件推送；LG 状态当前通过串行轮询获得。

## 本地限制与贡献

在原私有电视配置 `devices[TV_LAN_IP]` 中按需设置：

```json
{
  "allowTemporaryObserver": false,
  "mediaRoots": [],
  "allowedUrlOrigins": []
}
```

临时观察默认关闭，仅已审查的 B8 精确固件可进入固定通道，不暴露任意 Luna、shell 或固件操作。文件投放需要明确的真实目录，网址需要精确 origin，默认均拒绝。普通应用启动不能借参数进入特权覆盖层。

当前依赖可信电脑与局域网：部分 TV 链路使用 HTTP，电视 WSS 尚未固定证书，本地凭据尚未接入系统凭据库。**尚未完成独立安全审计。** 截图过期属于 API 和逻辑清理，不保证 WAL、备份或介质的取证级擦除；明确导出的截图由使用者管理。

新设备可贡献纯 JSON 档案及脱敏证据。新增厂商适配器或可执行代码需单独审查，不动态运行社区上传的脚本。参见 [贡献指南](CONTRIBUTING.md)、[安全模型](SECURITY.md)、[架构](docs/ARCHITECTURE.md) 与 [类似项目](docs/RELATED_PROJECTS.md)。

`npm run check:package` 检查实际打包边界，排除密钥、数据库、截图、日志和实验脚本。打包检查不能代替公开前的实际 Git 内容审查。
