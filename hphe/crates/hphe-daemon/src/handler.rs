//! Request handler implementation for hphe-ipc server.
//!
//! Exposes verbs: ping, stats, search, resolve, watch.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use hphe_index::FileIndex;
use hphe_ipc::error::{IpcError, IpcResult};
use hphe_ipc::protocol::{
    ErrorCode, FileEntry, IndexStats, PingResponse, RequestId, ResolveResponse, ResultResponse,
    SearchParams, SearchResponse, VolumeStats, WatchParams, WatchResponse,
};
use hphe_ipc::server::RequestHandler;
use tracing::{debug, trace};

/// Request handler connecting the named pipe IPC server to the FileIndex.
#[derive(Clone)]
pub struct DaemonHandler {
    index: Arc<FileIndex>,
    start_time: Instant,
    last_usn: Arc<AtomicI64>,
    drive_char: char,
}

impl DaemonHandler {
    /// Creates a new DaemonHandler.
    pub fn new(index: Arc<FileIndex>, last_usn: Arc<AtomicI64>, drive_char: char) -> Self {
        Self {
            index,
            start_time: Instant::now(),
            last_usn,
            drive_char,
        }
    }

    /// Helper to project a row index into a protocol FileEntry.
    fn row_to_entry(&self, row: usize) -> FileEntry {
        let frn = self.index.frn(row);
        let parent_frn = self.index.parent_frn(row);
        let name = self.index.name(row).to_string();
        let path = self.index.resolve_path(row);
        let size = self.index.size(row);
        let is_dir = self.index.is_dir(row);
        let created = self.index.created(row);
        let modified = self.index.modified(row);
        let accessed = self.index.accessed(row);
        let attributes = self.index.raw_flags(row);

        FileEntry {
            row,
            frn,
            parent_frn,
            name,
            path,
            size,
            is_dir,
            created,
            modified,
            accessed,
            attributes,
        }
    }
}

#[async_trait]
impl RequestHandler for DaemonHandler {
    async fn handle_ping(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        let uptime_ms = self.start_time.elapsed().as_millis() as u64;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Ok(ResultResponse::Ping(PingResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_ms,
            timestamp,
        }))
    }

    async fn handle_stats(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        let st = self.index.stats();
        let current_usn = self.last_usn.load(Ordering::Relaxed);

        let mut volumes = HashMap::new();
        volumes.insert(
            self.drive_char,
            VolumeStats {
                entry_count: st.entry_count,
                file_count: st.file_count,
                dir_count: st.dir_count,
                total_size: st.total_size,
                last_usn: if current_usn >= 0 { current_usn as u64 } else { 0 },
                journal_id: 0,
                is_building: false,
                last_error: None,
            },
        );

        Ok(ResultResponse::Stats(IndexStats {
            total_entries: st.entry_count,
            file_count: st.file_count,
            dir_count: st.dir_count,
            total_size: st.total_size,
            memory_usage_bytes: st.memory_usage_bytes,
            build_time_ms: st.build_time_ms,
            avg_name_length: st.avg_name_length,
            volumes: Some(volumes),
        }))
    }

    async fn handle_search(
        &self,
        _request_id: RequestId,
        params: SearchParams,
    ) -> IpcResult<ResultResponse> {
        trace!("Handling search query: '{}', limit: {}, offset: {}", params.query, params.limit, params.offset);

        let query_str = params.query.trim();

        // 1. Evaluate matching rows: try Everything syntax query first, fallback to memchr substring scan
        let matching_rows: Vec<usize> = if query_str.is_empty() {
            (0..self.index.len()).collect()
        } else if let Ok(parsed) = hphe_query::parse(query_str) {
            match parsed.compile() {
                Ok(compiled) => compiled.evaluate(&self.index).collect(),
                Err(_) => self.index.find_rows(query_str),
            }
        } else {
            self.index.find_rows(query_str)
        };

        // 2. Filter deleted/inactive entries unless include_deleted is true
        let filtered_rows: Vec<usize> = if params.include_deleted {
            matching_rows
        } else {
            matching_rows
                .into_iter()
                .filter(|&row| self.index.is_row_active(row))
                .collect()
        };

        // 3. Merge overlay entries (USN-added files invisible to the column
        // scan). Fallback semantics: substring on the raw query string —
        // structured queries ("ext:rs") simply won't match overlay names.
        let overlay_entries = if query_str.is_empty() {
            self.index.overlay_matches("")
        } else {
            self.index.overlay_matches(&query_str.to_lowercase())
        };

        let total = filtered_rows.len() + overlay_entries.len();

        // 4. Paginate — cap la taille de réponse (un client peut demander
        // limit=usize::MAX et vider l'index entier en une frame NDJSON)
        const MAX_SEARCH_RESULTS: usize = 10_000;
        let limit = params.limit.clamp(1, MAX_SEARCH_RESULTS);
        let offset = params.offset;

        let mut entries: Vec<FileEntry> = filtered_rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|&row| self.row_to_entry(row))
            .collect();

        // Fill remaining page slots with overlay hits
        if entries.len() < limit {
            let overlay_skip = offset.saturating_sub(filtered_rows.len());
            for e in overlay_entries.iter().skip(overlay_skip).take(limit - entries.len()) {
                let dir = self.index.dir_path_of_frn(e.parent_frn);
                let path = if dir.ends_with('\\') {
                    format!("{}{}", dir, e.name)
                } else {
                    format!("{}\\{}", dir, e.name)
                };
                entries.push(FileEntry {
                    row: usize::MAX,
                    frn: e.frn,
                    parent_frn: e.parent_frn,
                    name: e.name.clone(),
                    path,
                    size: e.size,
                    is_dir: e.flags.is_dir,
                    created: e.created,
                    modified: e.modified,
                    accessed: e.accessed,
                    attributes: e.flags.to_u32(),
                });
            }
        }

        let has_more = total > offset + entries.len();

        Ok(ResultResponse::Search(SearchResponse {
            total,
            entries,
            has_more,
            offset,
            limit,
        }))
    }

    async fn handle_resolve(&self, _request_id: RequestId, row: usize) -> IpcResult<ResultResponse> {
        if row >= self.index.len() {
            return Err(IpcError::protocol(
                ErrorCode::NotFound,
                format!("Row index {} out of bounds (total rows: {})", row, self.index.len()),
            ));
        }

        let path = self.index.resolve_path(row);
        let frn = self.index.frn(row);

        Ok(ResultResponse::Resolve(ResolveResponse { path, row, frn }))
    }

    async fn handle_watch(&self, _request_id: RequestId, params: WatchParams) -> IpcResult<ResultResponse> {
        debug!("Watch parameters received: subscribe={}, volume={:?}", params.subscribe, params.volume);
        Ok(ResultResponse::Watch(WatchResponse {
            subscribed: params.subscribe,
            volume: params.volume,
        }))
    }
}
