const ZERO_DECIMAL_CURRENCIES = new Set([
  "jpy",
  "krw",
  "vnd",
  "gnf",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "xaf",
  "xof",
])

export function toMinorAmount(amount: number, currencyCode: string): number {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currencyCode.toLowerCase())
    ? 0
    : 2
  return Math.round(amount * Math.pow(10, decimals))
}

export function fromMinorAmount(
  minorAmount: number,
  currencyCode: string
): number {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currencyCode.toLowerCase())
    ? 0
    : 2
  return minorAmount / Math.pow(10, decimals)
}
