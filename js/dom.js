// Tiny DOM helpers shared by host and player views.

// h('button.btn.accent', { onclick, disabled: true, style: { '--team': c } }, 'GO', child, [more])
export function h(spec, attrs = {}, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
    } else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// Replace root's content with the given nodes.
export function mount(root, ...nodes) {
  clear(root);
  append(root, nodes);
  return root;
}

let toastTimer;
export function toast(text, { ms = 2600 } = {}) {
  let el = qs('.toast');
  if (!el) document.body.append((el = h('div.toast', { role: 'status', 'aria-live': 'polite' })));
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export const wordmark = () => h('span.wordmark', 'FINDMYGUESSR', h('span.dot', '.'));

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
