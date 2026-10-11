// デスクトップアプリの外枠（Tauri）。開発中は画面（vite）を開き、本番では同梱したサーバー
// （Hono＋SQLite、sidecar）を起動して、そのURLを開く。サーバーは127.0.0.1の空いているポートで動く。
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct Server(Mutex<Option<CommandChild>>);

/// 同梱したサーバーを起動し、画面のURLを返す。
fn start_server(app: &tauri::App) -> Result<String, Box<dyn std::error::Error>> {
    let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    // 画面のファイル（dist/web）は、アプリの資源として同梱してある。
    let resources = app.path().resource_dir()?;
    let (_events, child) = app
        .shell()
        .sidecar("server")?
        .env("DESKTOP", "1")
        .env("PORT", port.to_string())
        .env("DB_PATH", data_dir.join("app.db").to_string_lossy().to_string())
        .current_dir(resources)
        .spawn()?;
    app.manage(Server(Mutex::new(Some(child))));

    // サーバーが待ち受けるまで待つ。
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
        if Instant::now() > deadline {
            return Err("サーバーが起動しない".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let url = if cfg!(debug_assertions) {
                "http://127.0.0.1:5173".to_string()
            } else {
                start_server(app)?
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title(app.package_info().name.clone())
                .inner_size(960.0, 720.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("アプリを作れない")
        .run(|app, event| {
            // アプリを終えるとき、同梱したサーバーも止める。
            if let RunEvent::Exit = event {
                if let Some(server) = app.try_state::<Server>() {
                    if let Some(child) = server.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
