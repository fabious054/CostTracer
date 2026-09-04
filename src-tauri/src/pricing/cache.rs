//! `pricing-cache.sqlite3` — a store **separate** from the scan DB (ADR 0006 D4). Prices are
//! public, account-independent data; keeping them in their own file means no query ever mixes
//! account-scoped and account-independent rows, so the cross-account-leak class can't reopen here.
//!
//! Two tables. `price_json` / `rate` NULL is a **failure marker**: the refresher tried the source
//! and got nothing. A missing row means the refresher hasn't reached that entry yet.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;
use crate::model::{FxState, FxStatus};
use crate::pricing::pricebook::{PriceBook, PriceEntry};
use crate::pricing::{ProductKey, FAILED_RETRY_SECS, FX_PAIR, FX_WINDOW_SECS, PRICE_WINDOW_SECS};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS price_cache (
  service         TEXT NOT NULL,
  product_key     TEXT NOT NULL,
  region          TEXT NOT NULL,
  price_json      TEXT,            -- raw GetProducts item; NULL = failure marker
  usd_per_unit    REAL,            -- parsed rate; NULL iff price_json NULL
  fetched_at      INTEGER,         -- unix secs of the successful fetch; NULL iff failure marker
  last_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (service, product_key, region)
);
CREATE TABLE IF NOT EXISTS fx_cache (
  pair            TEXT PRIMARY KEY,
  rate            REAL,            -- NULL = failure marker
  fetched_at      INTEGER,
  last_attempt_at INTEGER NOT NULL
);
"#;

/// What the refresher needs to know about one entry to decide whether to (re)fetch it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheState {
    /// Value present, within its window — leave it.
    Fresh,
    /// Value present but past its window — refetch (keep the old value if the refetch fails).
    Stale,
    /// No row, or a failure marker whose `last_attempt_at` is itself past the window — (re)fetch.
    Missing,
    /// A failure marker attempted within the window — don't hammer the source this cycle.
    FailedRecent,
}

pub struct PriceCache {
    conn: Mutex<Connection>,
}

