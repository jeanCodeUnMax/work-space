//! Error types for the query engine.

use thiserror::Error;

/// Query parsing errors.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ParseError {
    /// Unexpected end of input
    #[error("Unexpected end of input")]
    UnexpectedEof,
    
    /// Unexpected character
    #[error("Unexpected character: {0}")]
    UnexpectedChar(char),
    
    /// Unexpected token
    #[error("Unexpected token: {0}")]
    UnexpectedToken(String),
    
    /// Expected token but found different
    #[error("Expected {expected}, found {found}")]
    Expected {
        expected: String,
        found: String,
    },
    
    /// Invalid escape sequence
    #[error("Invalid escape sequence: {0}")]
    InvalidEscape(String),
    
    /// Unclosed quoted string
    #[error("Unclosed quoted string")]
    UnclosedQuote,
    
    /// Unclosed parenthesis
    #[error("Unclosed parenthesis")]
    UnclosedParen,
    
    /// Invalid size specification
    #[error("Invalid size specification: {0}")]
    InvalidSize(String),
    
    /// Invalid date specification
    #[error("Invalid date specification: {0}")]
    InvalidDate(String),
    
    /// Invalid property name
    #[error("Invalid property: {0}")]
    InvalidProperty(String),
    
    /// Empty query
    #[error("Empty query")]
    EmptyQuery,
}

impl From<String> for ParseError {
    fn from(s: String) -> Self {
        ParseError::InvalidProperty(s)
    }
}

/// Query evaluation errors.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum EvalError {
    /// Index error
    #[error("Index error: {0}")]
    IndexError(String),
    
    /// Regex compilation error
    #[error("Regex error: {0}")]
    RegexError(String),
    
    /// Unsupported operation
    #[error("Unsupported operation: {0}")]
    Unsupported(String),
}

impl From<regex::Error> for EvalError {
    fn from(e: regex::Error) -> Self {
        EvalError::RegexError(e.to_string())
    }
}

impl From<String> for EvalError {
    fn from(s: String) -> Self {
        EvalError::IndexError(s)
    }
}

/// Main query error type.
#[derive(Debug, Clone, Error)]
pub enum QueryError {
    /// Parse error
    #[error("Parse error: {0}")]
    Parse(#[from] ParseError),
    
    /// Evaluation error
    #[error("Evaluation error: {0}")]
    Eval(#[from] EvalError),
}

impl From<regex::Error> for QueryError {
    fn from(e: regex::Error) -> Self {
        QueryError::Eval(EvalError::RegexError(e.to_string()))
    }
}

impl From<String> for QueryError {
    fn from(s: String) -> Self {
        QueryError::Parse(ParseError::InvalidProperty(s))
    }
}
