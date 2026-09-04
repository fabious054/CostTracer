mod aws;
mod commands;
mod error;
mod scan;
mod session;
mod util;
mod vault;

// `pub` so the opt-in LocalStack harness (`tests/localstack.rs`, ADR 0003 D4) can drive the
// detector → store → pricing pipeline directly. Not part of a stable public API.
pub mod detectors;
pub mod model;
pub mod pricing;
pub mod store;

use std::sync::Arc;

use tauri::Manager;

use commands::ScanCancel;
use pricing::{PriceCache, PriceRefresher};
use session::OnboardingSession;
use store::Db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(OnboardingSession::default())
        .manage(ScanCancel::default())
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Db::open(dir.join("costtracer.sqlite3"))?);

            // Pricing cache lives in its own file — public, account-independent data (ADR 0006 D4).
            let prices = Arc::new(PriceCache::open(dir.join("pricing-cache.sqlite3"))?);
            app.manage(prices.clone());
            // Kick the background refresher now so FX (which needs no credential) warms before the
            // first scan; it's idempotent, the webview also calls `pricing_refresh_start`.
            let refresher = PriceRefresher::default();
            refresher.ensure_started(app.handle().clone(), prices);
            app.manage(refresher);
            Ok(())
        })
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
            commands::connection_account,
            commands::session_discard,
            commands::scan_run,
            commands::scan_cancel,
            commands::scan_latest,
            commands::pricing_refresh_start,
            commands::resource_mark_intentional,
            commands::resource_unmark_intentional,
            // DEV-ONLY — kept permanently (CLAUDE.md checklist, item 2 exception).
            #[cfg(debug_assertions)]
            commands::dev_seed_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the CostTracer application");
}
