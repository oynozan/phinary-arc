import { motion } from 'framer-motion'
import { gravatarUrl } from '@/lib/gravatar'

const UP = '#97CB3D'
const DOWN = '#F44708'
const RING = '#0C1B35'

/** HTML avatar for headers and lists. Requests 3x the pixels so it stays crisp on retina screens. */
export function BettorAvatar({ address, size = 28 }: { address: string; size?: number }) {
  return (
    <img
      src={gravatarUrl(address, size * 3)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="rounded-full bg-raised object-cover"
    />
  )
}

interface ChartAvatarProps {
  cx?: number
  cy?: number
  id: string
  address: string
  isUp: boolean
  label: string
  mine?: boolean
  /** extra pixels above the default lift, used to stack bets placed close together */
  stack?: number
}

/** SVG avatar pinned to the price line. A solid ring marks the side. Springs in when a new bet lands. */
export function ChartAvatar({ cx, cy, id, address, isUp, label, mine, stack = 0 }: ChartAvatarProps) {
  if (cx === undefined || cy === undefined || Number.isNaN(cx) || Number.isNaN(cy)) return null
  const r = mine ? 11 : 9
  const ay = cy - 14 - r - stack
  const color = isUp ? UP : DOWN
  const clipId = `avatar-${id.replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <motion.g
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 20 }}
      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clipId}>
          <circle cx={cx} cy={ay} r={r} />
        </clipPath>
      </defs>
      <line x1={cx} y1={cy} x2={cx} y2={ay + r + 2} stroke={color} strokeWidth={1.5} strokeOpacity={0.7} />
      <circle cx={cx} cy={cy} r={2.5} fill={color} />
      <circle cx={cx} cy={ay} r={r + 3} fill={RING} />
      <circle cx={cx} cy={ay} r={r + 1.5} fill={color} />
      <image
        href={gravatarUrl(address, r * 2 * 4)}
        x={cx - r}
        y={ay - r}
        width={r * 2}
        height={r * 2}
        clipPath={`url(#${clipId})`}
        preserveAspectRatio="xMidYMid slice"
      />
    </motion.g>
  )
}
