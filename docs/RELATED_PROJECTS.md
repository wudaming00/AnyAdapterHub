# Related projects

AnyAdapter Hub is an independent local device hub. The name describes a hub of device adapters for agents; AnyAdapter is its short name. Public naming searches are not trademark or domain clearance. The comparisons below describe upstream documentation as reviewed on 2026-10-19 and do not certify security or interoperability.

## 相近开源项目

| 项目 | 与本项目相关的能力 | 可采用或参考的部分 |
| --- | --- | --- |
| [Home Assistant 官方 MCP Server](https://www.home-assistant.io/integrations/mcp_server/) 与 [Assist](https://www.home-assistant.io/voice_control/) | Agent 获取家庭状态、控制设备；自然语言及语音入口。MCP 的实际可见范围取决于 LLM API 和实体暴露设置。 | 优先作为常规设备接入底座，避免重写大量厂商驱动。部署时逐项检查授权，不继承全部默认 API 范围。 |
| [openHAB 官方 MCP](https://www.openhab.org/addons/integrations/mcp/) | 按房间、设备等语义模型查询和控制，并支持自动化和状态监视。 | 参考语义设备模型；完整 REST、脚本和管理权限需要分开处理，不能随普通控制自动开放。 |
| [社区 HA-MCP](https://github.com/homeassistant-ai/ha-mcp) | 在 Home Assistant 上提供控制、自动化配置和诊断等更广的工具。它不是 HA 官方 MCP 集成。 | 参考工具组织与社区扩展方式；配置管理能力需独立授权。 |
| [Homebridge](https://developers.homebridge.io/) | 社区插件桥接不同厂商设备到 HomeKit。 | 参考适配器生态与兼容性维护；第三方可执行插件不能与纯数据机型档案混为一谈。 |
| [EMQX ThingLoom](https://github.com/emqx/thing-loom) | 从自然语言进入联网硬件制作，涵盖接线、固件、MQTT 和真实设备反馈。 | 与 Agent 进入硬件的方向接近，适合参考新硬件开发流程。 |

## 项目定位

**社区可验证的设备能力与执行反馈层。** 普通设备尽量通过 Home Assistant、openHAB 或经审查适配器接入；对旧电视这种现成集成观察不足的设备，增加型号和固件精确匹配的专用观察通道。

贡献内容应是“型号、固件、必要权限、已验证能力、脱敏证据”，而不是上传个人配对密钥或任意脚本。运行时区分请求接收、状态变化、画面确认，并报告失败、清理与恢复结果。

[Matter](https://csa-iot.org/all-solutions/matter/) 提供设备互通标准，但不能据此推断拥有电视应用内部片名、页面或登录状态。Home Assistant 与 Matter 接入尚未在本原型实现。
