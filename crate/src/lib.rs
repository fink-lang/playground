use std::collections::HashSet;
use wasm_bindgen::prelude::*;

use fink::ast::{self, Node, NodeKind};
use fink::lexer::{self, TokenKind};
use fink::parser;
use fink::passes::cps::ir::CpsId;
use fink::passes::cps::transform::lower_expr;
use fink::passes::name_res::{self, Resolution};

// Token type indices (must match TypeScript legend)
const TOKEN_FUNCTION: u32 = 0;
const TOKEN_VARIABLE: u32 = 1;
const TOKEN_PROPERTY: u32 = 2;
const TOKEN_BLOCK_NAME: u32 = 3;
const TOKEN_TAG_LEFT: u32 = 4;
const TOKEN_TAG_RIGHT: u32 = 5;

// Token modifier bits
const MOD_READONLY: u32 = 1; // bit 0

struct RawToken {
    line: u32,   // 0-based
    col: u32,    // 0-based
    length: u32,
    token_type: u32,
    modifiers: u32,
}

/// Resolve the callee of a function application.
/// Follows Member.rhs chain to find the actual callee node.
fn resolve_callee<'a>(node: &'a Node<'a>) -> &'a Node<'a> {
    match &node.kind {
        NodeKind::Member { rhs, .. } => resolve_callee(rhs),
        _ => node,
    }
}

fn emit_token(tokens: &mut Vec<RawToken>, node: &Node, token_type: u32, modifiers: u32) {
    let loc = &node.loc;
    // Rust parser uses 1-based lines, VSCode uses 0-based
    let line = loc.start.line.saturating_sub(1);
    let col = loc.start.col;
    let length = if loc.start.line == loc.end.line {
        loc.end.col - loc.start.col
    } else {
        // For multi-line tokens, just use the first line extent.
        // Identifiers are always single-line so this is a safety fallback.
        1
    };
    tokens.push(RawToken { line, col, length, token_type, modifiers });
}