impl PriceCache {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // Two app instances share this file; let SQLite serialise writers rather than error.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("pricing-cache mutex poisoned")
    }

    // --- refresher side ---------------------------------------------------

    pub fn classify_price(&self, key: &ProductKey, region: &str, now: i64) -> AppResult<CacheState> {
        let row: Option<(Option<i64>, i64)> = self
            .lock()
            .query_row(
                "SELECT fetched_at, last_attempt_at FROM price_cache
                 WHERE service = ?1 AND product_key = ?2 AND region = ?3",
                params![key.service, key.key, region],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(classify(row, now, PRICE_WINDOW_SECS))
    }

    pub fn put_price(
        &self,
        key: &ProductKey,
        region: &str,
        raw_json: Option<&str>,
        usd_per_unit: Option<f64>,
        now: i64,
    ) -> AppResult<()> {
        let fetched_at = raw_json.map(|_| now);
        self.lock().execute(
            "INSERT INTO price_cache
               (service, product_key, region, price_json, usd_per_unit, fetched_at, last_attempt_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (service, product_key, region) DO UPDATE SET
               price_json      = COALESCE(excluded.price_json, price_cache.price_json),
               usd_per_unit    = COALESCE(excluded.usd_per_unit, price_cache.usd_per_unit),
               fetched_at      = COALESCE(excluded.fetched_at, price_cache.fetched_at),
               last_attempt_at = excluded.last_attempt_at",
            params![key.service, key.key, region, raw_json, usd_per_unit, fetched_at, now],
        )?;
        Ok(())
    }

    pub fn classify_fx(&self, now: i64) -> AppResult<CacheState> {
        let row: Option<(Option<i64>, i64)> = self
            .lock()
            .query_row(
                "SELECT fetched_at, last_attempt_at FROM fx_cache WHERE pair = ?1",
                params![FX_PAIR],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(classify(row, now, FX_WINDOW_SECS))
    }

    pub fn put_fx(&self, rate: Option<f64>, now: i64) -> AppResult<()> {
        let fetched_at = rate.map(|_| now);
        self.lock().execute(
            "INSERT INTO fx_cache (pair, rate, fetched_at, last_attempt_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (pair) DO UPDATE SET
               rate            = COALESCE(excluded.rate, fx_cache.rate),
               fetched_at      = COALESCE(excluded.fetched_at, fx_cache.fetched_at),
               last_attempt_at = excluded.last_attempt_at",
            params![FX_PAIR, rate, fetched_at, now],
        )?;
        Ok(())
    }

    // --- scan side ------------------------------------------------------------

    /// Build the read snapshot for exactly the `(product key, region)` pairs the scan will price.
    pub fn load_book(&self, needs: &[(ProductKey, String)], now: i64) -> AppResult<PriceBook> {
        let conn = self.lock();
        let mut book = PriceBook::new();
        let mut stmt = conn.prepare(
            "SELECT usd_per_unit, fetched_at FROM price_cache
             WHERE service = ?1 AND product_key = ?2 AND region = ?3",
        )?;
        for (key, region) in needs {
            let row: Option<(Option<f64>, Option<i64>)> = stmt
                .query_row(params![key.service, key.key, region], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            match row {
                Some((Some(rate), fetched_at)) => {
                    let stale = fetched_at.map(|t| now - t > PRICE_WINDOW_SECS).unwrap_or(false);
                    book.insert(
                        &key.key,
                        region,
                        PriceEntry::Priced {
                            usd_per_unit: rate,
                            priced_at: if stale { fetched_at } else { None },
                        },
                    );
                }
                Some((None, _)) => book.insert(&key.key, region, PriceEntry::Failed),
                None => {} // absent — estimate() reads this as PricePending
            }
        }
        drop(stmt);
        book.set_fx(load_fx(&conn, now)?);
        Ok(book)
    }
}

fn load_fx(conn: &Connection, now: i64) -> AppResult<FxStatus> {
    let row: Option<(Option<f64>, Option<i64>)> = conn
        .query_row(
            "SELECT rate, fetched_at FROM fx_cache WHERE pair = ?1",
            params![FX_PAIR],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        Some((Some(rate), fetched_at)) => {
            let stale = fetched_at.map(|t| now - t > FX_WINDOW_SECS).unwrap_or(true);
            // `as_of` always carries the real fetch time — the UI shows it as provenance for the
            // rate ("obtained at …"), not only as a staleness flag. `state` is the flag.
            FxStatus {
                rate,
                as_of: fetched_at,
                state: if stale { FxState::Stale } else { FxState::Fresh },
            }
        }
        Some((None, _)) => FxStatus { rate: 0.0, as_of: None, state: FxState::Unavailable },
        None => FxStatus { rate: 0.0, as_of: None, state: FxState::Pending },
    })
}

fn classify(row: Option<(Option<i64>, i64)>, now: i64, window: i64) -> CacheState {
    match row {
        None => CacheState::Missing,
        Some((Some(fetched_at), _)) => {
            if now - fetched_at <= window {
                CacheState::Fresh
            } else {
                CacheState::Stale
            }
        }
        // failure marker: retry once its own attempt has aged past the (short) retry window,
        // not the full price/FX window — a transient throttle mustn't hide a price for days.
        Some((None, last_attempt_at)) => {
            if now - last_attempt_at <= FAILED_RETRY_SECS {
                CacheState::FailedRecent
            } else {
                CacheState::Missing
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> ProductKey {
        ProductKey { service: "AmazonEC2", key: "ebs:gp3".into() }
    }

    #[test]
    fn fresh_stale_missing_failed_classification() {
        let c = PriceCache::in_memory().unwrap();
        let now = 1_000_000;

        assert_eq!(c.classify_price(&key(), "us-east-1", now).unwrap(), CacheState::Missing);

        c.put_price(&key(), "us-east-1", Some("{}"), Some(0.08), now).unwrap();
        assert_eq!(c.classify_price(&key(), "us-east-1", now + 3600).unwrap(), CacheState::Fresh);
        assert_eq!(
            c.classify_price(&key(), "us-east-1", now + PRICE_WINDOW_SECS + 1).unwrap(),
            CacheState::Stale
        );

        // failure marker (raw None) keeps the previous value via COALESCE, so still Fresh here —
        // exercise a genuinely first-time failure on a different region.
        c.put_price(&key(), "eu-west-1", None, None, now).unwrap();
        assert_eq!(c.classify_price(&key(), "eu-west-1", now + 60).unwrap(), CacheState::FailedRecent);
        // a failure marker becomes retryable after the short retry window, not the price window.
        assert_eq!(
            c.classify_price(&key(), "eu-west-1", now + FAILED_RETRY_SECS + 1).unwrap(),
            CacheState::Missing
        );
    }

    #[test]
    fn load_book_reflects_fresh_stale_failed_absent() {
        let c = PriceCache::in_memory().unwrap();
        let now = 2_000_000;
        c.put_price(&key(), "us-east-1", Some("{}"), Some(0.08), now).unwrap();
        c.put_price(&key(), "us-west-2", Some("{}"), Some(0.08), now - PRICE_WINDOW_SECS - 10).unwrap();
        c.put_price(&key(), "eu-west-1", None, None, now).unwrap();

        let needs = vec![
            (key(), "us-east-1".to_string()),
            (key(), "us-west-2".to_string()),
            (key(), "eu-west-1".to_string()),
            (key(), "ap-south-1".to_string()),
        ];
        let book = c.load_book(&needs, now).unwrap();
        assert_eq!(
            book.lookup("ebs:gp3", "us-east-1"),
            Some(PriceEntry::Priced { usd_per_unit: 0.08, priced_at: None })
        );
        assert!(matches!(
            book.lookup("ebs:gp3", "us-west-2"),
            Some(PriceEntry::Priced { priced_at: Some(_), .. })
        ));
        assert_eq!(book.lookup("ebs:gp3", "eu-west-1"), Some(PriceEntry::Failed));
        assert_eq!(book.lookup("ebs:gp3", "ap-south-1"), None);
    }

    #[test]
    fn fx_states() {
        let c = PriceCache::in_memory().unwrap();
        let now = 3_000_000;
        assert_eq!(c.load_book(&[], now).unwrap().fx().state, FxState::Pending);
        c.put_fx(Some(5.4), now).unwrap();
        let fresh = c.load_book(&[], now + 60).unwrap();
        assert_eq!(fresh.fx().state, FxState::Fresh);
        assert_eq!(fresh.fx().as_of, Some(now)); // provenance timestamp is kept even when fresh
        let stale = c.load_book(&[], now + FX_WINDOW_SECS + 1).unwrap();
        assert_eq!(stale.fx().state, FxState::Stale);
        assert_eq!(stale.fx().as_of, Some(now));
    }
}
