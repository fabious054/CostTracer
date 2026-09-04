//! The one non-AWS call (ADR 0006 D1): an anonymous USD→BRL lookup to `api.frankfurter.dev`
//! (ECB reference rates, no key, no account, the request carries only `base` / `symbols`).
//! Called only by the background refresher, at most once per 5-hour window.

use std::time::Duration;

const URL: &str = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL";

/// The current USD→BRL rate, or a short error string (→ the refresher writes a failure marker).
pub async fn fetch_usd_brl() -> Result<f64, String> {
    let resp = reqwest::Client::new()
        .get(URL)
        .header("accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("frankfurter request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("frankfurter returned HTTP {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("frankfurter response wasn't JSON: {e}"))?;

    body.pointer("/rates/BRL")
        .and_then(serde_json::Value::as_f64)
        .filter(|r| *r > 0.0)
        .ok_or_else(|| "frankfurter response had no positive rates.BRL".to_string())
}
