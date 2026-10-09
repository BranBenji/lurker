// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Evaluator for the arithmetic expressions in a desktopPet animations.xml:
// `+ - * / %`, parentheses, unary minus, integer and decimal literals, the
// screen/pet identifiers below, and `Convert(expr, System.Int32)`.
//
// The original evaluates these with .NET's DataTable.Compute, where Int32
// arithmetic stays integer (truncating division) and anything touching a
// decimal literal promotes to double. Pet authors lean on that: `random/5+10`
// is a whole number of repeats, `imageX-imageW*0.9` is a fraction. The Mac
// port's Expression.swift reproduces it with a tagged number; so does this.

export interface ExpressionContext {
  screenW: number;
  screenH: number;
  areaW: number;
  /** Bottom edge of the working area, relative to the screen top. */
  areaH: number;
  imageW: number;
  imageH: number;
  /** Parent position — only meaningful for child pets, -1 otherwise. */
  imageX: number;
  imageY: number;
  /** 0…99, drawn once per evaluation. */
  random: number;
  /** 10…89, fixed for the life of the pet. */
  randS: number;
  scale: number;
  parentFlipped: boolean;
}

export function emptyContext(): ExpressionContext {
  return {
    screenW: 0,
    screenH: 0,
    areaW: 0,
    areaH: 0,
    imageW: 0,
    imageH: 0,
    imageX: -1,
    imageY: -1,
    random: 0,
    randS: 0,
    scale: 1,
    parentFlipped: false,
  };
}

/** True if the text contains anything that changes at runtime. */
export function isDynamic(text: string): boolean {
  return (
    text.includes('random') ||
    text.includes('randS') ||
    text.includes('imageX') ||
    text.includes('imageY')
  );
}

/** True if the text depends on the screen. */
export function isScreen(text: string): boolean {
  return text.includes('screen') || text.includes('area');
}

// A tagged number: `int` keeps Int32 semantics, `double` is IEEE.
type Num = { int: true; v: number } | { int: false; v: number };

const INT_LIMIT = 2 ** 31;
const wrap32 = (n: number): number => {
  // Mirror Int32 overflow (`&+` in the Swift port) — pet files never reach
  // it, but a faithful port shouldn't produce a different number if one did.
  const m = n % 2 ** 32;
  const u = m < 0 ? m + 2 ** 32 : m;
  return u >= INT_LIMIT ? u - 2 ** 32 : u;
};

function toInt(n: Num): number {
  if (n.int) return n.v;
  if (!Number.isFinite(n.v)) return 0;
  return Math.trunc(n.v);
}

function binary(op: string, a: Num, b: Num): Num {
  if (a.int && b.int) {
    const x = a.v;
    const y = b.v;
    switch (op) {
      case '+':
        return { int: true, v: wrap32(x + y) };
      case '-':
        return { int: true, v: wrap32(x - y) };
      case '*':
        return { int: true, v: wrap32(x * y) };
      case '/':
        return { int: true, v: y === 0 ? 0 : Math.trunc(x / y) };
      case '%':
        return { int: true, v: y === 0 ? 0 : x % y };
      default:
        return { int: true, v: 0 };
    }
  }
  const x = a.v;
  const y = b.v;
  switch (op) {
    case '+':
      return { int: false, v: x + y };
    case '-':
      return { int: false, v: x - y };
    case '*':
      return { int: false, v: x * y };
    case '/':
      return { int: false, v: y === 0 ? 0 : x / y };
    case '%':
      return { int: false, v: y === 0 ? 0 : x % y };
    default:
      return { int: false, v: 0 };
  }
}

type Token =
  | { kind: 'num'; value: Num }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

