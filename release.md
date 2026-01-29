# Release Notes - Zync v1.5.4 (Linux & Update Polish)

We've completely redesigned the Settings experience to be smoother, faster, and more accessible.

This release polishes the cross-platform experience, specifically fixing desktop integration on Linux and refining the update flow for macOS.

## ✨ Highlights

## 🐧 Linux Improvements
*   **Fixed App & Window Icons**: Resolved an issue where the app icon was missing from the taskbar and Alt-Tab switcher (AppImage).
*   **Better Desktop Integration**: The installation script now correctly registers the app and updates the system icon cache.

## 🍎 macOS Updates
*   **Manual Update Flow**: To comply with macOS security requirements (Gatekeeper), the app now guides you to download updates manually from GitHub instead of failing silently.

## 🔄 Update System
*   **Smarter Auto-Downloads**: "Auto Download" setting is now strictly respected. macOS defaults to manual download.
*   **Update Badge**: Added a pulsing notification badge on the Settings icon when an update is available.


### 🎨 Visual & UX Overhaul
*   **Compact Design**: The Settings modal is now a cleaner, more focused 700x500px window.
*   **Smooth Transitions**: Experience butter-smooth 150ms fade animations when switching between tabs.
*   **Visual Polish**: Added subtle section dividers, refined typography, and "glassmorphic" touches.
*   **Enhanced Interactivity**: All inputs, sliders, and dropdowns now have clear hover effects and accessible focus rings.

### ⌨️ Keyboard Navigation
Navigate settings without leaving your keyboard:
*   **Arrow Keys (`←`/`→`)**: Cycle through settings tabs.
*   **Escape (`Esc`)**: Instantly close the modal.
*   **Visual Keybindings**: Keyboard shortcuts are now displayed with beautiful, realistic keycap visuals.

### 🔔 New Features
*   **Toast Notifications**: A new, non-intrusive notification system for app feedback.
*   **Integrated Update Manager**: The "About" tab now features a streamlined update check experience. Seamlessly check for, download, and install Zync updates directly within the polished settings interface.
*   **Search (Experimental)**: _Note: A global search bar was prototyped but removed in this release to maintain our core minimal design philosophy._

## 🛠️ Under the Hood
*   **Type Safety**: Full TypeScript verification passed for robust stability.
*   **Performance**: Optimized render cycles for modal interactions.
*   **Clean Code**: Refactored [SettingsModal.tsx](cci:7://file:///home/gajendra/work/personal/projects/zync/src/renderer/components/settings/SettingsModal.tsx:0:0-0:0) to remove legacy unused code and imports.

---

*Enjoy the new Zync experience!* 🚀