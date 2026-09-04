//! The read-only price snapshot the scan works from. Loaded from `PriceCache` in one query at the
//! top of `build_scan_result`; `estimate` only ever reads it (ADR 0006 D2).

use std::collections::HashMap;

use crate::model::{FxState, FxStatus};

/// One `(flat key, region)` entry as the scan sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PriceEntry {
    /// A usable rate. `priced_at` is `Some` only when it came from an **expired** cache row
    /// (drives the "price cached {date}" note); `None` for a fresh value.
    Priced { usd_per_unit: f64, priced_at: Option<i64> },
    /// The refresher tried the Price List API and got nothing (failure marker in the cache).
    Failed,
}

#[derive(Debug, Clone, Default)]
pub struct PriceBook {
    prices: HashMap<(String, String), PriceEntry>,
    fx: Option<FxStatus>,
}

impl PriceBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, flat_key: &str, region: &str, entry: PriceEntry) {
        self.prices.insert((flat_key.to_string(), region.to_string()), entry);
    }

    pub fn set_fx(&mut self, fx: FxStatus) {
        self.fx = Some(fx);
    }

    /// `None` = no cache row for this `(key, region)` yet (refresh pending / in progress).
    pub fn lookup(&self, flat_key: &str, region: &str) -> Option<PriceEntry> {
        self.prices
            .get(&(flat_key.to_string(), region.to_string()))
            .copied()
    }

    /// The FX status the scan should ship. Defaults to `Pending` if the book was built without
    /// an FX row (e.g. a hand-made test book).
    pub fn fx(&self) -> FxStatus {
        self.fx.unwrap_or(FxStatus {
            rate: 0.0,
            as_of: None,
            state: FxState::Pending,
        })
    }
}
