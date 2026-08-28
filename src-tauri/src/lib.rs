mod aws;
mod commands;
mod error;
mod model;
mod session;
mod vault;

use session::OnboardingSession;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OnboardingSession::default())
        .invoke_handler(tauri::generate_handler![
            commands::session_resume,
            commands::detect_local_config,
            commands::policy_minimal_read,
            commands::open_url,
            commands::credential_submit_manual,
            commands::credential_use_detected,
            commands::credential_revalidate,
            commands::sso_start,
            commands::sso_poll,
            commands::sso_select_target,
            commands::permissions_check,
            commands::connection_finalize,
            commands::connection_disconnect,
            commands::session_discard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the CostTracer application");
}
