use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::Command,
    str::FromStr,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Components, Disks, Networks, System};
use tauri::State;

const MAX_IMAGE_BYTES: usize = 512 * 1024;
/// 两次采样间隔的下限，避免用户快速切换频率时除以一个接近 0 的时间。
const MIN_SAMPLE_SECONDS: f64 = 0.2;

struct HttpState {
    client: Client,
}

/// `Networks::refresh` 给出的是「距上次刷新的字节增量」，不是速率。
/// 时间戳必须和 `networks` 放在同一把锁里，才能保证增量与经过时间成对更新。
struct NetworkSampler {
    networks: Networks,
    sampled_at: Instant,
}

struct MetricsState {
    system: Mutex<System>,
    network: Mutex<NetworkSampler>,
    disks: Mutex<Disks>,
    components: Mutex<Components>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCheckResult {
    online: bool,
    latency_ms: u128,
    status: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushImageArgs {
    ip: String,
    image_bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushImageResult {
    ok: bool,
    status: u16,
    latency_ms: u128,
    bytes: usize,
    response: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemMetrics {
    cpu_usage: f32,
    memory_used: u64,
    memory_total: u64,
    disk_used: u64,
    disk_total: u64,
    network_down: u64,
    network_up: u64,
    uptime: u64,
    temperature: Option<f32>,
    gpu_usage: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProviderUsage {
    provider: String,
    quota_remaining_percent: Option<f64>,
    quota_used_percent: Option<f64>,
    quota_window: Option<String>,
    resets_at: Option<String>,
    reset_description: Option<String>,
    quota_source: Option<String>,
    quota_error: Option<String>,
    today_tokens: Option<u64>,
    today_cost_usd: Option<f64>,
    last_30_days_tokens: Option<u64>,
    last_30_days_cost_usd: Option<f64>,
    cost_source: Option<String>,
    cost_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiUsageSnapshot {
    engine: String,
    fetched_at_epoch_ms: u64,
    providers: Vec<AiProviderUsage>,
}

fn find_executable(name: &str, extra_candidates: &[&str]) -> Option<PathBuf> {
    if let Some(paths) = env::var_os("PATH") {
        for directory in env::split_paths(&paths) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    extra_candidates
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

fn find_codexbar() -> Option<PathBuf> {
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            let bundled_candidates = [
                directory.join("lingxi-ai-monitor"),
                directory.join("lingxi-ai-monitor.exe"),
                directory.join("../Resources/lingxi-ai-monitor"),
            ];
            if let Some(candidate) = bundled_candidates
                .into_iter()
                .find(|candidate| candidate.is_file())
            {
                return Some(candidate);
            }
        }
    }

    find_executable(
        "codexbar",
        &[
            "/opt/homebrew/bin/codexbar",
            "/usr/local/bin/codexbar",
            "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
        ],
    )
}

/// CodexBar 官方 CLI 已经把 Codex/Claude 的数据源回退、JSONL 去重和模型价格表
/// 封装成稳定 JSON。这里把它作为只读本地引擎，应用本身不接触 auth.json、
/// 浏览器 Cookie 或 Keychain 中的凭据。
fn run_codexbar_json(binary: &Path, args: &[&str]) -> Result<Value, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|error| format!("无法启动 CodexBar CLI：{error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    // `--provider both` 在某个服务不可用时会返回非零退出码，但 stdout 仍是包含
    // 另一服务真实数据的合法 JSON，因此以能否解析 JSON 为准，保留部分成功结果。
    serde_json::from_str(&stdout).map_err(|error| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().last().unwrap_or("未返回可解析数据");
        format!("CodexBar 数据解析失败：{error}；{detail}")
    })
}

fn provider_entry<'a>(payload: &'a Value, provider: &str) -> Option<&'a Value> {
    payload
        .as_array()?
        .iter()
        .find(|entry| entry.get("provider").and_then(Value::as_str) == Some(provider))
}

fn quota_window_label(window_minutes: Option<u64>) -> Option<String> {
    let minutes = window_minutes?;
    if minutes < 24 * 60 {
        let hours = minutes.div_ceil(60);
        return Some(format!("{hours} 小时额度"));
    }
    let days = minutes.div_ceil(24 * 60);
    Some(format!("{days} 天额度"))
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer)?.as_str().map(str::to_string)
}

fn select_most_constrained_window(
    provider: &Value,
) -> Option<(f64, Option<u64>, Option<String>, Option<String>)> {
    ["primary", "secondary", "tertiary"]
        .iter()
        .filter_map(|name| {
            let window = provider.pointer(&format!("/usage/{name}"))?;
            let used = window.get("usedPercent")?.as_f64()?;
            let minutes = window.get("windowMinutes").and_then(Value::as_u64);
            let resets_at = window
                .get("resetsAt")
                .and_then(Value::as_str)
                .map(str::to_string);
            let reset_description = window
                .get("resetDescription")
                .and_then(Value::as_str)
                .map(str::to_string);
            Some((used, minutes, resets_at, reset_description))
        })
        .max_by(|left, right| left.0.total_cmp(&right.0))
}

fn parse_provider_usage(
    provider: &str,
    quota_payload: &Result<Value, String>,
    cost_payload: &Result<Value, String>,
) -> AiProviderUsage {
    let quota_entry = quota_payload
        .as_ref()
        .ok()
        .and_then(|payload| provider_entry(payload, provider));
    let cost_entry = cost_payload
        .as_ref()
        .ok()
        .and_then(|payload| provider_entry(payload, provider));

    let quota_window = quota_entry.and_then(select_most_constrained_window);
    let quota_used_percent = quota_window
        .as_ref()
        .map(|window| window.0.clamp(0.0, 100.0));
    let quota_remaining_percent = quota_used_percent.map(|used| 100.0 - used);
    let quota_error = quota_entry
        .and_then(|entry| string_at(entry, "/error/message"))
        .or_else(|| quota_payload.as_ref().err().cloned());
    let cost_error = cost_entry
        .and_then(|entry| string_at(entry, "/error/message"))
        .or_else(|| cost_payload.as_ref().err().cloned());
    AiProviderUsage {
        provider: provider.to_string(),
        quota_remaining_percent,
        quota_used_percent,
        quota_window: quota_window
            .as_ref()
            .and_then(|window| quota_window_label(window.1)),
        resets_at: quota_window.as_ref().and_then(|window| window.2.clone()),
        reset_description: quota_window.as_ref().and_then(|window| window.3.clone()),
        quota_source: quota_window.as_ref().and_then(|_| {
            quota_entry
                .and_then(|entry| entry.get("source"))
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        quota_error,
        today_tokens: cost_entry
            .and_then(|entry| entry.get("sessionTokens"))
            .and_then(Value::as_u64),
        today_cost_usd: cost_entry
            .and_then(|entry| entry.get("sessionCostUSD"))
            .and_then(Value::as_f64),
        last_30_days_tokens: cost_entry
            .and_then(|entry| entry.get("last30DaysTokens"))
            .and_then(Value::as_u64),
        last_30_days_cost_usd: cost_entry
            .and_then(|entry| entry.get("last30DaysCostUSD"))
            .and_then(Value::as_f64),
        cost_source: cost_entry
            .and_then(|entry| entry.get("source"))
            .and_then(Value::as_str)
            .map(str::to_string),
        cost_error,
    }
}

fn collect_ai_usage() -> Result<AiUsageSnapshot, String> {
    let binary = find_codexbar().ok_or_else(|| {
        "未找到 CodexBar CLI。请安装 CodexBar，或在 CodexBar「高级」设置中安装 CLI。".to_string()
    })?;
    // Codex 与 Claude 的额度读取互不依赖，并行执行可避免单个服务超时
    // 拖慢整个 AI 页面。
    let provider_ids = ["codex", "claude"];
    let quota_payloads = std::thread::scope(|scope| {
        let handles = provider_ids.map(|provider| {
            let binary = &binary;
            scope.spawn(move || {
                (
                    provider,
                    run_codexbar_json(binary, &["--provider", provider, "--format", "json"]),
                )
            })
        });
        handles.map(|handle| handle.join().expect("AI provider worker panicked"))
    });
    let cost_payload = run_codexbar_json(
        &binary,
        &[
            "cost",
            "--provider",
            "both",
            "--days",
            "30",
            "--format",
            "json",
        ],
    );

    if quota_payloads.iter().all(|(_, payload)| payload.is_err()) && cost_payload.is_err() {
        let quota_errors = quota_payloads
            .iter()
            .filter_map(|(_, payload)| payload.as_ref().err())
            .cloned()
            .collect::<Vec<_>>()
            .join("；");
        return Err(format!(
            "{}；{}",
            quota_errors,
            cost_payload.as_ref().unwrap_err()
        ));
    }

    let fetched_at_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;

    Ok(AiUsageSnapshot {
        engine: if binary
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("lingxi-ai-monitor"))
        {
            "内置 AI 采集引擎".to_string()
        } else {
            "CodexBar 本地引擎".to_string()
        },
        fetched_at_epoch_ms,
        providers: quota_payloads
            .iter()
            .map(|(provider, quota_payload)| {
                parse_provider_usage(provider, quota_payload, &cost_payload)
            })
            .collect(),
    })
}

#[tauri::command]
async fn get_ai_usage() -> Result<AiUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(collect_ai_usage)
        .await
        .map_err(|error| format!("AI 用量读取任务异常结束：{error}"))?
}

fn device_url(ip: &str, path: &str) -> Result<Url, String> {
    Ipv4Addr::from_str(ip).map_err(|_| "设备地址必须是有效的 IPv4 地址".to_string())?;
    Url::parse(&format!("http://{ip}{path}")).map_err(|error| error.to_string())
}

fn describe_request_error(error: &reqwest::Error, action: &str) -> String {
    if error.is_timeout() {
        return format!("{action}超时，请确认小屏已开机并与电脑处于同一局域网");
    }
    if error.is_connect() {
        return format!("{action}失败：{error}；请确认设备 IP 正确且小屏 API 服务已启动");
    }
    format!("{action}失败：{error}")
}

#[tauri::command]
async fn check_device(
    ip: String,
    state: State<'_, HttpState>,
) -> Result<DeviceCheckResult, String> {
    let url = device_url(&ip, "/api")?;
    let started_at = Instant::now();
    let response = state
        .client
        .get(url)
        .send()
        .await
        .map_err(|error| describe_request_error(&error, "连接设备"))?;
    let status = response.status();

    Ok(DeviceCheckResult {
        online: status.is_success(),
        latency_ms: started_at.elapsed().as_millis(),
        status: status.as_u16(),
    })
}

#[tauri::command]
async fn push_image(
    args: PushImageArgs,
    state: State<'_, HttpState>,
) -> Result<PushImageResult, String> {
    if args.image_bytes.is_empty() {
        return Err("JPEG 数据为空".to_string());
    }
    if args.image_bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片超过设备 512KB 限制".to_string());
    }
    if !args.image_bytes.starts_with(&[0xff, 0xd8]) {
        return Err("设备仅接受 JPEG 图片".to_string());
    }

    let url = device_url(&args.ip, "/image/upload")?;
    let bytes = args.image_bytes.len();
    let started_at = Instant::now();
    let response = state
        .client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
        .body(args.image_bytes)
        .send()
        .await
        .map_err(|error| describe_request_error(&error, "推送请求"))?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .unwrap_or_else(|_| "设备未返回文本".to_string());

    if !status.is_success() {
        return Err(format!(
            "设备返回 HTTP {}：{}",
            status.as_u16(),
            response_text
        ));
    }

    Ok(PushImageResult {
        ok: true,
        status: status.as_u16(),
        latency_ms: started_at.elapsed().as_millis(),
        bytes,
        response: response_text,
    })
}

/// 系统盘的挂载点：小屏上的「磁盘」一格代表本机状态，
/// 插一块移动硬盘不应该让这个数字跳动。
#[cfg(windows)]
fn system_root_mount() -> PathBuf {
    // sysinfo 在 Windows 上把挂载点报成 `C:\` 形式。
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    PathBuf::from(format!("{drive}\\"))
}

#[cfg(not(windows))]
fn system_root_mount() -> PathBuf {
    PathBuf::from("/")
}

/// 只取系统盘的容量。找不到根卷时（罕见的容器化 / 只读环境）
/// 退回到去重求和，至少不会把整格显示成 0。
fn root_disk_space(disks: &Disks) -> (u64, u64) {
    let root = system_root_mount();
    disks
        .iter()
        .find(|disk| disk.mount_point() == root)
        .map(|disk| (disk.total_space(), disk.available_space()))
        .unwrap_or_else(|| sum_unique_disks(disks))
}

/// 多个 APFS 卷共享同一个容器，每个卷都会报告整个容器的容量与剩余空间，
/// 直接相加会把一块 1TB 的盘算成好几 TB。这里用
/// `(文件系统, 总容量, 可用容量)` 作为容器指纹去重：同一容器内的卷三元组完全相同，
/// 而两块真正独立的盘同时在这三个值上逐字节一致的概率可以忽略。
fn sum_unique_disks(disks: &Disks) -> (u64, u64) {
    let mut seen: HashSet<(OsString, u64, u64)> = HashSet::new();
    disks
        .iter()
        .filter(|disk| {
            seen.insert((
                disk.file_system().to_os_string(),
                disk.total_space(),
                disk.available_space(),
            ))
        })
        .fold((0_u64, 0_u64), |(total, available), disk| {
            (
                total.saturating_add(disk.total_space()),
                available.saturating_add(disk.available_space()),
            )
        })
}

/// macOS：从 IOAccelerator 的 PerformanceStatistics 里读 GPU 占用率。
/// 多 GPU（核显 + 独显）时取最大值，与活动监视器的显示口径一致。
#[cfg(target_os = "macos")]
fn read_gpu_usage() -> Option<f32> {
    let output = std::process::Command::new("ioreg")
        .args(["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_gpu_usage(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn read_gpu_usage() -> Option<f32> {
    // 其他平台暂无免依赖的采集方式，返回 None 让前端显示「不可用」而不是 0%。
    None
}

#[cfg(target_os = "macos")]
fn parse_gpu_usage(text: &str) -> Option<f32> {
    const KEY: &str = "\"Device Utilization %\"=";
    text.match_indices(KEY)
        .filter_map(|(index, _)| {
            let digits: String = text[index + KEY.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse::<f32>().ok()
        })
        .reduce(f32::max)
        .map(|value| value.clamp(0.0, 100.0))
}

#[tauri::command]
async fn get_system_metrics(state: State<'_, MetricsState>) -> Result<SystemMetrics, String> {
    let mut system = state
        .system
        .lock()
        .map_err(|_| "无法读取系统状态".to_string())?;
    system.refresh_cpu_usage();
    system.refresh_memory();

    let mut sampler = state
        .network
        .lock()
        .map_err(|_| "无法读取网络状态".to_string())?;
    let sampled_at = Instant::now();
    let elapsed_seconds = sampled_at
        .duration_since(sampler.sampled_at)
        .as_secs_f64()
        .max(MIN_SAMPLE_SECONDS);
    sampler.networks.refresh(true);
    sampler.sampled_at = sampled_at;
    let (received, transmitted) =
        sampler
            .networks
            .iter()
            .fold((0_u64, 0_u64), |(down, up), (_, network)| {
                (
                    down.saturating_add(network.received()),
                    up.saturating_add(network.transmitted()),
                )
            });
    // 增量 ÷ 真实经过时间 = 字节/秒，采样频率改成 5 秒也不会再翻 5 倍。
    let network_down = (received as f64 / elapsed_seconds).round() as u64;
    let network_up = (transmitted as f64 / elapsed_seconds).round() as u64;

    let mut disks = state
        .disks
        .lock()
        .map_err(|_| "无法读取磁盘状态".to_string())?;
    disks.refresh(true);
    let (disk_total, disk_available) = root_disk_space(&disks);

    let mut components = state
        .components
        .lock()
        .map_err(|_| "无法读取温度状态".to_string())?;
    components.refresh(true);
    let temperature = components
        .iter()
        .filter_map(|component| component.temperature())
        .reduce(f32::max);

    Ok(SystemMetrics {
        cpu_usage: system.global_cpu_usage(),
        memory_used: system.used_memory(),
        memory_total: system.total_memory(),
        disk_used: disk_total.saturating_sub(disk_available),
        disk_total,
        network_down,
        network_up,
        uptime: System::uptime(),
        temperature,
        gpu_usage: read_gpu_usage(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .manage(HttpState { client })
        .manage(MetricsState {
            system: Mutex::new(System::new_all()),
            network: Mutex::new(NetworkSampler {
                networks: Networks::new_with_refreshed_list(),
                sampled_at: Instant::now(),
            }),
            disks: Mutex::new(Disks::new_with_refreshed_list()),
            // Windows 的温度读取通过 WMI 初始化多线程 COM。若在 Tauri 创建窗口前
            // 刷新 Components，会把 UI 主线程切到 MTA，随后 Tao 的 OleInitialize
            // 因 RPC_E_CHANGED_MODE 直接终止启动。空集合不会碰 COM；首次系统监控
            // 请求在异步命令线程调用 refresh 时再完成 WMI 初始化。
            components: Mutex::new(Components::new()),
        })
        .invoke_handler(tauri::generate_handler![
            check_device,
            push_image,
            get_ai_usage,
            get_system_metrics
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lingxi Display Studio");
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::parse_gpu_usage;
    use super::{
        parse_provider_usage, root_disk_space, select_most_constrained_window, sum_unique_disks,
    };
    use serde_json::{json, Value};
    use sysinfo::Disks;

    /// 根卷读数必须自洽，而且不能把同容器的其他卷再算一遍：
    /// 系统盘容量应当明显小于「所有本地卷相加」。
    #[test]
    fn root_disk_reports_only_the_boot_volume() {
        let disks = Disks::new_with_refreshed_list();
        let (total, available) = root_disk_space(&disks);
        let (deduped_total, _) = sum_unique_disks(&disks);
        let naive_total: u64 = disks.iter().map(|disk| disk.total_space()).sum();
        println!("root={total} deduped={deduped_total} naive={naive_total} available={available}");

        assert!(total > 0, "没有读到系统盘容量");
        assert!(available <= total, "可用空间不可能超过总容量");
        assert!(total <= naive_total, "系统盘不该大于所有卷之和");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_device_utilization_from_ioreg_dump() {
        let dump = r#"
      "PerformanceStatistics" = {"Tiler Utilization %"=16,"Device Utilization %"=19,"Renderer Utilization %"=15}
"#;
        assert_eq!(parse_gpu_usage(dump), Some(19.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn takes_the_busiest_gpu_when_several_are_present() {
        let dump = r#"
      "PerformanceStatistics" = {"Device Utilization %"=4}
      "PerformanceStatistics" = {"Device Utilization %"=87}
"#;
        assert_eq!(parse_gpu_usage(dump), Some(87.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn returns_none_when_the_key_is_absent() {
        assert_eq!(parse_gpu_usage("no accelerator here"), None);
    }

    /// 端到端跑一次真实的 ioreg 采集：拿不到值是允许的（虚拟机、精简系统），
    /// 但拿到的值必须落在合法区间里。
    #[test]
    fn samples_the_local_gpu_within_range() {
        let sample = super::read_gpu_usage();
        println!("read_gpu_usage() -> {sample:?}");
        if let Some(value) = sample {
            assert!((0.0..=100.0).contains(&value), "GPU 占用率越界：{value}");
        }
    }

    #[test]
    fn chooses_the_quota_window_with_the_least_remaining_capacity() {
        let payload = json!({
            "usage": {
                "primary": { "usedPercent": 28, "windowMinutes": 300 },
                "secondary": { "usedPercent": 47, "windowMinutes": 10080 }
            }
        });
        let selected = select_most_constrained_window(&payload).expect("应选出额度窗口");
        assert_eq!(selected.0, 47.0);
        assert_eq!(selected.1, Some(10080));
    }

    #[test]
    fn merges_quota_and_local_cost_payloads() {
        let quota: Result<Value, String> = Ok(json!([{
            "provider": "codex",
            "source": "codex-cli",
            "usage": {
                "secondary": {
                    "usedPercent": 47,
                    "windowMinutes": 10080,
                    "resetsAt": "2026-08-02T02:00:24Z"
                }
            }
        }]));
        let cost: Result<Value, String> = Ok(json!([{
            "provider": "codex",
            "source": "local",
            "sessionTokens": 71056872,
            "sessionCostUSD": 57.162166,
            "last30DaysTokens": 2062505357_u64,
            "last30DaysCostUSD": 1649.38482225
        }]));

        let merged = parse_provider_usage("codex", &quota, &cost);
        assert_eq!(merged.quota_remaining_percent, Some(53.0));
        assert_eq!(merged.quota_window.as_deref(), Some("7 天额度"));
        assert_eq!(merged.today_tokens, Some(71_056_872));
        assert_eq!(merged.last_30_days_tokens, Some(2_062_505_357));
    }

    #[test]
    fn keeps_local_cost_when_a_provider_quota_is_not_connected() {
        let quota: Result<Value, String> = Ok(json!([{
            "provider": "claude",
            "source": "auto",
            "error": { "message": "No Claude session key found in browser cookies." }
        }]));
        let cost: Result<Value, String> = Ok(json!([{
            "provider": "claude",
            "source": "local",
            "sessionTokens": 37546,
            "sessionCostUSD": 0.185694,
            "last30DaysTokens": 84467836,
            "last30DaysCostUSD": 78.7247506
        }]));

        let merged = parse_provider_usage("claude", &quota, &cost);
        assert_eq!(merged.quota_remaining_percent, None);
        assert_eq!(merged.quota_source, None);
        assert_eq!(merged.cost_source.as_deref(), Some("local"));
        assert_eq!(merged.today_tokens, Some(37_546));
    }
}
