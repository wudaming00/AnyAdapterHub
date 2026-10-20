# 家用设备集成路线图：50 项候选

资料核查日期：2026-10-20。这里列出 50 项**不同的集成入口**，便于选择协议、安排开发和贡献证据；它不是已支持的 50 个品牌，也不是市场销量排名。品牌入口、桥接平台和通用协议可能覆盖同一台设备，不能把覆盖数相加。每行的链接来自厂商、标准组织或相应开源项目；社区项目不代表硬件厂商背书。

当前固定源码目录有 **13 个适配入口**：现有 LG、ECOVACS，以及 HA 灯、MQTT、Hue、Shelly、SwitchBot、ThinQ、HA 传感器、openHAB、Plex、Awair 和 PurpleAir 的实验范围。这对应本表 12 项集成候选，HA 灯/传感器为两个独立入口。新增范围均未获家庭硬件验证；具体能力以源码、CLI 目录和客户端权限交集为准。参见[常见设备接入](COMMON_ADAPTERS.md)及[HA/MQTT 接入](POPULAR_ADAPTERS.md)。开发或测试通过不等于硬件验证，也不授权配对设备、修改家庭配置或扩大权限。

现有证据只覆盖 [LG OLED65B8PUA / 05.50.70 的限定能力](SUPPORTED_DEVICES.md)及 [ECOVACS X11 的限定只读配置](ECOVACS_X11.md)。LG 的早期观察与后续固定证书重测必须区分；X11 固件未知，移动命令仅有离线测试。以下不能据此推广到其他尺寸、地区、固件或同品牌产品。

阶段：**P0 实验源码**＝已有有限实现、硬件未验证；**P1 后续优先**＝仍需所列基础设施或授权工作；**P2 研究/桥接**＝需授权流程、平台或依赖工作；**P3 暂缓**＝明文、凭据 URL、平台条款或证据缺口未解决；**现有·窄证据**＝仅保留已公开的精确硬件边界。优先级是工程判断，不是交付承诺。

## 灯光、开关、传感器、桥接与标准

