/**
 * IPC 境界を越えてくる生の値。
 *
 * 本来ここは `unknown` が自然だが、プロジェクト規約で禁止されている。
 * かつ `any` で受けるのは論外なので、構造化クローンで運べる範囲を
 * 閉じた再帰型として定義する。
 *
 * P0-16 で zod を導入した後は、この型で受けてから `safeParse` に渡し、
 * `z.output<S>` の具体型へ変換する (設計書 §6.2)。
 */
export type RawValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly RawValue[]
  | { readonly [key: string]: RawValue }
