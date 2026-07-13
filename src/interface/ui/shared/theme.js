// Theme: "paper" (light, default) and "ink" (dark) — same tokens, see styles/tokens.css.
// Shared by desktop and mobile so switching in one stays in sync with the other via
// localStorage.
const THEME_KEY = 'quire-theme';
const themeBtn = document.getElementById('btn-theme');
const themeColorTag = document.getElementById('theme-color-tag');
const THEME_COLORS = { paper: '#fbf6ec', ink: '#26201a' };

function applyTheme(theme) {
	document.documentElement.setAttribute('data-theme', theme);
	themeBtn.textContent = theme === 'ink' ? 'Light' : 'Dark';
	themeColorTag.setAttribute('content', THEME_COLORS[theme]);
}

// Seed: explicit localStorage, then prefers-color-scheme, else default to 'paper'.
const savedTheme = localStorage.getItem(THEME_KEY);
const systemPrefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
const initialTheme = savedTheme || (systemPrefersDark ? 'ink' : 'paper');
applyTheme(initialTheme);

themeBtn.addEventListener('click', () => {
	const next = document.documentElement.getAttribute('data-theme') === 'ink' ? 'paper' : 'ink';
	localStorage.setItem(THEME_KEY, next);
	applyTheme(next);
});
