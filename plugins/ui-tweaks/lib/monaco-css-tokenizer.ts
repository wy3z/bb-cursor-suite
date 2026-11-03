interface Disposable {
  dispose(): void;
}

interface MonacoLanguageEntry {
  id: string;
  loader?: () => Promise<{ language?: unknown }>;
}

export interface MonacoLanguagesApi {
  languages: {
    getLanguages(): MonacoLanguageEntry[];
    setMonarchTokensProvider(languageId: string, language: unknown): Disposable;
    onLanguage(languageId: string, callback: () => void): Disposable;
  };
}

const IDENTIFIER =
  "-?-?(?:[a-zA-Z_]|(?:\\\\(?:(?:[0-9a-fA-F]{1,6}\\s?)|[^[0-9a-fA-F])))(?:[\\w\\-]|(?:\\\\(?:(?:[0-9a-fA-F]{1,6}\\s?)|[^[0-9a-fA-F])))*";

export const MONACO_CSS_LANGUAGE = {
  defaultToken: "",
  tokenPostfix: ".css",
  ws: "[ \\t\\n\\r\\f]*",
  identifier: IDENTIFIER,
  brackets: [
    { open: "{", close: "}", token: "delimiter.bracket" },
    { open: "[", close: "]", token: "delimiter.bracket" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      { include: "@atrules" },
      { include: "@selector" },
      ["{", { token: "delimiter.bracket", next: "@block" }],
      ["}", "delimiter.bracket"],
    ],
    block: [
      { include: "@comments" },
      { include: "@atrules" },
      [
        "(--@identifier)(@ws)(:)",
        ["variable", "", { token: "delimiter", next: "@value" }],
      ],
      [
        "([*_]?@identifier)(@ws)(:)(?=(?:\\s|\\d|$|[^{;}]*[;}]))",
        ["attribute.name", "", { token: "delimiter", next: "@value" }],
      ],
      { include: "@selector" },
      ["{", { token: "delimiter.bracket", next: "@push" }],
      ["}", { token: "delimiter.bracket", next: "@pop" }],
      [";", "delimiter"],
    ],
    atrules: [
      { include: "@comments" },
      [
        "[@](media|supports|container|layer|scope|document|-moz-document)\\b",
        { token: "keyword", next: "@prelude" },
      ],
      [
        "[@](-webkit-|-moz-|-o-)?keyframes\\b",
        { token: "keyword", next: "@keyframesname" },
      ],
      ["[@](font-face|page|property|counter-style|font-feature-values)\\b", "keyword"],
      ["[@][\\w-]+", { token: "keyword", next: "@prelude" }],
    ],
    prelude: [
      { include: "@comments" },
      { include: "@strings" },
      ["\\b(and|or|not|only)\\b", "keyword"],
      ["(@identifier)(@ws)(:)", ["attribute.name", "", "delimiter"]],
      ["url(?=\\()", { token: "function", next: "@url" }],
      ["@identifier(?=\\()", "function"],
      { include: "@numbers" },
      ["@identifier", "attribute.value.keyword"],
      ["[()]", "delimiter.parenthesis"],
      ["[,/]", "delimiter"],
      [">=|<=|[<>=]", "operator"],
      [";", { token: "delimiter", next: "@pop" }],
      ["{", { token: "delimiter.bracket", switchTo: "@block" }],
    ],
    keyframesname: [
      { include: "@comments" },
      ["@identifier", "attribute.value.keyword"],
      ["{", { token: "delimiter.bracket", switchTo: "@block" }],
    ],
    selector: [
      { include: "@comments" },
      { include: "@strings" },
      ["\\[", { token: "delimiter.bracket", next: "@attribute" }],
      ["::?@identifier", "selector.pseudo"],
      ["\\.@identifier", "selector.class"],
      ["#@identifier", "selector.id"],
      ["\\d+(\\.\\d+)?%", "attribute.value.number"],
      ["@identifier", "tag"],
      ["[*&]", "tag"],
      ["[>~+]|\\|\\|", "operator"],
      ["[()]", "delimiter.parenthesis"],
      [",", "delimiter"],
    ],
    attribute: [
      { include: "@comments" },
      { include: "@strings" },
      ["[~|^$*]?=", "operator"],
      ["\\b[iIsS](?=\\s*\\])", "keyword"],
      ["@identifier", "attribute.name.selector"],
      ["\\]", { token: "delimiter.bracket", next: "@pop" }],
    ],
    value: [
      { include: "@comments" },
      { include: "@strings" },
      ["!\\s*important\\b", "keyword"],
      ["url(?=\\()", { token: "function", next: "@url" }],
      ["--@identifier", "variable"],
      ["@identifier(?=\\()", "function"],
      { include: "@numbers" },
      ["@identifier", "attribute.value.keyword"],
      ["[()]", "delimiter.parenthesis"],
      ["[,/]", "delimiter"],
      ["[+*]|-(?=\\s)", "operator"],
      [";", { token: "delimiter", next: "@pop" }],
      ["(?=})", { token: "", next: "@pop" }],
    ],
    url: [
      ["\\(", "delimiter.parenthesis"],
      { include: "@strings" },
      ["[^)\\r\\n]+", "string"],
      ["\\)", { token: "delimiter.parenthesis", next: "@pop" }],
    ],
    numbers: [
      [
        "[-+]?(\\d*\\.)?\\d+([eE][\\-+]?\\d+)?",
        { token: "attribute.value.number", next: "@units" },
      ],
      ["#[0-9a-fA-F]+(?![\\w-])", "attribute.value.hex"],
    ],
    units: [
      [
        "(%|[a-zA-Z]+)?",
        { token: "attribute.value.unit", next: "@pop" },
      ],
    ],
    comments: [["\\/\\*", { token: "comment", next: "@comment" }]],
    comment: [
      ["\\*\\/", { token: "comment", next: "@pop" }],
      ["[^*/]+", "comment"],
      [".", "comment"],
    ],
    strings: [
      ['"', { token: "string", next: "@stringdouble" }],
      ["'", { token: "string", next: "@stringsingle" }],
    ],
    stringdouble: [
      ["\\\\.", "string.escape"],
      ['"', { token: "string", next: "@pop" }],
      ['[^\\\\"]+', "string"],
    ],
    stringsingle: [
      ["\\\\.", "string.escape"],
      ["'", { token: "string", next: "@pop" }],
      ["[^\\\\']+", "string"],
    ],
  },
};

