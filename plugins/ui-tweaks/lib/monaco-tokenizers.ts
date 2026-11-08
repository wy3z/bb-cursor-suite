import { MONACO_CSS_LANGUAGE } from "./monaco-css-language.js";
import { enhanceScriptLanguage } from "./monaco-script-language.js";

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

const LANGUAGE_IDS = ["css", "typescript", "javascript"] as const;
type LanguageId = (typeof LANGUAGE_IDS)[number];

const EDITOR_STYLESHEET_SUFFIX = "/editor.css";

interface TokenizerState {
  enabled: boolean;
  monaco: MonacoLanguagesApi | null;
  loading: Promise<MonacoLanguagesApi | null> | null;
  observer: MutationObserver | null;
  hooks: Disposable[];
  applied: Set<LanguageId>;
  generation: number;
}

const state: TokenizerState = {
  enabled: false,
  monaco: null,
  loading: null,
  observer: null,
  hooks: [],
  applied: new Set(),
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

async function loadBuiltIn(
  monaco: MonacoLanguagesApi,
  id: LanguageId,
): Promise<unknown> {
  try {
    const entry = monaco.languages
      .getLanguages()
      .find((language) => language.id === id);
    const module = await entry?.loader?.();
    return module?.language ?? null;
  } catch {
    return null;
  }
}

async function enhancedLanguage(
  monaco: MonacoLanguagesApi,
  id: LanguageId,
): Promise<unknown> {
  if (id === "css") {
    await loadBuiltIn(monaco, id);
    return MONACO_CSS_LANGUAGE;
  }
  const builtIn = await loadBuiltIn(monaco, id);
  if (typeof builtIn !== "object" || builtIn === null) return null;
  return enhanceScriptLanguage(builtIn as Record<string, unknown>);
}

async function applyEnhanced(
  monaco: MonacoLanguagesApi,
  id: LanguageId,
  generation: number,
) {
  const language = await enhancedLanguage(monaco, id);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  if (!language || !state.enabled || generation !== state.generation) return;
  monaco.languages.setMonarchTokensProvider(id, language);
  state.applied.add(id);
}

async function restoreBuiltIn(monaco: MonacoLanguagesApi, id: LanguageId) {
  const language = await loadBuiltIn(monaco, id);
  if (state.enabled || !language) return;
  monaco.languages.setMonarchTokensProvider(id, language);
}

function attach(monaco: MonacoLanguagesApi) {
  state.monaco = monaco;
  if (!state.enabled) return;
  for (const hook of state.hooks) hook.dispose();
  state.hooks = LANGUAGE_IDS.map((id) =>
    monaco.languages.onLanguage(id, () => {
      void applyEnhanced(monaco, id, state.generation);
    }),
  );
  for (const id of LANGUAGE_IDS) {
    void applyEnhanced(monaco, id, state.generation);
  }
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

export function setMonacoEnhancedTokenizers(enabled: boolean) {
  if (enabled === state.enabled) return;
  state.enabled = enabled;
  state.generation += 1;
  if (enabled) {
    startWatching();
    return;
  }
  state.observer?.disconnect();
  state.observer = null;
  for (const hook of state.hooks) hook.dispose();
  state.hooks = [];
  const monaco = state.monaco;
  if (!monaco) return;
  for (const id of state.applied) void restoreBuiltIn(monaco, id);
  state.applied.clear();
}
