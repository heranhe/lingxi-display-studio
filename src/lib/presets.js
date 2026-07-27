export const PRESET_CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "system", label: "系统" },
  { id: "performance", label: "性能" },
  { id: "network", label: "网络" },
  { id: "device", label: "设备" },
];

export const PRESETS = [
  {
    id: "system-overview",
    name: "系统总览",
    category: "system",
    description: "核心资源、实时网络与本机时钟",
    sources: ["系统实时", "本机时间"],
  },
  {
    id: "performance-trends",
    name: "性能趋势",
    category: "performance",
    description: "CPU 与网络历史采样趋势",
    sources: ["系统实时", "采样历史"],
  },
  {
    id: "network-traffic",
    name: "网络流量",
    category: "network",
    description: "上下行速率、趋势与设备延迟",
    sources: ["系统实时", "设备连接"],
  },
  {
    id: "hardware-health",
    name: "硬件健康",
    category: "performance",
    description: "处理器、GPU、温度与运行时间",
    sources: ["系统实时", "平台传感器"],
  },
  {
    id: "storage-memory",
    name: "存储与内存",
    category: "system",
    description: "容量占用与可用空间概览",
    sources: ["系统实时"],
  },
  {
    id: "minimal-status",
    name: "极简状态",
    category: "system",
    description: "时间、负载与网络的克制布局",
    sources: ["系统实时", "本机时间"],
  },
  {
    id: "device-operations",
    name: "设备运维",
    category: "device",
    description: "设备延迟、网络吞吐与主机健康",
    sources: ["系统实时", "设备连接"],
  },
  {
    id: "all-in-one",
    name: "全能仪表盘",
    category: "system",
    description: "一屏查看全部可用实时指标",
    sources: ["系统实时", "本机时间"],
  },
];

export function findPreset(presetId) {
  return PRESETS.find((preset) => preset.id === presetId) ?? PRESETS[0];
}
