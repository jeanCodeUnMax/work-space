//! Tantivy schema for the content index.
//!
//! One document == one indexable file. Fields are chosen so that both BM25
//! content search and metadata filtering (path / extension / size / date) are
//! possible in a single query, matching the SPEC-MOTEUR §"index contenu".
//!
//! | Field        | Type   | Options                                   | Purpose                                   |
//! |--------------|--------|-------------------------------------------|-------------------------------------------|
//! | `path`       | string | INDEXED + STORED (+ FAST)                 | full Windows path, exact match / display  |
//! | `file_id`    | u64    | INDEXED + STORED + FAST                   | FRN (NTFS file reference number)          |
//! | `mtime`      | date   | INDEXED + STORED + FAST                   | modification time (FILETIME → DateTime)   |
//! | `ext`        | string | INDEXED + STORED + FAST                   | extension without dot, e.g. "rs"          |
//! | `size`       | u64    | INDEXED + STORED + FAST                   | file size in bytes                        |
//! | `content`    | text   | INDEXED (freqs+positions) + STORED        | BM25 body + snippet positions             |
//! | `project_tag`| string | INDEXED + STORED + FAST                   | optional project/workspace tag            |
//!
//! `file_id` is the unique document key: an update is a `delete_term(file_id)`
//! followed by an `add_document`, a delete is just the `delete_term`.

use tantivy::schema::{
    IndexRecordOption, Schema, SchemaBuilder, TextFieldIndexing, TextOptions,
};

/// Field handles returned by [`build_schema`].
#[derive(Debug, Clone)]
pub struct ContentSchema {
    pub schema: Schema,
    pub path: tantivy::schema::Field,
    pub file_id: tantivy::schema::Field,
    pub mtime: tantivy::schema::Field,
    pub ext: tantivy::schema::Field,
    pub size: tantivy::schema::Field,
    pub content: tantivy::schema::Field,
    pub project_tag: tantivy::schema::Field,
}

impl ContentSchema {
    /// Builds the canonical content schema.
    ///
    /// `content` is indexed with freqs + positions so that `SnippetGenerator`
    /// can highlight matches. `path`, `ext`, `project_tag` are indexed as
    /// untokenized STRINGs (exact term match), and all metadata fields are also
    /// FAST (Lucene "doc values") so they can be retrieved / sorted cheaply.
    pub fn build() -> Self {
        let mut b = SchemaBuilder::new();

        let path = b.add_text_field("path", tantivy::schema::STRING | tantivy::schema::STORED | tantivy::schema::FAST);

        let file_id = b.add_u64_field(
            "file_id",
            tantivy::schema::INDEXED | tantivy::schema::STORED | tantivy::schema::FAST,
        );

        let mtime = b.add_date_field(
            "mtime",
            tantivy::schema::INDEXED | tantivy::schema::STORED | tantivy::schema::FAST,
        );

        let ext = b.add_text_field("ext", tantivy::schema::STRING | tantivy::schema::STORED | tantivy::schema::FAST);

        let size = b.add_u64_field(
            "size",
            tantivy::schema::INDEXED | tantivy::schema::STORED | tantivy::schema::FAST,
        );

        // content: BM25 body. Freqs+positions required for snippets.
        let text_indexing = TextFieldIndexing::default()
            .set_tokenizer("default")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions);
        let content_opts = TextOptions::default()
            .set_indexing_options(text_indexing)
            .set_stored();
        let content = b.add_text_field("content", content_opts);

        let project_tag =
            b.add_text_field("project_tag", tantivy::schema::STRING | tantivy::schema::STORED | tantivy::schema::FAST);

        Self {
            schema: b.build(),
            path,
            file_id,
            mtime,
            ext,
            size,
            content,
            project_tag,
        }
    }

    /// Field that acts as the unique document key (`file_id` / FRN).
    pub fn key_field(&self) -> tantivy::schema::Field {
        self.file_id
    }
}

/// Helper: build a tantivy `Term` for a `file_id` (FRN).
pub fn file_id_term(field: tantivy::schema::Field, file_id: u64) -> tantivy::schema::Term {
    tantivy::schema::Term::from_field_u64(field, file_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_expected_fields() {
        let s = ContentSchema::build();
        // All seven fields present and distinct.
        let fields = [s.path, s.file_id, s.mtime, s.ext, s.size, s.content, s.project_tag];
        for f in fields {
            assert!(s.schema.get_field_entry(f).name().len() > 0);
        }
        // content is a text field (searchable BM25 body)
        assert!(matches!(
            s.schema.get_field_entry(s.content).field_type(),
            tantivy::schema::FieldType::Str(_)
        ));
        // file_id is a u64 field (unique key)
        assert!(matches!(
            s.schema.get_field_entry(s.file_id).field_type(),
            tantivy::schema::FieldType::U64(_)
        ));
    }

    #[test]
    fn file_id_term_targets_right_field() {
        let s = ContentSchema::build();
        let term = file_id_term(s.file_id, 123_456);
        // The term is bound to the file_id field.
        assert_eq!(term.field(), s.file_id);
        // A different field yields a different term.
        let other = file_id_term(s.size, 123_456);
        assert_ne!(term, other);
    }
}
