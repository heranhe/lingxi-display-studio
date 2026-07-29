// Tauri 桌面程序在 Windows Release 构建中必须使用 GUI 子系统。
// 缺少该标记时，双击 exe 会先弹出一个控制台窗口，看起来像“闪退”。
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn install_startup_panic_reporter() {
    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    std::panic::set_hook(Box::new(|panic_info| {
        let reason = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(String::as_str)
            })
            .unwrap_or("未知启动错误");
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "未知位置".to_string());
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let report = format!(
            "灵犀小屏屏启动失败\n版本：{}\n时间戳：{timestamp}\n位置：{location}\n错误：{reason}\n",
            env!("CARGO_PKG_VERSION")
        );

        let log_path = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(env::temp_dir)
            .join("Lingxi Display Studio")
            .join("startup-error.log");
        if let Some(parent) = log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let log_written = fs::write(&log_path, report).is_ok();
        let detail = if log_written {
            format!(
                "程序无法启动，错误日志已保存到：\n{}\n\n请把该文件发给开发者。",
                log_path.display()
            )
        } else {
            format!("程序无法启动：\n{reason}")
        };

        let title: Vec<u16> = "灵犀小屏屏启动失败\0".encode_utf16().collect();
        let message: Vec<u16> = format!("{detail}\0").encode_utf16().collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }));
}

fn main() {
    #[cfg(all(not(debug_assertions), target_os = "windows"))]
    install_startup_panic_reporter();

    lingxi_display_studio_lib::run();
}
