import { useEffect, useState, type JSX } from 'react'
import type { ShowParams, Vec3 } from '@shared/protocol/show-params'
import { Section, Slider, Toggle } from './controls'
import type { EngineLink } from './engine-link'

/**
 * 配置の編集パネル。
 *
 * エフェクトの発生位置は乱数ではなく、拍のハッシュから決まる。
 * ただし「決定的」と「制御できる」は別なので、
 * 中心位置と広がりをここで指定できるようにする。
 *
 * 細かい位置合わせは Output ウィンドウのギズモで行う。
 * Control 側のプレビューは転送された画像なのでドラッグできない。
 */

export type EditorTargetName = 'lasers' | 'lightning' | 'bursts' | 'performer'

const TARGET_LABELS: Record<EditorTargetName, string> = {
  lasers: 'レーザー',
  lightning: '電撃',
  bursts: '爆発・火花',
  performer: '被写体',
}

const VecFields = ({
  value,
  onChange,
  range = 14,
  showY = true,
}: {
  value: Vec3
  onChange: (next: Partial<Vec3>) => void
  range?: number
  showY?: boolean
}): JSX.Element => (
  <>
    <Slider
      name="X (左右)"
      value={value.x}
      min={-range}
      max={range}
      step={0.1}
      onChange={(x) => {
        onChange({ x })
      }}
    />
    {showY && (
      <Slider
        name="Y (高さ)"
        value={value.y}
        min={-2}
        max={16}
        step={0.1}
        onChange={(y) => {
          onChange({ y })
        }}
      />
    )}
    <Slider
      name="Z (奥行き)"
      value={value.z}
      min={-range}
      max={range}
      step={0.1}
      onChange={(z) => {
        onChange({ z })
      }}
    />
  </>
)

export const EditorPanel = ({
  link,
  params,
}: {
  link: EngineLink
  params: ShowParams
}): JSX.Element => {
  const [enabled, setEnabled] = useState(false)
  const [target, setTarget] = useState<EditorTargetName>('lasers')

  useEffect(
    () =>
      link.onEditorState((state) => {
        setEnabled(state.enabled)
        setTarget(state.target)
      }),
    [link],
  )

  return (
    <Section title="配置の編集">
      <Toggle
        name="Output でカメラ操作・ギズモ"
        value={enabled}
        onChange={(v) => {
          link.editorEnabled(v)
        }}
      />
      <p style={hint}>
        ON にすると Output ウィンドウで
        <strong>ドラッグ=カメラ回転 / ホイール=ズーム / 矢印=位置移動</strong>。 カメラは free
        モードになり、ショットの自動切替は止まる。
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', margin: '0.4rem 0' }}>
        {(Object.keys(TARGET_LABELS) as EditorTargetName[]).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              link.editorTarget(name)
            }}
            style={targetButton(target === name)}
          >
            {TARGET_LABELS[name]}
          </button>
        ))}
      </div>

      {target === 'lasers' && (
        <>
          <VecFields
            value={params.lasers.origin}
            onChange={(next) => {
              link.setParams({ lasers: { origin: { ...params.lasers.origin, ...next } } })
            }}
          />
          <Slider
            name="円の半径"
            value={params.lasers.radius}
            min={1}
            max={16}
            step={0.1}
            onChange={(radius) => {
              link.setParams({ lasers: { radius } })
            }}
          />
        </>
      )}

      {target === 'lightning' && (
        <>
          <VecFields
            value={params.lightning.origin}
            onChange={(next) => {
              link.setParams({ lightning: { origin: { ...params.lightning.origin, ...next } } })
            }}
          />
          <Slider
            name="ばらつき幅"
            value={params.lightning.spread}
            min={0}
            max={24}
            step={0.5}
            onChange={(spread) => {
              link.setParams({ lightning: { spread } })
            }}
          />
        </>
      )}

      {target === 'bursts' && (
        <>
          <VecFields
            value={params.bursts.origin}
            onChange={(next) => {
              link.setParams({ bursts: { origin: { ...params.bursts.origin, ...next } } })
            }}
          />
          <Slider
            name="ばらつき幅"
            value={params.bursts.spread}
            min={0}
            max={20}
            step={0.5}
            onChange={(spread) => {
              link.setParams({ bursts: { spread } })
            }}
          />
        </>
      )}

      {target === 'performer' && (
        <VecFields
          value={{ x: params.performer.x, y: 0, z: params.performer.z }}
          showY={false}
          range={8}
          onChange={(next) => {
            link.setParams({ performer: { ...next } })
          }}
        />
      )}

      <div style={{ borderTop: '1px solid #23232f', marginTop: '0.5rem', paddingTop: '0.45rem' }}>
        <div style={{ fontSize: '0.7rem', color: '#8a90a6', marginBottom: '0.3rem' }}>
          カメラ ({params.camera.mode})
        </div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {(['auto', 'manual', 'free'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                link.setParams({ camera: { mode } })
              }}
              style={targetButton(params.camera.mode === mode)}
            >
              {mode === 'auto' ? '自動巡回' : mode === 'manual' ? 'ショット固定' : '手動'}
            </button>
          ))}
        </div>
        {params.camera.mode === 'free' && (
          <Slider
            name="画角 (FOV)"
            value={params.camera.fov}
            min={18}
            max={90}
            step={1}
            onChange={(fov) => {
              link.setParams({ camera: { fov } })
            }}
          />
        )}
      </div>
    </Section>
  )
}

const hint: React.CSSProperties = {
  fontSize: '0.63rem',
  color: '#6f7690',
  margin: '0.15rem 0 0',
  lineHeight: 1.5,
}

const targetButton = (active: boolean): React.CSSProperties => ({
  flex: 1,
  background: active ? '#2f3d63' : '#1a1f2e',
  color: active ? '#dfe6ff' : '#8a90a6',
  border: '1px solid #2c3550',
  borderRadius: 4,
  padding: '0.2rem 0.35rem',
  fontSize: '0.64rem',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})
