// A tiny, safe formula evaluator for custom quantity columns (waste factors,
// rates, conversions). No eval: numbers, the variables passed in, + - * / %,
// parentheses and unary minus, tokenized and run through shunting-yard.

export type FormulaVars = Record<string, number>;

interface Token {
  kind: 'num' | 'id' | 'op' | 'lparen' | 'rparen';
  text: string;
  num?: number;
}

const PRECEDENCE: Record<string, number> = { u: 4, '%': 3, '*': 3, '/': 3, '+': 2, '-': 2 };

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const s = src.replace(/\s+/g, '');
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      const m = s.slice(i).match(/^\d+(\.\d+)?/);
      if (!m) return null;
      tokens.push({ kind: 'num', text: m[0], num: parseFloat(m[0]) });
      i += m[0].length;
    } else if (/[a-zA-Z_]/.test(c)) {
      const m = s.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      if (!m) return null;
      tokens.push({ kind: 'id', text: m[0] });
      i += m[0].length;
    } else if ('+-*/%'.includes(c)) {
      tokens.push({ kind: 'op', text: c });
      i++;
    } else if (c === '(') {
      tokens.push({ kind: 'lparen', text: c });
      i++;
    } else if (c === ')') {
      tokens.push({ kind: 'rparen', text: c });
      i++;
    } else {
      return null; // unknown character
    }
  }
  return tokens;
}

/** Evaluate a formula string against variables; null on any syntax/arity/name error. */
export function evaluateFormula(formula: string, vars: FormulaVars): number | null {
  const tokens = tokenize(formula);
  if (!tokens || tokens.length === 0) return null;
  const output: Token[] = [];
  const ops: Token[] = [];
  let prev: Token | null = null;
  for (const tok of tokens) {
    if (tok.kind === 'num' || tok.kind === 'id') {
      output.push(tok);
    } else if (tok.kind === 'op') {
      // unary minus/plus: at start, after an op, or after '('
      const unary = (tok.text === '-' || tok.text === '+') && (!prev || prev.kind === 'op' || prev.kind === 'lparen');
      const key = unary && tok.text === '-' ? 'u' : tok.text;
      while (
        ops.length &&
        ops[ops.length - 1].kind === 'op' &&
        PRECEDENCE[ops[ops.length - 1].text] >= PRECEDENCE[key] &&
        key !== 'u'
      ) {
        output.push(ops.pop()!);
      }
      ops.push({ kind: 'op', text: key });
    } else if (tok.kind === 'lparen') {
      ops.push(tok);
    } else {
      // rparen
      while (ops.length && ops[ops.length - 1].kind !== 'lparen') output.push(ops.pop()!);
      if (!ops.length) return null; // unbalanced
      ops.pop(); // the lparen
    }
    prev = tok;
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op.kind === 'lparen') return null;
    output.push(op);
  }

  // evaluate the RPN
  const stack: number[] = [];
  for (const tok of output) {
    if (tok.kind === 'num') stack.push(tok.num!);
    else if (tok.kind === 'id') {
      const v = vars[tok.text];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      stack.push(v);
    } else if (tok.text === 'u') {
      const a = stack.pop();
      if (a === undefined) return null;
      stack.push(-a);
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return null;
      switch (tok.text) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': if (b === 0) return null; stack.push(a / b); break;
        case '%': if (b === 0) return null; stack.push(a % b); break;
        default: return null;
      }
    }
  }
  const result = stack.pop();
  if (result === undefined || stack.length !== 0 || !Number.isFinite(result)) return null;
  return result;
}

/** True when a formula parses and evaluates against dummy-but-finite vars. */
export function formulaUsesOnlyVars(formula: string, allowed: string[]): boolean {
  const tokens = tokenize(formula);
  if (!tokens) return false;
  for (const t of tokens) {
    if (t.kind === 'id' && !allowed.includes(t.text)) return false;
  }
  return evaluateFormula(formula, Object.fromEntries(allowed.map((v) => [v, 1]))) !== null;
}
