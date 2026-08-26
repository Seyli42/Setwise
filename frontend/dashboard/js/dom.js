// Helpers DOM.
//
// Règle non négociable de ce fichier : AUCUNE fonction n'écrit dans
// `innerHTML`. Le dashboard affiche des messages rédigés par des inconnus (les
// leads viennent d'une publicité Instagram) ; tout passe par `textContent`, qui
// ne peut pas exécuter de balise.

/**
 * Crée un élément. `text` passe par `textContent` — jamais interprété comme HTML.
 */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);

  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.value !== undefined) node.value = options.value;
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.href) node.href = options.href;
  // `rel` est forcé sur les liens ouverts dans un nouvel onglet : sans
  // `noopener`, la page cible garde une référence vers celle du dashboard.
  if (options.target) {
    node.target = options.target;
    node.rel = options.rel ?? "noopener noreferrer";
  } else if (options.rel) {
    node.rel = options.rel;
  }
  if (options.disabled) node.disabled = true;
  if (options.rows) node.rows = options.rows;
  if (options.title) node.title = options.title;

  for (const [key, value] of Object.entries(options.data ?? {})) {
    node.dataset[key] = String(value);
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(event, handler);
  }

  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }

  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

// ============================================================
// Formatage
// ============================================================

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const DATE_LONG = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short" });

export function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : DATE_TIME.format(date);
}

export function formatLong(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : DATE_LONG.format(date);
}

export function formatRelative(iso) {
  if (!iso) return "—";
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  if (diffMin < 60 * 24) return `il y a ${Math.round(diffMin / 60)} h`;
  return `il y a ${Math.round(diffMin / 1440)} j`;
}

// ============================================================
// Blocs réutilisables
// ============================================================

export function badge(label, tone = "neutral") {
  return el("span", { class: `badge badge--${tone}`, text: label });
}

export function card(title, ...children) {
  return el("section", { class: "card" }, [
    title ? el("h2", { class: "card__title", text: title }) : null,
    ...children,
  ]);
}

export function field(label, control, hint) {
  return el("label", { class: "field" }, [
    el("span", { class: "field__label", text: label }),
    control,
    hint ? el("span", { class: "field__hint", text: hint }) : null,
  ]);
}

/**
 * Case à cocher avec un libellé qui peut contenir des liens — d'où `children`
 * plutôt qu'un simple texte. La case est retournée à part pour que l'appelant
 * lise `.checked` sans avoir à fouiller le DOM.
 */
export function checkbox(...children) {
  const input = el("input", { type: "checkbox" });
  const label = el("label", { class: "check" }, [
    input,
    el("span", { class: "check__label" }, children),
  ]);
  return { input, label };
}

export function empty(message) {
  return el("p", { class: "empty", text: message });
}

export function errorBox(message) {
  return el("p", { class: "alert alert--error", text: message });
}

export function successBox(message) {
  return el("p", { class: "alert alert--ok", text: message });
}

/** Table simple. `rows` est un tableau de tableaux de nœuds ou de chaînes. */
export function table(headers, rows) {
  return el("div", { class: "table-wrap" }, [
    el("table", { class: "table" }, [
      el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { text: h })))]),
      el(
        "tbody",
        {},
        rows.map((cells) =>
          el("tr", {}, cells.map((cell) => el("td", {}, typeof cell === "string" ? [cell] : [cell])))
        ),
      ),
    ]),
  ]);
}

/**
 * Bouton dont le libellé bascule pendant l'action asynchrone, et qui se
 * réactive même en cas d'erreur — sinon un échec réseau laisse un bouton mort.
 */
export function asyncButton(label, handler, options = {}) {
  const button = el("button", {
    class: options.class ?? "btn",
    type: "button",
    text: label,
    on: {
      async click() {
        button.disabled = true;
        const previous = button.textContent;
        button.textContent = options.busyLabel ?? "…";
        try {
          await handler();
        } finally {
          button.disabled = false;
          button.textContent = previous;
        }
      },
    },
  });
  return button;
}
