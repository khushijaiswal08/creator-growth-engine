/** What each person picks under their name. "device" follows the phone's or computer's own light/dark setting. */
export type ThemeChoice = "light" | "dark" | "device";

/** Where the choice is kept: this browser's storage, so each person and each device can differ. */
export const THEME_KEY = "theme";

/**
 * Runs in <head> before the page paints, so a dark page never flashes white. Plain text on purpose: the
 * server layout puts it inline, and it must not depend on any bundle. Light for anyone who never chose,
 * which also keeps the creators' gift and upload pages light.
 */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem("${THEME_KEY}");var d=c==="dark"||(c==="device"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";}catch(e){document.documentElement.dataset.theme="light";}})();`;
