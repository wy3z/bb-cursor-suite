type MonarchRule = unknown;

interface MonarchLanguage {
  tokenizer?: Record<string, MonarchRule[]>;
  [key: string]: unknown;
}

const SCRIPT_RULES: MonarchRule[] = [
  [/(?:null|undefined|true|false|NaN|Infinity)(?![\w$])/, "constant.language"],
  [/(?:this|super)(?![\w$])/, "variable.special"],
  [
    /(?:string|number|boolean|any|unknown|never|void|object|symbol|bigint)(?![\w$])(?!\s*[:(])/,
    "type.identifier",
  ],
  [
    /#?[a-z_$][\w$]*(?=\s*(?:\?\.)?\s*(?:<[^<>()]*>)?\s*\()/,
    {
      cases: {
        "~^(?:get|set|of|from|as|is|type|declare|readonly|keyof|module|namespace|require)$":
          "function",
        "@keywords": "keyword",
        "@default": "function",
      },
    },
  ],
  [/_*[A-Z][A-Z0-9_]*(?![\w$])/, "constant"],
];

function isRule(rule: MonarchRule): rule is [RegExp | string, unknown] {
  return Array.isArray(rule) && rule.length >= 2;
}

function retagOperators(rule: MonarchRule): MonarchRule {
  if (!isRule(rule)) return rule;
  const [pattern, action] = rule;
  const source = pattern instanceof RegExp ? pattern.source : pattern;
  if (source === "@symbols" && typeof action === "object" && action !== null) {
    const cases = (action as { cases?: Record<string, unknown> }).cases;
    if (cases && cases["@operators"] === "delimiter") {
      return [
        pattern,
        { cases: { ":": "delimiter", ...cases, "@operators": "operator" } },
      ];
    }
  }
  if (source.startsWith("!(?=") && action === "delimiter") {
    return [pattern, "operator"];
  }
  return rule;
}

export function enhanceScriptLanguage(language: MonarchLanguage): MonarchLanguage | null {
  const common = language.tokenizer?.common;
  if (!Array.isArray(common)) return null;
  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      common: [...SCRIPT_RULES, ...common.map(retagOperators)],
    },
  };
}
