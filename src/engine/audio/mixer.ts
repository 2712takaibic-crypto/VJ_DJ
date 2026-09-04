import { createDeck, type Deck, type DeckState } from './deck'

/**
 * 2 デッキのミキサー。
 *
 * クロスフェーダーのカーブを 2 種持つ。
 *   smooth: 中央で両方が -3dB。長く混ぜる用途向け
 *   sharp:  中央付近で急峻に切り替わる。カットイン用途向け
 *
 * ヘッドホンキューは対象外 (要件 F-D3)。手持ちの出力が 2ch のみのため、
 * 次の曲の頭出しは波形とビートグリッドの表示で行う。
 */

export type CrossfaderCurve = 'smooth' | 'sharp'

export type MixerState = {
  readonly deckA: DeckState
  readonly deckB: DeckState
  readonly crossfader: number
  readonly curve: CrossfaderCurve
  readonly masterGain: number
}

export type Mixer = {
  readonly deckA: Deck
  readonly deckB: Deck
  /** 0 = A のみ / 0.5 = 中央 / 1 = B のみ */
  setCrossfader(value: number): void
  setCurve(curve: CrossfaderCurve): void
  getState(masterGain: number): MixerState
  dispose(): void
}

/** クロスフェーダーの位置から両デッキのゲインを求める */
const faderGains = (position: number, curve: CrossfaderCurve): readonly [number, number] => {
  const x = Math.max(0, Math.min(1, position))
  if (curve === 'sharp') {
    // 中央付近で一気に切り替わる。カットイン向け。
    const a = Math.max(0, Math.min(1, (0.55 - x) * 8))
    const b = Math.max(0, Math.min(1, (x - 0.45) * 8))
    return [a, b]
  }
  // 等パワー。中央で両方 -3dB になり、混ぜても音量が落ちない。
  return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)]
}

export const createMixer = (context: AudioContext, master: GainNode): Mixer => {
  const deckA = createDeck('A', context)
  const deckB = createDeck('B', context)

  const faderA = context.createGain()
  const faderB = context.createGain()
  deckA.output.connect(faderA)
  deckB.output.connect(faderB)
  faderA.connect(master)
  faderB.connect(master)

  let crossfader = 0.5
  let curve: CrossfaderCurve = 'smooth'

  const applyFader = (): void => {
    const [a, b] = faderGains(crossfader, curve)
    faderA.gain.setTargetAtTime(a, context.currentTime, 0.01)
    faderB.gain.setTargetAtTime(b, context.currentTime, 0.01)
  }
  applyFader()

  return {
    deckA,
    deckB,

    setCrossfader: (value) => {
      crossfader = Math.max(0, Math.min(1, value))
      applyFader()
    },

    setCurve: (next) => {
      curve = next
      applyFader()
    },

    getState: (masterGain) => ({
      deckA: deckA.getState(),
      deckB: deckB.getState(),
      crossfader,
      curve,
      masterGain,
    }),

    dispose: () => {
      deckA.dispose()
      deckB.dispose()
      faderA.disconnect()
      faderB.disconnect()
    },
  }
}
