// Puts the git commit the program was built from into it (SPLASH_COMMIT, with "+" when there were changes not yet committed), so the
// window title says which build is running, like the testing page's label.
fn main() {
    let git = |args: &[&str]| std::process::Command::new("git").args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let commit = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain", "--untracked-files=no", "--", "."]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=SPLASH_COMMIT={commit}{}", if dirty { "+" } else { "" });
    // rebuild when the commit changes
    if let Some(dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        println!("cargo:rerun-if-changed={dir}/index");
    }
    println!("cargo:rerun-if-changed=src");
}
