// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // On Windows release builds, allocate and immediately hide a console.
    // This is necessary for portable-pty/ConPTY to work without spawning
    // visible console windows for each PTY session.
    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    {
        use std::ptr::null_mut;
        
        #[link(name = "kernel32")]
        extern "system" {
            fn AllocConsole() -> i32;
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        
        #[link(name = "user32")]
        extern "system" {
            fn ShowWindow(hwnd: *mut std::ffi::c_void, n_cmd_show: i32) -> i32;
        }
        
        const SW_HIDE: i32 = 0;
        
        unsafe {
            // Allocate a console for this process
            AllocConsole();
            
            // Get the console window handle and hide it
            let console_hwnd = GetConsoleWindow();
            if console_hwnd != null_mut() {
                ShowWindow(console_hwnd, SW_HIDE);
            }
        }
    }
    
    tauri_app_lib::run()
}
