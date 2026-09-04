import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

/**
 * CLAUDE.md の「プログラミングルール」を機械的に強制するための定義。
 *
 * 規約を文章として持っているだけでは、実装が進むにつれて必ず破られる。
 * lint で落ちるようにしておけば、規約は自動的に守られる。
 */

/** `unknown` の使用禁止。外部入力は zod の境界で具体型へ変換すること (設計書 §6.2)。 */
const NO_UNKNOWN = {
  selector: 'TSUnknownKeyword',
  message:
    '`unknown` はプロジェクト規約で禁止です。外部入力は zod の safeParse を境界に置き、z.output<S> で具体型に変換してください (設計書 §6.2)。',
}

/** `class` の使用禁止。状態はファクトリ関数 + クロージャで保持すること (設計書 §10.1)。 */
const NO_CLASS = [
  {
    selector: 'ClassDeclaration',
    message:
      '`class` はプロジェクト規約で禁止です。ファクトリ関数がクロージャで状態を閉じ込め、メソッドを持つオブジェクトを返す形にしてください (設計書 §10.1)。例外は src/shared/errors.ts の AppError のみ。',
  },
  {
    selector: 'ClassExpression',
    message: '`class` はプロジェクト規約で禁止です (設計書 §10.1)。',
  },
]

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.testdata/**',
      '.tmp/**',
      '.claude/**',
      'resources/**',
      // 計測ハーネス。製品コードではなく、意図的に素の JS で書いている
      'poc/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', '*.cjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error', NO_UNKNOWN, ...NO_CLASS],

      // 非同期の取りこぼしは、この種のアプリでは症状が出るまで気づきにくい
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // 型のみの import を明示させる (verbatimModuleSyntax と対で効く)
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /**
   * 唯一の class 例外。
   * AppError は instanceof による判定が必要なため Error を継承する
   * (CLAUDE.md が明示的に認めている例外に該当する)。
   * なお `unknown` の禁止はこのファイルでも維持する。
   */
  {
    files: ['src/shared/errors.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_UNKNOWN],
    },
  },

  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // scripts/ の計測ハーネスは素の Node スクリプトなのでグローバルを与える
      globals: { ...globals.node },
    },
    rules: {
      // .cjs は定義上 CommonJS なので require は正しい書き方。
      // sandbox 化されたレンダラの preload は CJS でなければならない (Electron の制約)。
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  prettierConfig,
)
