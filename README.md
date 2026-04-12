# cockpit-traffic-monitor

<img width="2281" height="1598" alt="image" src="https://github.com/user-attachments/assets/5f5094f9-834d-4a0e-b90f-7499956b71f3" />
<img width="1368" height="1368" alt="image" src="https://github.com/user-attachments/assets/87ecf9ed-703f-4367-b62c-99ecc40680aa" />
<img width="1355" height="1367" alt="image" src="https://github.com/user-attachments/assets/df798fa9-aa44-48e1-9b46-e0acf156fce2" />


Cockpit 网络接口实时流量监控插件，适用于物理服务器、虚拟化环境（Proxmox VE / KVM / Docker）。

## 功能

- 实时读取 `/proc/net/dev`，可配置刷新间隔（1s / 2s / 5s / 10s）
- 五大统计卡片：总接口数、活跃接口、总发送、总接收、当前总速率
- 多时间跨度流量图表：1分钟 / 5分钟 / 30分钟 / 1小时 / 6小时 / 12小时 / 24小时 / 3天 / 7天
- 鼠标悬停 tooltip 显示精确数值
- 接口名称模糊搜索（`Ctrl+K`）
- Excel 式列筛选：状态、名称、类型列下拉复选框筛选
- 9 列排序
- 接口详情弹窗：基本信息、流量统计、历史图表、实时速率、错误丢包
- WiFi 接口：信号强度、信道、频段、附近网络扫描列表
- 暗色 / 明亮主题，跟随系统自动切换
- 自定义流量单位（自动 / B / KB / MB）
- 按接口类型独立开关控制

## 接口类型

| 类型 | 匹配模式 |
|------|----------|
| 物理网卡 | `eth*` `enp*` `eno*` `ens*` |
| 绑定接口 | `bond*` |
| VLAN 子接口 | `*.10` `*.100` |
| 网桥 | `vmbr*` `br-*` `virbr*` |
| 防火墙接口 | `fwpr*` `fwn*` `fwln*` `fwbr*` |
| 无线 | `wlan*` `wlp*` `wlo*` |
| TAP/TUN | `tap*` `tun*` |
| 虚拟以太网 | `veth*` |
| 虚拟接口 | `docker*` `wg*` `ppp*` |
| 回环 | `lo` |

## 安装

### 从 Release 下载

前往 [Releases](../../releases) 页面下载最新 `.deb` 文件。

```bash
sudo dpkg -i cockpit-traffic-monitor_*_all.deb
```

### 本地构建

```bash
./build.sh
sudo dpkg -i cockpit-traffic-monitor_*_all.deb
```

安装后刷新 Cockpit 页面，左侧菜单出现 `traffic-monitor`。

## 卸载

```bash
sudo dpkg -r cockpit-traffic-monitor
```

## 项目结构

```
├── build.sh                # 构建脚本
├── index.html              # 主页面
├── manifest.json           # Cockpit 插件清单
├── LICENSE                 # MIT 协议
├── CHANGELOG.md            # 版本历史
├── .github/workflows/
│   └── release.yml         # GitHub Actions 手动构建 Release
└── src/
    ├── style.css           # 样式
    └── app.js              # 核心逻辑
```

## 依赖

- Cockpit >= 286
- vnstat（后台流量统计，deb 安装时自动拉取）
- 可选：`nmcli`（NetworkManager，用于无线信息）
- 可选：`iw`（无线工具）

## 技术

- 纯前端 HTML + CSS + JavaScript，无外部依赖
- Canvas API 绘制图表
- Cockpit API 读取系统文件

## License

MIT
