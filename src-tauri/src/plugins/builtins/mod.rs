mod editors;
mod theme_manager;
mod themes;

pub(crate) use editors::{builtin_codemirror_editor_provider, builtin_plain_editor_provider};
pub(crate) use theme_manager::builtin_theme_manager;
pub(crate) use themes::{
    builtin_catppuccin_latte, builtin_dark, builtin_dracula, builtin_gruvbox_light, builtin_light,
    builtin_midnight, builtin_monokai, builtin_monokai_pro, builtin_nordic,
    builtin_solarized_light, builtin_synthwave, builtin_tokyo_light,
};