const EDITOR_STYLESHEET_SUFFIX = "/editor.css";

interface TokenizerState {
  enabled: boolean;
  monaco: MonacoLanguagesApi | null;
  loading: Promise<MonacoLanguagesApi | null> | null;
  observer: MutationObserver | null;
  languageHook: Disposable | null;
  applied: boolean;
  generation: number;
}

const state: TokenizerState = {
  enabled: false,
  monaco: null,
  loading: null,
  observer: null,
  languageHook: null,
  applied: false,
  generation: 0,
};

export function findMonacoBaseUrl(doc: Document = document): string | null {
  const links = Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  );
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const href = links[index]!.href;
    if (href.endsWith(EDITOR_STYLESHEET_SUFFIX)) {
      return href.slice(0, -EDITOR_STYLESHEET_SUFFIX.length);
    }
  }
  return null;
}

async function loadMonaco(baseUrl: string): Promise<MonacoLanguagesApi | null> {
  try {
    const module = (await import(`${baseUrl}/editor.js`)) as {
      monaco?: MonacoLanguagesApi;
    };
    return module.monaco ?? null;
  } catch {
    return null;
  }
}

function cssEntry(monaco: MonacoLanguagesApi) {
  return monaco.languages.getLanguages().find((entry) => entry.id === "css");
}

async function settleBuiltInCss(monaco: MonacoLanguagesApi) {
  try {
    await cssEntry(monaco)?.loader?.();
  } catch {
    return;
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function applyEnhanced(monaco: MonacoLanguagesApi, generation: number) {
  await settleBuiltInCss(monaco);
  if (!state.enabled || generation !== state.generation) return;
  monaco.languages.setMonarchTokensProvider("css", MONACO_CSS_LANGUAGE);
  state.applied = true;
}

async function restoreBuiltIn(monaco: MonacoLanguagesApi) {
  try {
    const builtIn = await cssEntry(monaco)?.loader?.();
    if (state.enabled || !builtIn?.language) return;
    monaco.languages.setMonarchTokensProvider("css", builtIn.language);
  } catch {
    return;
  }
}

function attach(monaco: MonacoLanguagesApi) {
  state.monaco = monaco;
  if (!state.enabled) return;
  const generation = state.generation;
  state.languageHook?.dispose();
  state.languageHook = monaco.languages.onLanguage("css", () => {
    void applyEnhanced(monaco, state.generation);
  });
  void applyEnhanced(monaco, generation);
}

function startWatching() {
  if (state.monaco) {
    attach(state.monaco);
    return;
  }
  if (state.loading || state.observer) return;
  const tryLoad = () => {
    const baseUrl = findMonacoBaseUrl();
    if (!baseUrl || state.loading) return;
    state.observer?.disconnect();
    state.observer = null;
    state.loading = loadMonaco(baseUrl).then((monaco) => {
      state.loading = null;
      if (monaco) attach(monaco);
      return monaco;
    });
  };
  tryLoad();
  if (state.loading) return;
  state.observer = new MutationObserver(tryLoad);
  state.observer.observe(document.head, { childList: true });
}

export function setMonacoCssTokenizer(enabled: boolean) {
  if (enabled === state.enabled) return;
  state.enabled = enabled;
  state.generation += 1;
  if (enabled) {
    startWatching();
    return;
  }
  state.observer?.disconnect();
  state.observer = null;
  state.languageHook?.dispose();
  state.languageHook = null;
  if (state.monaco && state.applied) {
    state.applied = false;
    void restoreBuiltIn(state.monaco);
  }
}
