//! The app's logic that needs no window (unit-tested on its own); main.rs wires it to Tauri.
pub mod merge;
pub mod placement;
pub mod queue;
pub mod settings;
pub mod desktop;
pub mod terminal;
pub mod winshell;
pub mod diagnostics;
pub mod models;
pub mod updates;