| # | 候选入口 | 常见类别 / 路线 | 官方 API / SDK 或社区来源 | 本地 / 云与 TLS 约束 | 首批限定功能 | 阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Home Assistant | 已接入 HA 的单灯或固定契约传感器 | 官方 [REST API](https://contributors.home-assistant.io/core/internals/rest-api/)；[TLS 设置](https://www.home-assistant.io/integrations/http/) | 本地 HTTPS；Bearer；必须验证证书/固定信任，拒绝 HTTP 降级 | 每次登记一个灯或传感器；默认只读，灯的 control/dimming 与 grant 分别限制开关/亮度；无任意服务 | P0 实验源码；硬件未验证 |
| 2 | Philips Hue | Bridge 下的指定灯 | 官方 [API v2](https://developers.meethue.com/develop/hue-api-v2/)；[HTTPS 与 SDK 说明](https://developers.meethue.com/new-hue-api/) | 本地 HTTPS；实体按键授权、应用密钥；v2 参考需开发者登录，旧 SDK 已弃用 | 指定灯状态、开关、亮度；不开放整屋场景/娱乐流 | P0 实验源码；硬件未验证 |
| 3 | LIFX | Wi-Fi 灯 | 官方 [LAN UDP 协议](https://lan.developer.lifx.com/docs/communicating-with-device)；[云 HTTPS 认证](https://api.developer.lifx.com/reference/authentication) | 本地 UDP 缺少本项目要求的 TLS 信任；云 HTTPS/OAuth 可评估 | 固定灯状态、显式开关、亮度；不用全灯选择器 | P2 云；P3 旧 LAN |
| 4 | Shelly Gen2+ | 灯负载继电器、插座、计量 | 官方 [RPC](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/)；[HTTPS](https://shelly-api-docs.shelly.cloud/gen2/General/CustomHTTPSCertificates/) | 本地；2.0.0+ 提供入站 HTTPS，升级旧机可能仍仅 HTTP；Digest 本身不加密，必须验证 TLS | 固定组件 `Switch.GetStatus` / `Switch.Set`、只读计量；无脚本/配置 RPC | P0 实验源码；硬件未验证 |
| 5 | ESPHome | DIY 灯、开关、环境传感器 | 项目官方 [Native API](https://esphome.io/components/api/)；[Python 客户端](https://github.com/esphome/aioesphomeapi) | 本地 protobuf/TCP；设备加密可选，适配器应强制 Noise 密钥并拒绝明文 | 固定实体传感值、灯亮度/开关；不执行自定义动作/OTA | P1；需可选运行时 |
| 6 | Matter | 已认证灯、插座、传感器 | 标准项目 [connectedhomeip SDK](https://github.com/project-chip/connectedhomeip)；[安全配网](https://developers.home.google.com/matter/primer/commissioning) | 本地 IP；PASE/CASE、设备证明与 Fabric 证书；Thread 需基础设施 | 已配网 node/endpoint 的 OnOff、LevelControl、只读测量 | P2 控制器基础工作 |
| 7 | MQTT / TLS | 数值传感器与明确消息契约 | [OASIS MQTT](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)；[Eclipse Mosquitto TLS/ACL](https://mosquitto.org/man/mosquitto-conf-5.html) | 本轮仅本地私有地址 TLS broker、固定证书、认证与精确 topic；MQTT.js 为可选依赖 | MQTT 5 固定 topic 数值只读；拒绝 retained；无发布/通配符/任意 JSON 命令 | P0 实验源码；硬件未验证 |
| 8 | Tasmota | 刷入该固件的 DIY 灯/继电器/传感器 | 项目官方 [MQTT 文档](https://tasmota.github.io/docs/MQTT/) | 优先 MQTT/TLS；ESP32 原生支持，ESP8266 需适用构建；HTTP 不能默认放行 | 未来按单设备消息契约读遥测；开关需另加审查能力 | P2；不随 MQTT 自动支持 |
| 9 | Nanoleaf OpenAPI | 面板灯、部分灯具 | 官方 [快速开始](https://support.nanoleaf.me/hc/en-us/articles/41105798500628-API-Quick-Start-Guide)；[认证](https://support.nanoleaf.me/hc/en-us/articles/41108368751892-API-Authentication-Security) | 本地 HTTP/16021，token 在路径；不符合无凭据 URL 和加密默认；合适机型可走 Matter | 将来限定状态/亮度；不直接开放当前原始 API | P3；优先 Matter |
| 10 | TP-Link / Tapo / Kasa | 灯、插座；如 Matter 的 Tapo P125M | [官方 P125M](https://www.tp-link.com/us/home-networking/smart-plug/tapo-p125m/)；[python-kasa 社区声明](https://python-kasa.readthedocs.io/en/latest/) | 优先已明确支持的 Matter 机型；社区直连协议随固件变化，非 TP-Link 官方 SDK | 已配网 endpoint 的开关/支持的测量；不做全品牌兼容声明 | P2 Matter；P3 旧直连 |
| 11 | WiZ | 灯、Matter 插座；如 Smart Plug Gen 2 | 官方 [Pro 云 API](https://docs.pro.wizconnected.com/)；[Matter 产品](https://www.wizconnected.com/en-us/p/accessory-smart-plug-gen-2/046677605452)；[社区 LAN 客户端](https://github.com/sbidy/pywizlight) | Pro 为 HTTPS/GraphQL、OAuth/PKCE，需发放 client ID；家用 Matter 优先；UDP 客户端非官方 | 单灯/插座状态、显式开关；不用整栋/整层操作 | P2 Matter/Pro；P3 UDP |
| 12 | WLED | DIY LED 灯带控制器 | 项目官方 [JSON API](https://kno.wled.ge/interfaces/json-api/)；[无 TLS 限制](https://kno.wled.ge/interfaces/websocket/) | 本地 HTTP/WS，无 TLS；仅代理前半段加密不等于端到端加密 | 将来状态、开关、有限静态亮度/颜色；无任意预设/配置 | P3 原始网络接口 |
| 13 | openHAB | 已存在的灯/传感 Item | 官方 [REST API](https://www.openhab.org/docs/configuration/restdocs) | 本地；API token；需配置 HTTPS、显式认证并关闭隐含 LAN 用户权限 | 固定类型 Item 状态只读；无 Item 命令，不编辑 Things/脚本/绑定 | P0 实验源码；硬件未验证 |
| 14 | Homey | hub 内指定设备能力 | 官方 [Web API 规范](https://api.developer.homey.app/http-and-socket.io/http-specification) | 云 OAuth 后建立 Homey 会话；有安全本地 URL；不可扩大授权 scope | 固定设备的状态、onoff、有限 dim；不启动任意 Flow | P2 |
| 15 | Hubitat | Maker API 中选择的设备 | 官方 [Maker API](https://docs2.hubitat.com/en/apps/maker-api) | 本地/云；当前文档正文未能提取，需先确认 TLS 和非 URL 凭据契约 | 契约确认后仅固定设备状态、开关/亮度 | P3 契约证据待补 |
| 16 | deCONZ / Phoscon | Zigbee bridge 下灯/传感器 | 厂商 [REST API](https://dresden-elektronik.github.io/deconz-rest-doc/getting_started/) | 文档使用本地 HTTP、API key 在路径；解锁窗口授权不解决传输/URL 隐私 | 未来限定灯状态/亮度、传感值；不开放原始 API | P3 原始接口 |
| 17 | Zigbee2MQTT | coordinator 下指定 Zigbee 设备 | 项目官方 [TLS 设置](https://www.zigbee2mqtt.io/guide/configuration/mqtt.html)；[消息契约](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html) | 本地 Zigbee + broker；可用 MQTT/TLS/客户端证书；设备兼容来自逐型号社区工作 | 将来只读已审查 expose；无入网、OTA、绑定或 bridge 管理 | P2；不随 MQTT 自动支持 |
| 18 | Aqara | hub 和环境/接触传感器 | 官方 [账户/OAuth 授权](https://opendoc.aqara.com/en/docs/developmanual/authManagement/aqaraauthMode.html) | 云 HTTPS；开发者应用、地区、资源授权；适用 hub 的 Matter 是另一条路线 | 指定资源温湿度/电量等只读；不扩大到全账户 | P2 |
| 19 | Z-Wave JS | USB controller 下灯、插座、传感器 | 项目官方 [SDK 文档](https://zwave-js.github.io/zwave-js/)；[源码](https://github.com/zwave-js/zwave-js) | 本地串口到 controller，RF 安全级别依设备/入网；S2 不能假定覆盖旧 S0/无安全设备 | 已入网 node/value 白名单的数值读取；排除锁、门、网络管理 | P2；独立依赖/密钥设计 |
| 20 | Tuya / Smart Life | 已授权灯、插座、传感器 | 官方 [命令 API](https://developer.tuya.com/en/docs/cloud/e2512fb901?id=Kag2yag3tiqn5)；[签名](https://developer.tuya.com/en/docs/iot/check-postman-sign?id=Kavfn3820sxg4) | 云 HTTPS、project/token/签名；地区、订阅和产品 datapoint 不同；社区 local 库非官方 | 固定 device/datapoint 的状态/显式开关；无任意 code/value 转发 | P2 |
| 21 | SwitchBot | 环境传感器；如 Meter / Meter Plus | 官方 [Open API](https://github.com/OpenWonderLabs/SwitchBotAPI) | 云 HTTPS；token/secret、时间戳、nonce/HMAC；hub 条件依设备 | 温湿度、电池只读；不含 Bot 按压、红外、锁 | P0 实验源码；硬件未验证 |
| 22 | Flic | 按钮/旋钮输入；Twist、Duo | 官方 [Hub Studio SDK](https://hubsdk.flic.io/static/documentation/) | hub 内 JS 运行时有 HTTPS/TLS 客户端；需主人安装明确代码，不是现成通用外部 REST API | 固定按钮事件和电量的认证输入；无任意代码上传工具 | P2 |
| 23 | eWeLink / SONOFF | 获准品牌/类型的开关和传感器 | 官方 [云 API v2](https://github.com/CoolKit-Technologies/eWeLink-API/blob/main/en/APICenterV2.md)；[准入/配额](https://github.com/CoolKit-Technologies/eWeLink-API/blob/main/en/Pricing.md) | 云 HTTPS、OAuth/AppID；品牌、设备类型、配额和资格有限制 | 固定设备状态、传感值；开关写入另行限权 | P2 |
| 24 | IKEA DIRIGERA | IKEA Zigbee 产品的 Matter bridge | 官方 [Matter bridge 说明](https://www.ikea.com/global/en/newsroom/innovation/ikea-dirigera-matter-bridge-240911/) | 本地 Matter/Fabric；实际 endpoint/cluster 需发现；不依赖非官方 hub REST | 支持的桥接灯/插座状态和传感值 | P2，依赖 Matter |
| 25 | Bosch Smart Home Controller | 灯、插座、家庭传感器 | 官方 [本地 REST API](https://github.com/BoschSmartHome/bosch-shc-api-docs)；[TLS 验证要求](https://github.com/BoschSmartHome/bosch-shc-api-docs/blob/master/best_practice/README.md) | 本地双向 TLS、客户证书、controller CA/身份验证；不关闭证书验证 | 指定服务只读，之后限定灯开关；不用警报/锁/系统配置 | P1/P2 |

## 影音、家电、环境与摄像设备

| # | 候选入口 | 常见类别 / 路线 | 官方 API / SDK 或社区来源 | 本地 / 云与 TLS 约束 | 首批限定功能 | 阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| 26 | LG webOS | 电视；现有 OLED65B8PUA / 05.50.70 | LG 起源 [Connect SDK](https://connectsdk.com/en/latest/apis-and/and-webostvservice.html)；[本仓库精确证据](SUPPORTED_DEVICES.md) | 本地 WSS、已有配对和固定证书；临时观察另有未端到端加密限制，默认关闭 | 保留已审查的状态/有限控制；历史播放状态不证明任意片名播放 | 现有·窄证据 |
| 27 | Roku ECP | 电视/流媒体盒 | 官方 [ECP 与平台限制](https://developer.roku.com/dev/docs/external-control-api) | 本地 HTTP/8060；当前文档限制第三方平台发送 ECP，技术可连不等于准许集成 | 先核对平台资格；当前不新增控制 | P3 条款/明文 |
| 28 | Google Cast | Chromecast、支持 Cast 的电视/音箱 | 官方 [Sender/Receiver SDK](https://developers.google.com/cast/docs/reference) | Android/iOS/Web sender 与明确用户会话；没有官方通用无头 Node sender，不能假装已有 | 经授权会话的状态、播放/暂停；不承诺受保护媒体或任意投屏 | P2 SDK 桥接 |
| 29 | Sonos | 音箱/播放器 | 官方 [OAuth 授权](https://docs.sonos.com/docs/authorize)；[本地 API 边界](https://docs.sonos.com/docs/connected-home-architecture) | 云 HTTPS/OAuth；playback-control-all scope 较宽，需公共 redirect；本地 API 并非普遍开放 | 指定播放器状态、有限播放/音量；Hub 内再次收窄权限 | P2 |
| 30 | Denon / Marantz HEOS | 功放/音箱 | 官方 [HEOS CLI 协议](https://assets.denon.com/documentmaster/us/heos_cli_protocolspecification-version.pdf) | 本地 Telnet/1255，无 TLS；不以“局域网”代替加密 | 将来有限播放器状态；不开放原始命令 | P3 明文 |
| 31 | Sony BRAVIA | 专业显示屏；消费机另行核实 | 官方 [PRO REST API](https://pro-bravia.sony.net/remote-display-control/rest-api/structure/) | 文档为 HTTP JSON-RPC/PSK；消费型号适用性和 HTTPS 需确认 | 精确型号的电源/输入状态只读；无系统配置 | P3 型号/TLS 待证 |
| 32 | Plex Media Server | 个人媒体服务器 | 官方 [OpenAPI](https://developer.plex.tv/pms/)；[安全连接](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/) | 固定服务器 HTTPS 身份与证书；当前公开端点无需 token，不采集凭据 | 仅 `/identity` 公开身份/在线状态；无会话、媒体库、观看史或 Companion 投放 | P0 实验源码；硬件未验证 |
| 33 | Samsung SmartThings | 指定已接入家电/传感器 | 官方 [入门](https://developer.smartthings.com/docs/getting-started/quickstart)；[查询设备](https://developer.smartthings.com/docs/service-integrations/query-and-list-devices) | 云 HTTPS/OAuth，设备选择和 capability scope；不把全账户 token 当全屋授权 | 固定设备状态，只读家电遥测 | P2 |
| 34 | LG ThinQ | 支持 ThinQ Connect 的家电 | 官方 [JS SDK](https://github.com/thinq-connect/jsthinqconnect)；[API 发布](https://www.lg.com/global/newsroom/news/home-appliance-solution/lg-opens-thinq-api-to-foster-smart-home-innovation/) | 云 HTTPS、地区/PAT；profile 定义不等于每台设备全功能可用 | 指定设备 profile 和状态只读；无任意 property 写入 | P0 实验源码；硬件未验证 |
| 35 | Home Connect | 已获准联网洗衣/洗碗等家电 | 官方 [快速开始/模拟器](https://api-docs.home-connect.com/quickstart)；[OAuth scopes](https://api-docs.home-connect.com/authorization/) | 云 HTTPS/OAuth；使用 Monitor 等窄 scope；有官方模拟器 | 工作状态、剩余时间/事件只读；不启动程序、开门或加热 | P1/P2 只读 |
| 36 | Miele | 已授权联网家电 | 官方 [接口概念](https://developer.miele.com/docs/general-concept)；[授权](https://developer.miele.com/docs/authorization2) | 云 HTTPS/OAuth、逐设备同意；读/写/媒体 scope 分开 | `mcs_thirdparty_read` 的状态/剩余时间；无烹饪/门/程序启动 | P2 只读 |
| 37 | Sensibo | 空调控制器与环境遥测 | 官方 [API](https://support.sensibo.com/api/) | HTTPS，但文档要求个人 API key 在 query；违反无凭据 URL 边界 | 凭据安全契约解决后才考虑环境状态；无 HVAC 写入 | P3 凭据 URL |
| 38 | ecobee | 恒温器/室内传感器 | 官方 [开发者门户](https://www.ecobee.com/en-us/developers/) | 云 OAuth API；当前不接受新开发者注册，不能承诺普通新用户可接入 | 既有合规资格下的遥测只读；无设定温度/模式写入 | P3 注册受限 |
| 39 | Resideo / Honeywell Home | 恒温器/环境设备 | 官方 [开发者入门](https://developer.honeywellhome.com/content/getting-started-guide) | 云 HTTPS/OAuth；apikey query 需先解决凭据 URL；无模拟器 | 仅气候遥测；不写 HVAC 模式/温度 | P3 凭据契约 |
| 40 | Airthings | 室内空气质量传感器 | 官方 [Consumer API](https://consumer-api-doc.airthings.com/docs/api/postman-setup)；[适用说明](https://help.airthings.com/en/articles/4510990-integrations-airthings-api) | 云 HTTPS/client credentials；窄 scope `read:device:current_values` | 固定设备当前空气/温湿度读数与时间戳 | P1 只读 |
| 41 | Netatmo | 气象/室内环境站 | 官方 [OAuth](https://dev.netatmo.com/apidocumentation/oauth)；[官方 PHP SDK](https://github.com/Netatmo/Netatmo-API-PHP) | 云 HTTPS；按 `read_station` 等 scope；不复制旧 password grant 示例 | 指定 station/module 的环境读数；省略位置/账户资料 | P1/P2 只读 |
| 42 | Awair | 室内 CO2、PM、VOC 传感器 | 官方 [Developer API](https://docs.developer.getawair.com/) | 云 HTTPS/Bearer header 或 OAuth；配额和型号能力限制 | 指定设备最新数值、单位和观测时间 | P0 实验源码；硬件未验证 |
| 43 | PurpleAir | 环境颗粒物传感器 | 官方 [API 请求](https://community.purpleair.com/t/making-api-calls-with-the-purpleair-api/180)；[API key](https://community.purpleair.com/t/creating-api-keys/3951) | 云 HTTPS，`X-API-Key` header；read key/usage points | 指定 sensor 的颗粒物数据/新鲜度；不返回经纬度 | P0 实验源码；硬件未验证 |
| 44 | ECOVACS | 现有 US X11 OmniCyclone，固件未知 | [社区 SDK](https://github.com/DeebotUniverse/client.py) 非厂商官方；[本仓库边界](ECOVACS_X11.md) | 云、现有 Windows DPAPI enrollment；地区/device fingerprint 绑定；可选 GPL 依赖 | 保留已验证只读状态/细节；移动仅离线、无房间/地图/摄像 | 现有·窄证据 |
| 45 | iRobot Roomba / Braava | 清扫机器人状态 | [dorita980 社区库](https://github.com/koalazak/dorita980/blob/master/README.md)，非厂商官方 SDK | 本地 MQTT/TLS 与云；固件差异、旧 TLS/信任和配对需审查；不复制 password argv 示例 | 将来电量/任务状态只读；无清扫/移动 | P3 认证/TLS |
| 46 | Roborock | 清扫机器人状态 | [python-roborock 社区文档](https://python-roborock.github.io/python-roborock/roborock/devices.html)，非厂商官方 SDK | 云 MQTT/本地 TCP，通常先获云凭据；逆向协议的认证/信任需审查 | 将来固定设备电量/状态只读；无地图/移动 | P2/P3 |
| 47 | Google Nest SDM | 恒温器/摄像设备元数据 | 官方 [Device Access](https://developers.google.com/nest/device-access/get-started) | 云 HTTPS/OAuth、Cloud project、个人注册费/商业资格；权限按设备 traits | 元数据、在线/明确事件；无画面、音频或 HVAC 写入 | P2 只读 |
| 48 | Reolink | 摄像机/NVR 元数据 | 官方 [CGI 说明](https://support.reolink.com/hc/en-us/articles/900000617826/)；[API PDF](https://reolink.com/wp-content/uploads/2017/01/Reolink-CGI-command-v1.61.pdf) | 型号矩阵不同；文档有密码/token URL 示例，需先确认安全认证和 HTTPS | 将来系统/通道状态；不读画面、录像、音频或 PTZ | P3 凭据/TLS |
| 49 | Axis VAPIX | 摄像设备元数据 | 官方 [认证](https://developer.axis.com/vapix/authentication/)；[API](https://developer.axis.com/vapix/network-video/) | 本地 HTTPS/Basic + viewer 角色；需验证/固定证书，API 随 OS/型号不同 | 固定设备基本信息/在线状态；不读影像或改变镜头 | P1/P2 元数据 |
| 50 | Amcrest | 支持 HTTP API 的摄像机/NVR | 官方 [SDK 与产品排除](https://support.amcrest.com/hc/en-us/articles/4410620161933-Amcrest-HTTP-API-SDK)；[NVR HTTPS](https://support.amcrest.com/hc/en-us/articles/39473000750989-How-To-Setup-HTTPS-Using-An-Amcrest-NVR) | 逐型号确认 HTTPS/认证；Zencam、Amcrest Smart Home 不在该 SDK 范围 | 将来系统/通道状态；不读取画面或执行 PTZ | P2/P3 元数据 |

## 本轮边界与贡献方式

### 其余候选的实际前提

| 候选编号 | 继续实现需要补齐的工作 |
| --- | --- |
| 3、14、18、20、23、29、33、35、36、40、41、47 | 厂商应用/地区/设备授权、受限 scope、已审查的 OAuth 登录与续期，部分另有资格或项目要求；当前没有通用 OAuth broker。不能用一次性的手工 token 假装完成长期登录。 |
| 5 | ESPHome 需可选 Python Native API worker、Noise PSK 与设备身份绑定、依赖/许可证和进程通信审查；可先通过已接入 HA 的受限实体读取，但这不是直接 Native API 支持。 |
| 6、10、11、24 | Matter/Thread 控制器、Fabric 密钥与安全配网、逐 endpoint 的 cluster/权限映射；不同品牌机型还需对应证据。WiZ Pro 另需应用授权。 |
| 8、17 | 在现有 MQTT/TLS 之上新增逐类型的固定 JSON/单位契约与设备身份/型号证据；当前数值订阅不解析这些品牌协议。 |
| 19、22、25 | Z-Wave 串口/S2 与控制器密钥、Flic hub 内运行时、Bosch 双向 TLS 客户证书等各自独立基础设施及主人登记流程。 |
| 28 | Cast 官方 sender/receiver 会话桥接及平台运行时；当前没有官方通用无头 Node sender，也没有承诺受保护内容串流。 |
| 9、12、15、16、27、30、31、37、38、39、45、46、48、50 | 各行所列明文、凭据 URL、平台条款/注册限制、逆向身份或逐型号安全契约尚未解决；不通过降低传输或凭据要求来增加覆盖。 |
| 49 | Axis 的具体型号/OS、最小 viewer 角色、固定 VAPIX 方法与证书登记仍需独立适配及模型证据；当前未实现摄像设备入口。 |

这些是未完成的集成工作，不是“已支持”标志。可用 HA/openHAB 实体桥接的家庭，可以使用现有受限实体适配；直接厂商接入仍需分别实现和验证。

**MQTT 适配器只实现选定 broker、固定 topic、受限数值的消息契约。** 它不解析 Tasmota、Zigbee2MQTT、ESPHome 或任何品牌的发现/命令协议，也不因此获得这些硬件的直接支持。经 broker 接收到一个值，只证明收到了该消息；必须保留数据来源、观测时间、过期时间和缓存/retained 限制，不能推断传感器当前物理值。将来每一种消息契约和硬件声明都需单独的源码审查、fixture 与精确硬件证据。

**Home Assistant 桥接只覆盖分别登记的灯或固定契约传感器实体。** 传感器仅只读；连接 HA 不会开放它接入的全部家电，不允许通用服务、模板、脚本、事件、URL 或实体转发。状态读回的验证范围是 HA 报告的状态，不能自动升级为物理效果；灯光写入有歧义时不自动重发。

本轮不新增锁、门、烹饪、HVAC 写入、机器人移动、摄像画面/录像/音频能力。普通开关也必须限定非关键负载；采用显式设值而非 toggle。明文 LAN、证书绕过、凭据出现在 URL、自动信任新证书、任意 HTTP/RPC/MQTT 转发都不能为了扩大目录覆盖而默认放行。TLS 代理只保护它实际覆盖的链路。

新适配器先用离线 fixture 验证权限拒绝、目标绑定、TLS/pin 失败、大小/类型边界、过期数据、脱敏、超时与有歧义结果；不为补测试而访问家电。主人依赖安装、设备配对、秘密保存、功能启用与 agent grant 相互独立，秘密只进入受保护的本地边界。现有可信进程权限不构成 OS 沙箱。

贡献入口：[适配器手册](AI_ADAPTER_GUIDE.md)、[源码契约](ADAPTER_REQUIREMENTS.md)、[精确支持矩阵](SUPPORTED_DEVICES.md)、[贡献与检查](../CONTRIBUTING.md)、[独立审查/管理员批准](AGENT_REVIEW.md)。候选路线图不替代协议条款、独立技术审查、精确最终 revision 的管理员合并批准或硬件主人的本地授权。
