// Theme: follows the system until toggled; the choice sticks per device.
// Listen for the 'fmg-theme' window event to restyle maps etc.

export function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('fmg-theme', next); } catch (e) {}
  window.dispatchEvent(new CustomEvent('fmg-theme', { detail: next }));
  return next;
}
