use std::{collections::HashMap, iter, ops::Range};

use arborium::tree_sitter::{Node, Query, QueryCursor, TextProvider, Tree};
use languages;
use rangemap::RangeMap;
use streaming_iterator::StreamingIterator;
use string_offset::{ByteOffset, CharOffset};
use warp_editor::content::{
    buffer::{Buffer, ToBufferByteOffset, ToBufferCharOffset},
    text::Bytes,
};
use warpui::color::ColorU;

/// Color mapping from parsed syntax token name to its corresponding highlighting color.
#[derive(Clone, Copy)]
pub struct ColorMap {
    pub keyword_color: ColorU,
    pub function_color: ColorU,
    pub string_color: ColorU,
    pub type_color: ColorU,
    pub number_color: ColorU,
    pub comment_color: ColorU,
    pub property_color: ColorU,
    pub tag_color: ColorU,
}

/// Query for retrieving syntax highlighting information on the tokens.
pub struct HighlightQuery {
    highlight_map: Vec<Option<ColorU>>,
}

impl HighlightQuery {
    pub fn new(query: &Query, color_map: ColorMap) -> Self {
        let highlight_map = query
            .capture_names()
            .iter()
            .map(|name| convert_capture_name_to_color(name, &color_map))
            .collect();

        Self { highlight_map }
    }

    /// Given the a character range, return its corresponding highlight colors.
    pub fn get_highlighted_chunks(
        &self,
        range: Range<CharOffset>,
        query: &Query,
        buffer: &Buffer,
        tree: &Tree,
    ) -> RangeMap<CharOffset, ColorU> {
        let mut range_map = RangeMap::new();

        let mut cursor = QueryCursor::new();
        let byte_start = range.start.to_buffer_byte_offset(buffer).as_usize();
        let byte_end = range.end.to_buffer_byte_offset(buffer).as_usize();
        cursor.set_byte_range(byte_start..byte_end);
        let mut captures = cursor.captures(query, tree.root_node(), TextBuffer(buffer));

        while let Some(matches) = captures.next() {
            for cap in matches.0.captures {
                let insertion_range = cap.node.byte_range();
                let color = self
                    .highlight_map
                    .get(cap.index as usize)
                    .and_then(|inner| *inner);

                if let Some(color) = color {
                    let char_start =
                        ByteOffset::from(insertion_range.start).to_buffer_char_offset(buffer);
                    let char_end =
                        ByteOffset::from(insertion_range.end).to_buffer_char_offset(buffer);
                    if char_start < char_end {
                        range_map.insert(char_start..char_end, color);
                    }
                }
            }
        }

        range_map
    }

