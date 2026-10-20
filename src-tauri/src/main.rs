#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--tshell-proxy") {
        return tshell_lib::proxy_helper();
    }
    if std::env::var_os("TSHELL_ASKPASS").is_some() {
        return tshell_lib::askpass();
    }
    tshell_lib::run()
}