fn collect_tokens<'src>(node: &'src Node<'src>, tokens: &mut Vec<RawToken>) {
    match &node.kind {
        NodeKind::Apply { func, args } => {
            let callee = resolve_callee(func);
            match &callee.kind {
                NodeKind::Ident(_) => {
                    // Tagged literal: callee adjacent to first arg
                    // Prefix: foo'bar' (callee end == arg start) → tag.left
                    // Postfix: 123foo (arg end == callee start) → tag.right
                    let tag_kind = args.items.first().and_then(|first_arg| {
                        if callee.loc.end.idx == first_arg.loc.start.idx {
                            Some(TOKEN_TAG_LEFT)
                        } else if first_arg.loc.end.idx == callee.loc.start.idx {
                            Some(TOKEN_TAG_RIGHT)
                        } else {
                            None
                        }
                    });
                    if let Some(tag_token) = tag_kind {
                        emit_token(tokens, callee, tag_token, 0);
                    } else {
                        emit_token(tokens, callee, TOKEN_FUNCTION, 0);
                    }
                }
                NodeKind::Group { .. } => {
                    // Emit function token at open and close paren positions
                    let loc = &callee.loc;
                    let open_line = loc.start.line.saturating_sub(1);
                    let close_line = loc.end.line.saturating_sub(1);
                    tokens.push(RawToken {
                        line: open_line,
                        col: loc.start.col,
                        length: 1,
                        token_type: TOKEN_FUNCTION,
                        modifiers: 0,
                    });
                    tokens.push(RawToken {
                        line: close_line,
                        col: loc.end.col.saturating_sub(1),
                        length: 1,
                        token_type: TOKEN_FUNCTION,
                        modifiers: 0,
                    });
                }
                _ => {}
            }
            // Recurse into func and args
            collect_tokens(func, tokens);
            for arg in &args.items {
                collect_tokens(arg, tokens);
            }
        }

        NodeKind::Pipe(children) => {
            for child in &children.items {
                if matches!(&child.kind, NodeKind::Ident(_)) {
                    emit_token(tokens, child, TOKEN_FUNCTION, 0);
                }
                collect_tokens(child, tokens);
            }
        }

        NodeKind::LitRec { items: children, .. } => {
            for child in &children.items {
                if let NodeKind::Arm { lhs, body, .. } = &child.kind {
                    if let Some(first_lhs) = lhs.items.first() {
                        if matches!(&first_lhs.kind, NodeKind::Ident(_)) {
                            if body.items.is_empty() {
                                emit_token(tokens, first_lhs, TOKEN_VARIABLE, MOD_READONLY);
                            } else {
                                emit_token(tokens, first_lhs, TOKEN_PROPERTY, 0);
                            }
                        }
                    }
                    // Recurse into arm body
                    for expr in body.items.iter() {
                        collect_tokens(expr, tokens);
                    }
                } else {
                    collect_tokens(child, tokens);
                }
            }
        }

        // --- recurse into all other container nodes ---

        NodeKind::LitSeq { items: children, .. }
        | NodeKind::Patterns(children) => {
            for child in &children.items {
                collect_tokens(child, tokens);
            }
        }

        NodeKind::StrTempl { children, .. }
        | NodeKind::StrRawTempl { children, .. } => {
            for child in children {
                collect_tokens(child, tokens);
            }
        }

        NodeKind::InfixOp { lhs, rhs, .. } => {
            collect_tokens(lhs, tokens);
            collect_tokens(rhs, tokens);
        }

        NodeKind::Bind { lhs, rhs, .. }
        | NodeKind::BindRight { lhs, rhs, .. }
        | NodeKind::Member { lhs, rhs, .. } => {
            collect_tokens(lhs, tokens);
            collect_tokens(rhs, tokens);
        }

        NodeKind::UnaryOp { operand, .. } => {
            collect_tokens(operand, tokens);
        }

        NodeKind::Group { inner, .. }
        | NodeKind::Try(inner)
        | NodeKind::Yield(inner) => {
            collect_tokens(inner, tokens);
        }

        NodeKind::Spread { inner: Some(inner), .. } => {
            collect_tokens(inner, tokens);
        }

        NodeKind::Fn { params, body, .. } => {
            collect_tokens(params, tokens);
            for expr in &body.items {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::Match { subjects, arms, .. } => {
            collect_tokens(subjects, tokens);
            for arm in &arms.items {
                collect_tokens(arm, tokens);
            }
        }

        NodeKind::Arm { lhs, body, .. } => {
            // Arms not inside LitRec — just recurse
            for expr in &lhs.items {
                collect_tokens(expr, tokens);
            }
            for expr in &body.items {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::Block { name, params, body, .. } => {
            // Emit namespace token for the block name
            if matches!(&name.kind, NodeKind::Ident(_)) {
                emit_token(tokens, name, TOKEN_BLOCK_NAME, 0);
            }
            collect_tokens(name, tokens);
            collect_tokens(params, tokens);
            for expr in &body.items {
                collect_tokens(expr, tokens);
            }
        }

        NodeKind::ChainedCmp(parts) => {
            for part in parts {
                if let fink::ast::CmpPart::Operand(node) = part {
                    collect_tokens(node, tokens);
                }
            }
        }

        // Leaf nodes — no children to recurse into
        NodeKind::Ident(_)
        | NodeKind::LitBool(_)
        | NodeKind::LitInt(_)
        | NodeKind::LitFloat(_)
        | NodeKind::LitDecimal(_)
        | NodeKind::LitStr { .. }
        | NodeKind::Partial
        | NodeKind::Wildcard
        | NodeKind::Spread { inner: None, .. } => {}
    }
}

fn delta_encode(mut tokens: Vec<RawToken>) -> Vec<u32> {
    tokens.sort_by(|a, b| a.line.cmp(&b.line).then(a.col.cmp(&b.col)));

    let mut result = Vec::with_capacity(tokens.len() * 5);
    let mut prev_line: u32 = 0;
    let mut prev_col: u32 = 0;

    for token in &tokens {
        let delta_line = token.line - prev_line;
        let delta_col = if delta_line > 0 { token.col } else { token.col - prev_col };

        result.push(delta_line);
        result.push(delta_col);
        result.push(token.length);
        result.push(token.token_type);
        result.push(token.modifiers);

        prev_line = token.line;
        prev_col = token.col;
    }

    result
}

/// Extract the bind CpsId from a Resolution variant.
fn resolution_bind_id(res: &Option<Resolution>) -> Option<CpsId> {
    match res {
        Some(Resolution::Local(id))
        | Some(Resolution::Captured { bind: id, .. })
        | Some(Resolution::Recursive(id)) => Some(*id),
        _ => None,
    }
}

// --- Pre-computed location data for cursor lookups ---

/// 0-based source location, owned (no borrows).
#[derive(Clone, Copy)]
struct Loc {
    line: u32,
    col: u32,
    end_line: u32,
    end_col: u32,
}

/// An identifier node mapped to its CPS node, for cursor hit-testing.
/// Sorted by (line, col) for binary search.
struct IdentEntry {
    loc: Loc,
    cps_idx: u32,
}

/// Stateful parsed document - parse once, query many times.
/// Stores only owned data: no borrows, no lifetimes.
#[wasm_bindgen]
pub struct ParsedDocument {
    /// Delta-encoded semantic tokens, ready to return to VS Code.
    semantic_tokens: Vec<u32>,

    /// JSON diagnostics string, ready to return to VS Code.
    diagnostics: String,

    /// Source location for each CPS node (indexed by CpsId.0).
    /// None if the CPS node has no AST origin or origin has no location.
    node_locs: Vec<Option<Loc>>,

    /// For each CPS node, the binding CpsId it resolves to.
    /// If the node IS a binding site, points to itself.
    /// None if unresolved or not an identifier.
    bind_ids: Vec<Option<u32>>,

    /// Identifier nodes sorted by position, for cursor hit-testing.
    idents: Vec<IdentEntry>,
}

#[wasm_bindgen]
impl ParsedDocument {
    /// Parse source code and pre-compute all provider data.
    #[wasm_bindgen(constructor)]
    pub fn new(src: &str) -> ParsedDocument {
        // --- Lexer diagnostics ---
        let mut diag_entries: Vec<String> = Vec::new();
        let lexer = lexer::tokenize_with_seps(src, &[
            b"+", b"-", b"*", b"/", b"//", b"**", b"%", b"%%", b"/%",
            b"==", b"!=", b"<", b"<=", b">", b">=", b"><",
            b"&", b"^", b"~", b">>", b"<<", b">>>", b"<<<",
            b".", b"|", b"|=", b"=", b"..", b"...",
        ]);
        for tok in lexer {
            if tok.kind == TokenKind::Err {
                let line = tok.loc.start.line.saturating_sub(1);
                let col = tok.loc.start.col;
                let end_line = tok.loc.end.line.saturating_sub(1);
                let end_col = tok.loc.end.col;
                let msg = tok.src.replace('\\', "\\\\").replace('"', "\\\"");
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"lexer","severity":"error"}}"#
                ));
            }
        }

        // --- Parse ---
        let parse_result = match parser::parse(src) {
            Ok(r) => r,
            Err(e) => {
                // Parser failed — return diagnostics only, empty provider data
                let line = e.loc.start.line.saturating_sub(1);
                let col = e.loc.start.col;
                let end_line = e.loc.end.line.saturating_sub(1);
                let end_col = e.loc.end.col;
                let msg = e.message.replace('\\', "\\\\").replace('"', "\\\"");
                diag_entries.push(format!(
                    r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"{msg}","source":"parser","severity":"error"}}"#
                ));
                return ParsedDocument {
                    semantic_tokens: vec![],
                    diagnostics: format!("[{}]", diag_entries.join(",")),
                    node_locs: vec![],
                    bind_ids: vec![],
                    idents: vec![],
                };
            }
        };

        // --- Semantic tokens ---
        let mut raw_tokens = Vec::new();
        collect_tokens(&parse_result.root, &mut raw_tokens);
        let semantic_tokens = delta_encode(raw_tokens);

        // --- Name resolution ---
        let ast_index = ast::build_index(&parse_result);
        let cps = lower_expr(&parse_result.root);
        let node_count = cps.origin.len();
        let resolved = name_res::resolve(&cps.root, &cps.origin, &ast_index, node_count);

        // --- Build owned lookup tables ---
        let mut node_locs: Vec<Option<Loc>> = Vec::with_capacity(node_count);
        let mut bind_ids: Vec<Option<u32>> = Vec::with_capacity(node_count);
        let mut idents: Vec<IdentEntry> = Vec::new();

        // For unused-binding diagnostics: track all bind sites and all referenced binds.
        // Module-level bindings (scope == root) are exports — skip unused warning for those.
        let root_scope_id = cps.root.id;
        let mut bind_sites: Vec<u32> = Vec::new();
        let mut used_binds: HashSet<u32> = HashSet::new();

        for i in 0..node_count {
            let cps_id = CpsId(i as u32);

            // Map CPS node → source location
            let loc = cps.origin.get(cps_id)
                .and_then(|ast_id| *ast_index.get(ast_id))
                .map(|node| Loc {
                    line: node.loc.start.line.saturating_sub(1),
                    col: node.loc.start.col,
                    end_line: node.loc.end.line.saturating_sub(1),
                    end_col: node.loc.end.col,
                });
            node_locs.push(loc);

            // Map CPS node → its binding CpsId
            let bind_id = if let Some(id) = resolution_bind_id(resolved.resolution.get(cps_id)) {
                // This is a reference — resolves to a binding
                used_binds.insert(id.0);
                Some(id.0)
            } else if resolved.bind_scope.get(cps_id).is_some() {
                // This IS a binding site — points to itself
                bind_sites.push(i as u32);
                Some(i as u32)
            } else {
                None
            };
            bind_ids.push(bind_id);

            // Build ident index for cursor hit-testing
            if let Some(loc) = loc {
                if let Some(ast_id) = *cps.origin.get(cps_id) {
                    if let Some(node) = *ast_index.get(ast_id) {
                        if matches!(&node.kind, NodeKind::Ident(_)) {
                            idents.push(IdentEntry { loc, cps_idx: i as u32 });
                        }
                    }
                }
            }

            // Name resolution diagnostics — unresolved names as warnings
            if let Some(Resolution::Unresolved) = resolved.resolution.get(cps_id) {
                if let Some(ast_id) = *cps.origin.get(cps_id) {
                    if let Some(node) = *ast_index.get(ast_id) {
                        let line = node.loc.start.line.saturating_sub(1);
                        let col = node.loc.start.col;
                        let end_line = node.loc.end.line.saturating_sub(1);
                        let end_col = node.loc.end.col;
                        let name = match &node.kind {
                            NodeKind::Ident(s) => s.replace('\\', "\\\\").replace('"', "\\\""),
                            _ => "?".to_string(),
                        };
                        diag_entries.push(format!(
                            r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unresolved name '{name}'","source":"name_res","severity":"error"}}"#
                        ));
                    }
                }
            }
        }

        // Unused-binding diagnostics — warn on bind sites with no references.
        // Skip module-level bindings (they are exports).
        for bind_idx in bind_sites {
            if used_binds.contains(&bind_idx) { continue; }
            let cps_id = CpsId(bind_idx);
            if resolved.bind_scope.get(cps_id) == &Some(root_scope_id) { continue; }
            if let Some(ast_id) = *cps.origin.get(cps_id) {
                if let Some(node) = *ast_index.get(ast_id) {
                    let line = node.loc.start.line.saturating_sub(1);
                    let col = node.loc.start.col;
                    let end_line = node.loc.end.line.saturating_sub(1);
                    let end_col = node.loc.end.col;
                    let name = match &node.kind {
                        NodeKind::Ident(s) => s.replace('\\', "\\\\").replace('"', "\\\""),
                        _ => "?".to_string(),
                    };
                    diag_entries.push(format!(
                        r#"{{"line":{line},"col":{col},"endLine":{end_line},"endCol":{end_col},"message":"unused binding '{name}'","source":"name_res","severity":"warning"}}"#
                    ));
                }
            }
        }

        // Sort idents by position for binary search
        idents.sort_by(|a, b| a.loc.line.cmp(&b.loc.line).then(a.loc.col.cmp(&b.loc.col)));

        ParsedDocument {
            semantic_tokens,
            diagnostics: format!("[{}]", diag_entries.join(",")),
            node_locs,
            bind_ids,
            idents,
        }
    }

    /// Return delta-encoded semantic tokens.
    pub fn get_semantic_tokens(&self) -> Vec<u32> {
        self.semantic_tokens.clone()
    }

    /// Return JSON diagnostics string.
    pub fn get_diagnostics(&self) -> String {
        self.diagnostics.clone()
    }

    /// Look up the definition site for the identifier at (line, col).
    /// Returns [def_line, def_col, def_end_line, def_end_col] or empty.
    pub fn get_definition(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_idx) = self.find_bind_at(line, col) else { return vec![] };
        let Some(loc) = self.node_locs[bind_idx as usize] else { return vec![] };
        vec![loc.line, loc.col, loc.end_line, loc.end_col]
    }

    /// Find all references to the identifier at (line, col), including the binding site.
    /// Returns [line, col, end_line, end_col, ...] (4 u32s per location) or empty.
    /// First entry is always the binding site.
    pub fn get_references(&self, line: u32, col: u32) -> Vec<u32> {
        let Some(bind_idx) = self.find_bind_at(line, col) else { return vec![] };

        let mut locs = Vec::new();

        // Binding site first
        if let Some(loc) = self.node_locs[bind_idx as usize] {
            locs.push(loc.line);
            locs.push(loc.col);
            locs.push(loc.end_line);
            locs.push(loc.end_col);
        }

        // All references that resolve to this binding
        for (i, bind_id) in self.bind_ids.iter().enumerate() {
            if let Some(id) = bind_id {
                if *id == bind_idx && i as u32 != bind_idx {
                    if let Some(loc) = self.node_locs[i] {
                        locs.push(loc.line);
                        locs.push(loc.col);
                        locs.push(loc.end_line);
                        locs.push(loc.end_col);
                    }
                }
            }
        }

        locs
    }
}

impl ParsedDocument {
    /// Find the binding CpsId for the identifier at (line, col).
    /// Returns None if no identifier found or it doesn't resolve.
    fn find_bind_at(&self, line: u32, col: u32) -> Option<u32> {
        // Linear scan through idents (typically small, sorted by position)
        for entry in &self.idents {
            if entry.loc.line == line && entry.loc.col <= col && col < entry.loc.end_col {
                return self.bind_ids[entry.cps_idx as usize];
            }
        }
        None
    }
}