    /// Process language injections and return highlights for injected regions.
    /// This handles embedded languages like JavaScript/CSS in Vue files.
    pub fn get_injection_highlights(
        &self,
        range: Range<CharOffset>,
        injections_query: &Query,
        injection_highlight_queries: &HashMap<String, HighlightQuery>,
        buffer: &Buffer,
        tree: &Tree,
    ) -> RangeMap<CharOffset, ColorU> {
        let mut range_map = RangeMap::new();

        let mut cursor = QueryCursor::new();
        let byte_start = range.start.to_buffer_byte_offset(buffer).as_usize();
        let byte_end = range.end.to_buffer_byte_offset(buffer).as_usize();
        cursor.set_byte_range(byte_start..byte_end);

        let mut captures = cursor.captures(injections_query, tree.root_node(), TextBuffer(buffer));

        while let Some(matches) = captures.next() {
            let match_ = &matches.0;

            // Find the language and content from the injection match
            let mut lang_name: Option<String> = None;
            let mut content_node: Option<Node> = None;

            for cap in match_.captures {
                let capture_name = injections_query.capture_names()[cap.index as usize];
                match capture_name {
                    "injection.language" => {
                        // This is set by #set! directive in the query
                        // We'll try to read it from the node if it exists
                        let node_bytes = buffer.bytes_in_range(
                            ByteOffset::from(cap.node.start_byte()),
                            ByteOffset::from(cap.node.end_byte()),
                        );
                        let bytes: Vec<u8> = node_bytes.collect();
                        if let Ok(s) = std::str::from_utf8(&bytes) {
                            if !s.is_empty() {
                                lang_name = Some(s.to_string());
                            }
                        }
                    }
                    "injection.content" => {
                        content_node = Some(cap.node);
                    }
                    _ => {
                        // Check if this capture contains the language name
                        // (from attribute values like lang="ts")
                        if capture_name.starts_with("@_") {
                            // This is a predicate capture, not content
                            let node_bytes = buffer.bytes_in_range(
                                ByteOffset::from(cap.node.start_byte()),
                                ByteOffset::from(cap.node.end_byte()),
                            );
                            let bytes: Vec<u8> = node_bytes.collect();
                            if let Ok(s) = std::str::from_utf8(&bytes) {
                                if !s.is_empty() {
                                    lang_name = Some(s.to_string());
                                }
                            }
                        }
                    }
                }
            }

            if let Some(node) = content_node {
                // Determine the language
                let lang = lang_name.unwrap_or_else(|| {
                    // Default to javascript for Vue script elements
                    "javascript".to_string()
                });

                // Normalize language name
                let normalized_lang = match lang.as_str() {
                    "js" | "jsx" => "javascript",
                    "ts" | "tsx" => "typescript",
                    "scss" | "less" | "postcss" => "css",
                    other => other,
                };

                if let Some(injection_highlight) =
                    injection_highlight_queries.get(normalized_lang)
                {
                    // Get the language's highlight query for the injection
                    if let Some(lang_obj) = languages::language_by_name(normalized_lang) {
                        let content_range = node.byte_range();
                        let content_char_start =
                            ByteOffset::from(content_range.start).to_buffer_char_offset(buffer);
                        let content_char_end =
                            ByteOffset::from(content_range.end).to_buffer_char_offset(buffer);

                        let highlights = injection_highlight.get_highlighted_chunks(
                            content_char_start..content_char_end,
                            &lang_obj.highlight_query,
                            buffer,
                            tree,
                        );

                        for (highlight_range, color) in highlights.iter() {
                            range_map.insert(highlight_range.clone(), *color);
                        }
                    }
                }
            }
        }

        range_map
    }
}

fn convert_capture_name_to_color(name: &str, color_map: &ColorMap) -> Option<ColorU> {
    match name.split('.').next() {
        Some("keyword") => Some(color_map.keyword_color),
        Some("function") => Some(color_map.function_color),
        Some("string") => Some(color_map.string_color),
        Some("type") => Some(color_map.type_color),
        Some("number") => Some(color_map.number_color),
        Some("comment") => Some(color_map.comment_color),
        Some("property") => Some(color_map.property_color),
        Some("tag") => Some(color_map.tag_color),
        _ => None,
    }
}

// The default tree-sitter implementation here is unsafe (since the cursor could query invalid ranges outside of content length).
// TODO(kevin): Once we migrate buffer to store ArrayStrings. We should implement the chunks API on buffer directly to avoid collecting
// into a String and then chunking them again for highlighting.
pub struct TextSlice<'a>(pub &'a [u8]);

impl TextSlice<'_> {
    fn get(&self, range: Range<usize>) -> Self {
        Self(self.0.get(range).unwrap_or_default())
    }
}

impl AsRef<[u8]> for TextSlice<'_> {
    fn as_ref(&self) -> &[u8] {
        self.0
    }
}

impl<'a> TextProvider<TextSlice<'a>> for TextSlice<'a> {
    type I = iter::Once<TextSlice<'a>>;

    fn text(&mut self, node: Node) -> Self::I {
        iter::once(self.get(node.byte_range()))
    }
}

pub struct TextBuffer<'a>(pub &'a Buffer);

impl<'a> TextProvider<&'a [u8]> for TextBuffer<'a> {
    type I = Bytes<'a>;

    fn text(&mut self, node: Node) -> Self::I {
        let range = node.range();
        self.0.bytes_in_range(
            ByteOffset::from(range.start_byte),
            ByteOffset::from(range.end_byte),
        )
    }
}
