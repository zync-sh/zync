/**
 * AgentIcon — custom SVG icon used for all AI agent message bubbles.
 * Two orbital rings + a filled center node. Unique, small-size-friendly.
 */

interface AgentIconProps {
  size?: number;
  className?: string;
}

export function AgentIcon({ size = 12, className }: AgentIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* First orbital ring */}
      <ellipse
        cx="8"
        cy="8"
        rx="6.5"
        ry="2.8"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      {/* Second orbital ring, rotated 65° */}
      <ellipse
        cx="8"
        cy="8"
        rx="6.5"
        ry="2.8"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        transform="rotate(65 8 8)"
      />
      {/* Center nucleus */}
      <circle cx="8" cy="8" r="1.9" fill="currentColor" />
    </svg>
  );
}
