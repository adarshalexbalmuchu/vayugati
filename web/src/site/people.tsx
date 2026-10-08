// Original geometric figures in the spirit of tribal wall art: a round head, a torso made of two triangles
// meeting at the waist, thin limbs, and dancing poses. Colour comes from `color` on the <use>.
const LIMB = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const POSES = [
  // arms raised, knees bent
  <>
    <path d="M12 17L4 8M28 17L36 8" {...LIMB} />
    <path d="M16 51L11 58L14 63M24 51L29 58L26 63" {...LIMB} />
  </>,
  // one arm out, one raised with a stick; a kicking leg
  <>
    <path d="M12 17L4 25M28 17L35 10" {...LIMB} />
    <circle cx="36" cy="8" r="2.2" fill="currentColor" />
    <path d="M16 51L15 63M24 51L31 57L29 63" {...LIMB} />
  </>,
  // arms down, striding
  <>
    <path d="M12 17L7 34M28 17L33 34" {...LIMB} />
    <path d="M16 51L12 63M24 51L28 63" {...LIMB} />
  </>,
  // one arm bent forward, one raised
  <>
    <path d="M12 17L5 26L12 29M28 17L35 12" {...LIMB} />
    <path d="M16 51L13 58L16 63M24 51L26 63" {...LIMB} />
  </>,
]

export const POSE_COUNT = POSES.length
export const PERSON_RATIO = 64 / 40

export function PersonSymbols({ prefix }: { prefix: string }) {
  return (
    <>
      {POSES.map((pose, i) => (
        <symbol key={i} id={`${prefix}-${i}`} viewBox="0 0 40 64">
          <circle cx="20" cy="7" r="5.2" fill="currentColor" />
          <polygon points="10,15 30,15 20,31" fill="currentColor" />
          <polygon points="20,31 9,51 31,51" fill="currentColor" />
          {pose}
        </symbol>
      ))}
    </>
  )
}
