#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--pixiu-shell-proxy") {
        return pixiu_shell_lib::proxy_helper();
    }
    if std::env::var_os("PIXIU_SHELL_ASKPASS").is_some() {
        return pixiu_shell_lib::askpass();
    }
    pixiu_shell_lib::run()
}
