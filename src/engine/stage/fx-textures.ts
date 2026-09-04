import * as THREE from 'three/webgpu'

/**
 * 手続き的に生成するエフェクト用テクスチャ。
 *
 * 3D_GamingSystem の fx-editor が使っている組み込みテクスチャを移植したもの。
 * 画像ファイルではなく canvas への描画で作られているため、
 * 素材ファイルを持ち回る必要がなく、解像度も自由に選べる。
 *
 * **乱数を使わない。**`dots` の配置も固定式で決めている。
 * 起動のたびにテクスチャが変わると、書き出しの再現性が崩れる。
 */

export type FxTextureName = 'soft' | 'glow' | 'ring' | 'gradient' | 'stripes' | 'spark' | 'dots'

const cache = new Map<string, THREE.CanvasTexture>()

const draw = (name: FxTextureName, size: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')
  if (g === null) throw new Error('failed to acquire 2d context for fx texture')

  const c = size / 2
  const clear = (): void => {
    g.clearRect(0, 0, size, size)
  }

  switch (name) {
    case 'soft':
    case 'glow': {
      const inner = name === 'glow' ? 0.25 : 0.5
      const grad = g.createRadialGradient(c, c, 0, c, c, c)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(inner, name === 'glow' ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.5)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, size, size)
      break
    }
    case 'ring': {
      const grad = g.createRadialGradient(c, c, 0, c, c, c)
      grad.addColorStop(0, 'rgba(255,255,255,0)')
      grad.addColorStop(0.55, 'rgba(255,255,255,0)')
      grad.addColorStop(0.78, 'rgba(255,255,255,1)')
      grad.addColorStop(0.9, 'rgba(255,255,255,0.4)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, size, size)
      break
    }
    case 'gradient': {
      const grad = g.createLinearGradient(0, 0, 0, size)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, size, size)
      break
    }
    case 'stripes': {
      clear()
      const n = 8
      const band = size / n
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * size
        const grad = g.createLinearGradient(x - band / 2, 0, x + band / 2, 0)
        grad.addColorStop(0, 'rgba(255,255,255,0)')
        grad.addColorStop(0.5, 'rgba(255,255,255,1)')
        grad.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = grad
        g.fillRect(x - band / 2, 0, band, size)
      }
      break
    }
    case 'spark': {
      clear()
      const grad = g.createRadialGradient(c, c, 0, c, c, c * 0.5)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.beginPath()
      g.arc(c, c, c * 0.5, 0, Math.PI * 2)
      g.fill()
      // 十字の光条。これがあると点ではなく火花に見える。
      g.strokeStyle = 'rgba(255,255,255,0.9)'
      g.lineWidth = Math.max(1, size / 85)
      for (let a = 0; a < 4; a++) {
        const angle = (a * Math.PI) / 2
        g.beginPath()
        g.moveTo(c, c)
        g.lineTo(c + Math.cos(angle) * c, c + Math.sin(angle) * c)
        g.stroke()
      }
      break
    }
    case 'dots': {
      clear()
      g.fillStyle = 'rgba(255,255,255,1)'
      // 乱数を使わず固定式で配置する。再現性のため。
      for (let i = 0; i < 40; i++) {
        const x = ((i * 67) % (size - 6)) + 3
        const y = ((i * 113) % (size - 6)) + 3
        const r = (2 + (i % 4)) * (size / 256)
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
      }
      break
    }
  }
  return canvas
}

export const fxTexture = (name: FxTextureName, size = 256): THREE.CanvasTexture => {
  const key = `${name}:${String(size)}`
  const cached = cache.get(key)
  if (cached) return cached

  const texture = new THREE.CanvasTexture(draw(name, size))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  cache.set(key, texture)
  return texture
}

export const disposeFxTextures = (): void => {
  for (const texture of cache.values()) texture.dispose()
  cache.clear()
}
