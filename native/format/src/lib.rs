//! SplashTank's file formats, shared with the web page: scene files (.json) and bake caches (.splc).

pub mod cache;
pub mod scene;

pub use cache::{Box3, Cache, CacheWriter, FrameOut};
pub use scene::Scene;

#[cfg(test)]
mod tests;