const isDigit = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => /[A-Za-z_]/.test(c);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && i + 1 < text.length && isDigit(text[i + 1]))) {
      let s = '';
      let isDouble = false;
      while (i < text.length && (isDigit(text[i]) || text[i] === '.')) {
        if (text[i] === '.') isDouble = true;
        s += text[i];
        i++;
      }
      const v = Number(s);
      tokens.push({
        kind: 'num',
        value: isDouble
          ? { int: false, v: Number.isFinite(v) ? v : 0 }
          : { int: true, v: Number.isFinite(v) ? v : 0 },
      });
      continue;
    }
    if (isLetter(c)) {
      let s = '';
      while (i < text.length && (isLetter(text[i]) || isDigit(text[i]) || text[i] === '.')) {
        s += text[i];
        i++;
      }
      tokens.push({ kind: 'ident', name: s });
      continue;
    }
    switch (c) {
      case '(':
        tokens.push({ kind: 'lparen' });
        break;
      case ')':
        tokens.push({ kind: 'rparen' });
        break;
      case ',':
        tokens.push({ kind: 'comma' });
        break;
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
        tokens.push({ kind: 'op', op: c });
        break;
      default:
        break; // anything unknown is ignored, as upstream
    }
    i++;
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly ctx: ExpressionContext,
  ) {}

  private get current(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): void {
    this.pos++;
  }

  private isOp(t: Token | undefined, ops: string): t is { kind: 'op'; op: string } {
    return !!t && t.kind === 'op' && ops.includes(t.op);
  }

  parseExpression(): Num {
    let lhs = this.parseTerm();
    while (this.isOp(this.current, '+-')) {
      const op = this.current.op;
      this.advance();
      lhs = binary(op, lhs, this.parseTerm());
    }
    return lhs;
  }

  private parseTerm(): Num {
    let lhs = this.parseUnary();
    while (this.isOp(this.current, '*/%')) {
      const op = this.current.op;
      this.advance();
      lhs = binary(op, lhs, this.parseUnary());
    }
    return lhs;
  }

  private parseUnary(): Num {
    const t = this.current;
    if (this.isOp(t, '-')) {
      this.advance();
      return binary('-', { int: true, v: 0 }, this.parseUnary());
    }
    if (this.isOp(t, '+')) {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Num {
    const t = this.current;
    if (!t) return { int: true, v: 0 };
    switch (t.kind) {
      case 'num':
        this.advance();
        return t.value;
      case 'lparen': {
        this.advance();
        const v = this.parseExpression();
        if (this.current?.kind === 'rparen') this.advance();
        return v;
      }
      case 'ident': {
        this.advance();
        if (t.name.toLowerCase() === 'convert') {
          // Convert(expr, System.Int32) → truncate to int.
          if (this.current?.kind === 'lparen') this.advance();
          const v = this.parseExpression();
          if (this.current?.kind === 'comma') this.advance();
          if (this.current?.kind === 'ident') this.advance();
          if (this.current?.kind === 'rparen') this.advance();
          return { int: true, v: toInt(v) };
        }
        return { int: true, v: this.lookup(t.name) };
      }
      default:
        this.advance();
        return { int: true, v: 0 };
    }
  }

  private lookup(name: string): number {
    const c = this.ctx;
    switch (name) {
      case 'screenW':
        return c.screenW;
      case 'screenH':
        return c.screenH;
      case 'areaW':
        return c.areaW;
      case 'areaH':
        return c.areaH;
      case 'imageW':
        return c.imageW;
      case 'imageH':
        return c.imageH;
      case 'imageX':
        return c.imageX;
      case 'imageY':
        return c.imageY;
      case 'random':
        return c.random;
      case 'randS':
        return c.randS;
      case 'scale':
        return c.scale;
      default:
        return 0;
    }
  }
}

export function evaluate(source: string, ctx: ExpressionContext): number {
  let text = source.trim();
  if (!text) return 0;
  if (/^-?\d+$/.test(text)) return Number(text);

  // A child placed relative to a flipped parent mirrors imageW (the original's
  // string-replace trick, kept verbatim so pet files behave the same).
  if (ctx.parentFlipped) {
    text = text.includes('-imageW')
      ? text.replaceAll('-imageW', '+imageW')
      : text.replaceAll('imageW', '(-imageW)');
  }

  return toInt(new Parser(tokenize(text), ctx).parseExpression());
}
