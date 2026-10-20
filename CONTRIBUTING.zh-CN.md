# 贡献入门

[English canonical guide](CONTRIBUTING.md)

欢迎提交兼容性报告、设备实测证据、机型配置、适配器代码或文档修正。
支持范围按“精确型号、固件和具体能力”记录，不能由同品牌推断兼容。

目前有 LG OLED65B8PUA／05.50.70 的有限实测，以及 US ECOVACS X11 的
只读 Hub 实测。新适配器中的扫地机移动控制尚未真机验证；LG 新增证书固定
链路也仍待该电视开机后验证。以[支持表](docs/SUPPORTED_DEVICES.md)和
[安全部署说明](docs/SECURE_SETUP.md)为准。

- 提交型号、固件或能力报告：使用
  [设备报告](https://github.com/wudaming00/AnyAdapterHub/issues/new?template=device-report.yml)。
- 新 LG 型号配置：按[机型配置教程](docs/CONTRIBUTOR_GUIDE.md#model-profile-walkthrough)
  提交严格 JSON 和脱敏证据。当前配置 schema 仅支持 LG；不能伪造扫地机固件来套用。
- 新厂商或协议：先读[架构](docs/ARCHITECTURE.md)与
  [真实适配器接口](docs/ADAPTER_REQUIREMENTS.md)，提交固定能力、参数校验、拒绝路径、
  状态反馈、可选依赖及许可证说明。
- 安全漏洞：按[安全说明](SECURITY.md)私下联系，不在公开 issue 中贴出利用细节或密钥。

开发使用 Node.js 22.13.0 以上。先 `npm ci --ignore-scripts`，完整 JavaScript
测试前显式执行 `npm run adapter:lg:install`，再运行 `npm test`、
`npm run check:profiles`、`npm run check:package`、`npm run check:docs`。Python worker 的依赖和测试
见[独立说明](optional/ecovacs/README.md)。审查并暂存明确的公开文件后，再执行
`npm run check:public`；该检查针对 Git 暂存区。

生产密钥提供程序目前仅实现 Windows CurrentUser DPAPI。Linux/macOS 的可移植
测试使用显式注入的测试提供程序，不代表这些平台可以部署真实设备服务。

安装依赖、启用适配器、登记设备、选择功能和授予客户端权限分别控制。
机型 JSON 只描述兼容性与证据，不会安装代码、配对设备或提升权限。
不要提交 IP、MAC、账号和设备标识、配对密钥、令牌、cookies、私人路径、地图、
观看记录或个人画面。请求成功、状态读回、实际效果和任务完成须分别记录。
不确定的控制结果不得自动重放，离线测试不能替代真机证据。
