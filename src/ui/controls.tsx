import type { JSX, ReactNode } from 'react'

/**
 * パラメータ操作の共通部品。
 *
 * 数値スライダは「値が見えること」が重要。
 * 見えないと「今どこにいるか」が分からず、詰められない。
 */

const label: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '0.72rem',
  color: '#9aa0b4',
  marginBottom: '0.1rem',
}

export const Slider = ({
  name,
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  name: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}): JSX.Element => (
  <div style={{ marginBottom: '0.5rem' }}>
    <div style={label}>
      <span>{name}</span>
      <span style={{ color: '#d8dcea', fontVariantNumeric: 'tabular-nums' }}>
        {value.toFixed(step >= 1 ? 0 : 2)}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => {
        onChange(Number(event.target.value))
      }}
      style={{ width: '100%', accentColor: '#5aa0ff' }}
    />
  </div>
)

export const Toggle = ({
  name,
  value,
  onChange,
}: {
  name: string
  value: boolean
  onChange: (value: boolean) => void
}): JSX.Element => (
  <label
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.45rem',
      fontSize: '0.75rem',
      color: '#c7cbdb',
      marginBottom: '0.45rem',
      cursor: 'pointer',
    }}
  >
    <input
      type="checkbox"
      checked={value}
      onChange={(event) => {
        onChange(event.target.checked)
      }}
      style={{ accentColor: '#5aa0ff' }}
    />
    {name}
  </label>
)

export const Section = ({
  title,
  children,
}: {
  title: string
  children: ReactNode
}): JSX.Element => (
  <section
    style={{
      background: '#16161f',
      border: '1px solid #23232f',
      borderRadius: 6,
      padding: '0.6rem 0.7rem',
      marginBottom: '0.6rem',
    }}
  >
    <h2
      style={{
        margin: '0 0 0.5rem',
        fontSize: '0.72rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: '#6f7690',
      }}
    >
      {title}
    </h2>
    {children}
  </section>
)
