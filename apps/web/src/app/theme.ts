/** Shows the page dark when the system is set to dark, and switches along with it. */
export const followSystemTheme = () => {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", dark.matches);
  apply();
  dark.addEventListener("change", apply);
};
