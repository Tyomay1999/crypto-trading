type Exact = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x === 0n ? 1n : x;
}

function normalize(numerator: bigint, denominator: bigint): Exact {
  if (denominator === 0n) throw new RangeError("zero denominator");
  const sign = denominator < 0n ? -1n : 1n;
  const n = numerator * sign;
  const d = denominator * sign;
  const divisor = gcd(n, d);
  return Object.freeze({
    numerator: n / divisor,
    denominator: d / divisor,
  });
}

export function parseReportDecimal(value: string): Exact {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new TypeError("invalid canonical report decimal");
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator =
    BigInt(whole) * denominator +
    BigInt(fraction.length === 0 ? "0" : fraction);

  return normalize(negative ? -numerator : numerator, denominator);
}

export function addReportExact(left: Exact, right: Exact): Exact {
  return normalize(
    left.numerator * right.denominator +
      right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function divideReportExact(left: Exact, divisor: bigint): Exact {
  if (divisor === 0n) throw new RangeError("division by zero");
  return normalize(left.numerator, left.denominator * divisor);
}

export function compareReportExact(left: Exact, right: Exact): number {
  const l = left.numerator * right.denominator;
  const r = right.numerator * left.denominator;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function formatReportExact(
  value: Exact,
  maximumFractionDigits = 12,
): string {
  const negative = value.numerator < 0n;
  const n = abs(value.numerator);
  const whole = n / value.denominator;
  let remainder = n % value.denominator;

  if (remainder === 0n) {
    return `${negative ? "-" : ""}${whole}`;
  }

  let fraction = "";
  for (
    let index = 0;
    index < maximumFractionDigits && remainder !== 0n;
    index += 1
  ) {
    remainder *= 10n;
    fraction += (remainder / value.denominator).toString();
    remainder %= value.denominator;
  }

  fraction = fraction.replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${
    fraction.length === 0 ? "" : `.${fraction}`
  }`;
}

export function zeroReportExact(): Exact {
  return normalize(0n, 1n);
}
