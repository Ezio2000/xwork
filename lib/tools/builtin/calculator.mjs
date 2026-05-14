export const calculatorTool = {
  id: 'calculator',
  name: 'calculator',
  title: 'Calculator',
  description: 'Evaluate a mathematical expression safely. Supports + - * / ^ ( ) and functions: sqrt, abs, round, floor, ceil, sin, cos, tan, log, ln, pi, e.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 3000,
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Mathematical expression to evaluate, e.g. "2 + 3 * 4" or "sqrt(144) + 3.14".',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },

  // --- Hooks ---
  validate({ expression }) {
    if (!expression || typeof expression !== 'string') {
      throw new Error('expression is required');
    }
    if (expression.length > 500) {
      throw new Error('Expression too long (max 500 chars)');
    }
  },

  async before({ expression }, { config }) {
    const precision = config.precision ?? 12;
    return { expression, precision };
    // before 的返回值会成为 handler 的 input 参数
  },

  after(input, output) {
    // 保证 result 字段是数值精度处理后的
    if (output && typeof output.result === 'number') {
      const precision = input.precision ?? 12;
      output.result = parseFloat(output.result.toPrecision(precision));
    }
    return output;
  },

  onComplete(outcome) {
    console.log(`[calculator] ${outcome.isError ? '✗' : '✓'} ${outcome.input?.expression} = ${outcome.output?.result ?? outcome.output?.error} (${outcome.durationMs}ms)`);
  },

  // --- Handler (input 经过 before 转换，不再需要重复校验) ---
  async handler(input) {
    const result = parseAndEval(input.expression);
    return { expression: input.expression, result };
  },
};

const funcs = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,
  ln: Math.log,
  pi: () => Math.PI,
  e: () => Math.E,
};

let pos = 0;
let src = '';

function peek() {
  while (pos < src.length && src[pos] === ' ') pos++;
  return pos < src.length ? src[pos] : '\0';
}

function consume() {
  while (pos < src.length && src[pos] === ' ') pos++;
  return pos < src.length ? src[pos++] : '\0';
}

function expect(ch) {
  const c = consume();
  if (c !== ch) throw new Error(`Expected '${ch}' at position ${pos - 1}, got '${c}'`);
}

function parseNumber() {
  let num = '';
  while (/[0-9.]/.test(peek())) num += consume();
  if (!num || num === '.' || (num.match(/\./g) || []).length > 1) throw new Error(`Invalid number at position ${pos}`);
  return parseFloat(num);
}

function parseFactor() {
  const ch = peek();
  if (ch === '(') {
    consume();
    const val = parseExpression();
    expect(')');
    return val;
  }
  if (ch === '-') { consume(); return -parseFactor(); }
  if (/[0-9.]/.test(ch)) return parseNumber();

  let name = '';
  while (/[a-zA-Z]/.test(peek())) name += consume();

  if (!name) throw new Error(`Unexpected character '${ch}' at position ${pos}`);

  if (funcs[name]) {
    if (name === 'pi' || name === 'e') {
      if (peek() === '(') { consume(); expect(')'); }
      return funcs[name]();
    }
    expect('(');
    const val = parseExpression();
    expect(')');
    return funcs[name](val);
  }

  throw new Error(`Unknown function or constant: '${name}'`);
}

function parsePower() {
  let left = parseFactor();
  while (peek() === '^') {
    consume();
    const right = parseFactor();
    left = Math.pow(left, right);
  }
  return left;
}

function parseTerm() {
  let left = parsePower();
  while (peek() === '*' || peek() === '/') {
    const op = consume();
    const right = parsePower();
    if (op === '*') left *= right;
    else {
      if (right === 0) throw new Error('Division by zero');
      left /= right;
    }
  }
  return left;
}

function parseExpression() {
  return parseOneOrMore();
}

let parseOneOrMore = function() {
  let left = parseTerm();
  while (peek() === '+' || peek() === '-') {
    const op = consume();
    const right = parseTerm();
    if (op === '+') left += right;
    else left -= right;
  }
  return left;
};

function parseAndEval(expression) {
  pos = 0;
  src = expression.trim();
  if (!src) return { error: 'Empty expression' };

  try {
    const result = parseExpression();
    if (peek() !== '\0') throw new Error(`Unexpected character '${peek()}' at position ${pos}`);
    // Round to avoid floating point noise
    const rounded = Math.abs(result) < 1e-15 ? 0 : parseFloat(result.toPrecision(12));
    return rounded;
  } catch (err) {
    return { error: err.message };
  }
}
