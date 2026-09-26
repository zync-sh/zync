mod dark;
mod extra;
mod light;

pub(crate) use dark::{
    builtin_dark, builtin_dracula, builtin_midnight, builtin_monokai, builtin_monokai_pro,
};
pub(crate) use extra::{builtin_nordic, builtin_synthwave};
pub(crate) use light::{
    builtin_catppuccin_latte, builtin_gruvbox_light, builtin_light, builtin_solarized_light,
    builtin_tokyo_light,
};
