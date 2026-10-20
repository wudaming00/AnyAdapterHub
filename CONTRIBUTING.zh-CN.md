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
每个家庭的本地配对与授权无需提交 PR，也无需其他用户批准。公共代码和机型贡献由
[独立审查 agent](docs/AGENT_REVIEW.md)检查；安全敏感变更再由第二个安全 agent 复核。
审查 agent 评估共享代码；项目管理员批准官方仓库合入及另行发布；家庭管理员
（本地 owner）批准自家设备配对和权限，家中接入不需要项目管理员审批。
审查结果绑定最终提交，必需 CI 通过后，还须由指定仓库管理员对具体 PR 和最终
提交 SHA 作出合并批准。编码 agent 不能代替管理员同意、自行绕过保护或自动合并。
若唯一管理员也是 PR 作者，GitHub 无法自我批准；应保持未合并，直到管理员针对
该 PR 和最终 SHA 明确授权具体的仓库所有者操作，详见审查政策。不得从“创建 PR”、
测试通过、沉默或较早的同意推定授权。之后有新提交，须重新审查、运行相应检查并
取得管理员对最终 SHA 的批准。目前没有持续云端审查或管理员自动确认服务。
不要提交 IP、MAC、账号和设备标识、配对密钥、令牌、cookies、私人路径、地图、
观看记录或个人画面。请求成功、状态读回、实际效果和任务完成须分别记录。
不确定的控制结果不得自动重放，离线测试不能替代真机证据。
