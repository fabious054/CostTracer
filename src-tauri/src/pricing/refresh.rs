//! The background price/FX refresher (ADR 0006 D2). One long-lived task keeps
//! `pricing-cache.sqlite3` warm on its own — checking what's missing or past its window and
//! fetching it, with **no manual action** and **no scan required**. The scan never fetches; it
//! only reads whatever this has committed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;

use crate::aws;
use crate::model::PricingRefreshingEvent;
use crate::pricing::cache::CacheState;
use crate::pricing::{
    cache::PriceCache, fx, list_api, products_for, ProductKey, PRICED_TYPES, PRICING_ENDPOINT_REGION,
};
use crate::util::now_unix_secs;
use crate::vault;

/// Re-check cadence while the app is open — acts only on what's actually stale/missing (D2d).
const RECHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Cap on concurrent `GetProducts` calls. The Price List Query API throttles aggressively, so
/// this is deliberately low — the client's adaptive retry (see `list_api::client`) smooths the
/// rest.
const MAX_IN_FLIGHT: usize = 2;

/// Tauri managed state (D2c). `started` is the "spawn once" guard; `active` is whether a fetch
/// cycle is running right now (so a command / focus after the `pricing://` events were missed can
/// still learn the current state and show the strip).
#[derive(Default)]
pub struct PriceRefresher {
    started: AtomicBool,
    active: Arc<AtomicBool>,
    nudge: Mutex<Option<mpsc::UnboundedSender<()>>>,
}

impl PriceRefresher {
    /// Idempotent — spawns the loop the first time only. Safe to call from `setup` (no Tokio
    /// context yet) or from a command: uses Tauri's runtime spawner, not bare `tokio::spawn`.
    pub fn ensure_started(&self, app: AppHandle, cache: Arc<PriceCache>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        // A first cycle is imminent — mark active now so the boot-time `pricing://refreshing`
        // event isn't the only signal (the webview's listener may not be up yet).
        self.active.store(true, Ordering::SeqCst);
        let (tx, rx) = mpsc::unbounded_channel();
        *self.nudge.lock().expect("refresher nudge mutex") = Some(tx);
        tauri::async_runtime::spawn(run_loop(app, cache, rx, self.active.clone()));
    }

    /// Whether a fetch cycle is running right now.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Ask the loop to re-check now (e.g. a scan hit a region not yet cached).
    pub fn nudge(&self) {
        if let Some(tx) = self.nudge.lock().expect("refresher nudge mutex").as_ref() {
            let _ = tx.send(());
        }
    }
}

async fn run_loop(
    app: AppHandle,
    cache: Arc<PriceCache>,
    mut rx: mpsc::UnboundedReceiver<()>,
    active: Arc<AtomicBool>,
) {
    loop {
        refresh_once(&app, &cache, &active).await;
        tokio::select! {
            _ = tokio::time::sleep(RECHECK_INTERVAL) => {}
            r = rx.recv() => { if r.is_none() { break; } }
        }
    }
}

async fn refresh_once(app: &AppHandle, cache: &Arc<PriceCache>, active: &AtomicBool) {
    let now = now_unix_secs();

    let fx_due = matches!(
        cache.classify_fx(now),
        Ok(CacheState::Missing | CacheState::Stale)
    );

    // Prices need the connected credential (`pricing:GetProducts` is IAM-gated). FX doesn't.
    let stored = vault::load().ok().flatten();
    let mut price_work: Vec<(ProductKey, String)> = Vec::new();
    if let Some(s) = &stored {
        for region in &s.regions {
            for rt in PRICED_TYPES {
                for (key, _basis) in products_for(rt) {
                    if matches!(
                        cache.classify_price(&key, region, now),
                        Ok(CacheState::Missing | CacheState::Stale)
                    ) {
                        price_work.push((key, region.clone()));
                    }
                }
            }
        }
    }

    let pending = price_work.len() as u32 + fx_due as u32;
    if pending == 0 {
        active.store(false, Ordering::SeqCst);
        let _ = app.emit("pricing://idle", ());
        return;
    }
    active.store(true, Ordering::SeqCst);
    let _ = app.emit("pricing://refreshing", PricingRefreshingEvent { pending });
    eprintln!("[pricing] refresh: {pending} entr(y/ies) to fetch (fx_due={fx_due})");

    if fx_due {
        match fx::fetch_usd_brl().await {
            Ok(rate) => {
                let _ = cache.put_fx(Some(rate), now_unix_secs());
                eprintln!("[pricing] fx USD/BRL = {rate}");
            }
            Err(e) => {
                let _ = cache.put_fx(None, now_unix_secs());
                eprintln!("[pricing] fx fetch failed: {e}");
            }
        }
    }

    let mut ok = 0u32;
    let mut failed = 0u32;
    if !price_work.is_empty() {
        if let Some(s) = &stored {
            let base = aws::config::from_static_keys(
                &s.access_key_id,
                &s.secret_access_key,
                s.session_token.clone(),
                PRICING_ENDPOINT_REGION,
            )
            .await;
            let client = list_api::client(&base);

            let sem = Arc::new(Semaphore::new(MAX_IN_FLIGHT));
            let mut set: JoinSet<bool> = JoinSet::new();
            for (key, region) in price_work {
                let permit = sem.clone().acquire_owned().await.expect("semaphore closed");
                let client = client.clone();
                let cache = cache.clone();
                set.spawn(async move {
                    let _permit = permit;
                    let now = now_unix_secs();
                    match list_api::fetch(&client, &key, &region).await {
                        Ok((raw, rate)) => {
                            let _ = cache.put_price(&key, &region, Some(&raw), Some(rate), now);
                            true
                        }
                        Err(e) => {
                            eprintln!("[pricing] {}/{region}: {e}", key.key);
                            let _ = cache.put_price(&key, &region, None, None, now);
                            false
                        }
                    }
                });
            }
            while let Some(res) = set.join_next().await {
                match res {
                    Ok(true) => ok += 1,
                    _ => failed += 1,
                }
            }
        } else {
            eprintln!("[pricing] {} price(s) due but not connected — skipping", price_work.len());
        }
    }

    active.store(false, Ordering::SeqCst);
    eprintln!("[pricing] refresh done: {ok} ok, {failed} failed");
    let _ = app.emit("pricing://idle", ());
}
